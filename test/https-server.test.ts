import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createRequestHandlerContext,
  ConcurrentQuota,
  PreAuthAdmissionLimiter,
  RequestRateLimiter,
  startHttpsServer,
  validateTlsCertificate,
  type ProtocolInfoDocument,
  type RunningServer,
} from "../src/https-server.js";
import { clientPrincipal, droneSessionPrincipal } from "../src/principal.js";
import { createDebugLogger, disabledDebugLogger } from "../src/debug-log.js";

const protocolInfo: ProtocolInfoDocument = {
  protocol_version: "1",
  package: {
    name: "borgmcp-shared",
    version: "0.2.0-draft",
  },
  capabilities: ["transport.tls", "authority.no-cloud-fallback"],
  limits: {
    max_request_bytes: 1_024,
    max_log_message_bytes: 10_240,
    max_read_page_size: 500,
    max_replay_page_size: 200,
  },
};

interface TestResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

describe("HTTPS service", () => {
  let certificate: string;
  let key: string;
  let server: RunningServer;
  let coordinationCalls = 0;

  beforeAll(async () => {
    const material = await generate([{ name: "commonName", value: "localhost" }], {
      algorithm: "sha256",
      keyType: "ec",
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      ],
    });
    certificate = material.cert;
    key = material.private;
    server = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async (authorization) => authorization === "Bearer accepted-test-token",
      authorizeCoordination: async (authorization) => authorization === "Bearer accepted-test-token"
        ? clientPrincipal("00000000-0000-4000-8000-000000000200")
        : authorization === undefined ? "missing" : "invalid",
      exchangeEnrollment: async (body) => {
        if (body === undefined) {
          return {
            status: 400,
            body: {
              protocol_version: "1",
              error: { code: "INVALID_INPUT", message: "Invalid enrollment request." },
            },
          };
        }
        if ((body as { denied?: boolean }).denied === true) {
          return {
            status: 401,
            body: {
              protocol_version: "1",
              request_id: "request-1234",
              error: { code: "AUTH_INVALID", message: "Enrollment authentication failed." },
            },
          };
        }
        return {
          status: 201,
          body: { protocol_version: "1", request_id: "request-1234", payload: { ok: true } },
        };
      },
      handleCoordination: async () => {
        coordinationCalls += 1;
        return { status: 200, body: { protocol_version: "1", request_id: "unexpected" } };
      },
      limits: {
        maxConnections: 4,
        maxConnectionsPerAddress: 4,
        maxRequestsPerWindow: 100,
        maxRequestsPerAddressWindow: 200,
        maxRequestsGlobalWindow: 1_000,
        rateLimitWindowMs: 60_000,
        maxRateLimitEntries: 16,
        maxStreamsPerCredential: 4,
        maxHeaderBytes: 8_192,
        maxRequestBodyBytes: 1_024,
        maxRequestsPerSocket: 10,
        requestTimeoutMs: 2_000,
        tlsHandshakeTimeoutMs: 1_000,
        headersTimeoutMs: 1_000,
        keepAliveTimeoutMs: 500,
        handlerTimeoutMs: 250,
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves data-free liveness without identifying headers", async () => {
    const response = await request(server.origin, certificate, "/healthz");

    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["server"]).toBeUndefined();
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("returns canonical 401 errors for missing and invalid protocol authorization", async () => {
    const missing = await request(server.origin, certificate, "/api/protocol");
    const invalid = await request(server.origin, certificate, "/api/protocol", {
      authorization: "Bearer invalid-test-token",
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(JSON.parse(missing.body).error.code).toBe("AUTH_MISSING");
    expect(JSON.parse(invalid.body).error.code).toBe("AUTH_INVALID");
  });

  it("does not log secret-bearing authentication or enrollment failures", async () => {
    const sinks = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
    ];
    const secret = "secret-material-that-must-never-reach-runtime-logs";
    try {
      const authentication = await request(server.origin, certificate, "/api/protocol", {
        authorization: `Bearer ${secret}`,
      });
      const enrollment = await request(
        server.origin,
        certificate,
        "/api/enrollment/exchange",
        { "content-type": "application/json" },
        JSON.stringify({ denied: true, invitation: secret }),
        "POST",
      );

      expect(authentication.status).toBe(401);
      expect(enrollment.status).toBe(401);
      expect(authentication.body).not.toContain(secret);
      expect(enrollment.body).not.toContain(secret);
      for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
    } finally {
      for (const sink of sinks) sink.mockRestore();
    }
  });

  it("emits normalized opt-in request diagnostics without URLs or authorization values", async () => {
    const lines: string[] = [];
    const debugServer = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async (authorization) => authorization === "Bearer accepted-debug-token"
        ? true
        : authorization === undefined ? "missing" : "invalid",
      debugLogger: createDebugLogger((line) => lines.push(line)),
    });
    const urlSecret = "secret-url-component";
    const bearerSecret = "secret-bearer-component";
    try {
      await request(debugServer.origin, certificate, `/api/${urlSecret}`, {
        authorization: `Bearer ${bearerSecret}`,
      });
      await request(debugServer.origin, certificate, "/api/protocol", {
        authorization: "Bearer accepted-debug-token",
      });
    } finally {
      await debugServer.close();
    }

    const output = lines.join("\n");
    expect(output).not.toContain(urlSecret);
    expect(output).not.toContain(bearerSecret);
    expect(lines.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "request", route: "unknown", method: "GET", status: 404 }),
      expect.objectContaining({
        event: "request",
        route: "protocol",
        authentication: "accepted",
        authorization: "accepted",
        status: 200,
      }),
    ]));
  });

  it("returns protocol readiness and capabilities only after authorization", async () => {
    const response = await request(server.origin, certificate, "/api/protocol", {
      authorization: "Bearer accepted-test-token",
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      protocol_version: "1",
      request_id: "protocol-info",
      payload: protocolInfo,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects browser-origin requests without CORS disclosure", async () => {
    const response = await request(server.origin, certificate, "/api/protocol", {
      authorization: "Bearer accepted-test-token",
      origin: "https://attacker.invalid",
    });

    expect(response).toMatchObject({ status: 403, body: "" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each([
    ["/healthz", "GET"],
    ["/api/enrollment/exchange", "POST"],
    ["/api/cubes", "GET"],
    ["/api/cubes/00000000-0000-4000-8000-000000000001/stream", "GET"],
  ])("rejects browser origins before the %s route", async (path, method) => {
    const response = await request(server.origin, certificate, path, {
      authorization: "Bearer accepted-test-token",
      origin: "https://attacker.invalid",
    }, "", method);

    expect(response).toMatchObject({ status: 403, body: "" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects oversized request bodies before routing", async () => {
    const response = await request(
      server.origin,
      certificate,
      "/api/protocol",
      { authorization: "Bearer accepted-test-token" },
      "x".repeat(1_025),
      "POST",
    );

    expect(response).toMatchObject({ status: 413, body: "" });
  });

  it("fails closed when coordination routes lack principal authentication", async () => {
    await expect(startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async () => true,
      handleCoordination: async () => ({ status: 204 }),
    })).rejects.toThrow("Coordination routes require server-derived principal authentication.");
  });

  it("serves invitation-authorized enrollment through the bounded JSON route", async () => {
    const response = await request(
      server.origin,
      certificate,
      "/api/enrollment/exchange",
      { "content-type": "application/json" },
      JSON.stringify({ protocol_version: "1", request_id: "request-1234", payload: {} }),
      "POST",
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toEqual({
      protocol_version: "1",
      request_id: "request-1234",
      payload: { ok: true },
    });
  });

  it("returns the protocol error envelope for malformed enrollment JSON", async () => {
    const response = await request(
      server.origin,
      certificate,
      "/api/enrollment/exchange",
      { "content-type": "application/json" },
      "{",
      "POST",
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      protocol_version: "1",
      error: { code: "INVALID_INPUT", message: "Invalid enrollment request." },
    });
  });

  it("returns the protocol error envelope for rejected enrollment authentication", async () => {
    const response = await request(
      server.origin,
      certificate,
      "/api/enrollment/exchange",
      { "content-type": "application/json" },
      JSON.stringify({ denied: true }),
      "POST",
    );

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      protocol_version: "1",
      request_id: "request-1234",
      error: { code: "AUTH_INVALID", message: "Enrollment authentication failed." },
    });
  });

  it.each([
    "?cursor=first&cursor=second",
    "?cursor=first&unknown=value",
    "?unknown=value",
  ])("rejects ambiguous stream queries before invoking the handler: %s", async (query) => {
    coordinationCalls = 0;
    const response = await request(
      server.origin,
      certificate,
      `/api/cubes/00000000-0000-4000-8000-000000000001/stream${query}`,
      { authorization: "Bearer accepted-test-token" },
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_INPUT");
    expect(coordinationCalls).toBe(0);
  });

  it("rejects oversized request headers at the parser boundary", async () => {
    const response = await request(server.origin, certificate, "/healthz", {
      "x-oversized": "x".repeat(9_000),
    });

    expect(response.status).toBe(400);
  });

  it("requires the configured TLS trust anchor", async () => {
    await expect(request(server.origin, undefined, "/healthz")).rejects.toThrow();
  });

  it("applies the configured connection and timeout bounds", () => {
    expect(server.limits).toEqual({
      maxConnections: 4,
      maxConnectionsPerAddress: 4,
      maxRequestsPerWindow: 100,
      maxRequestsPerAddressWindow: 200,
      maxRequestsGlobalWindow: 1_000,
      rateLimitWindowMs: 60_000,
      maxRateLimitEntries: 16,
      maxStreamsPerCredential: 4,
      maxHeaderBytes: 8_192,
      maxRequestBodyBytes: 1_024,
      maxRequestsPerSocket: 10,
      requestTimeoutMs: 2_000,
      tlsHandshakeTimeoutMs: 1_000,
      headersTimeoutMs: 1_000,
      keepAliveTimeoutMs: 500,
      handlerTimeoutMs: 250,
    });
  });

  it("aborts a stalled authorizer and releases the connection within the handler deadline", async () => {
    let authorizationSignal: AbortSignal | undefined;
    const stalled = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async (_authorization, signal) => {
        authorizationSignal = signal;
        return new Promise<boolean>(() => undefined);
      },
      limits: {
        maxConnections: 1,
        maxConnectionsPerAddress: 1,
        maxRequestsPerWindow: 10,
        maxRequestsPerAddressWindow: 20,
        maxRequestsGlobalWindow: 100,
        rateLimitWindowMs: 60_000,
        maxRateLimitEntries: 4,
        maxStreamsPerCredential: 1,
        maxHeaderBytes: 8_192,
        maxRequestBodyBytes: 8,
        maxRequestsPerSocket: 2,
        requestTimeoutMs: 200,
        tlsHandshakeTimeoutMs: 100,
        headersTimeoutMs: 100,
        keepAliveTimeoutMs: 50,
        handlerTimeoutMs: 30,
      },
    });

    try {
      const startedAt = Date.now();
      const response = await request(stalled.origin, certificate, "/api/protocol", {
        authorization: "Bearer stalled-test-token",
      });

      expect(response).toMatchObject({ status: 503, body: "" });
      expect(response.headers.connection).toBe("close");
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(authorizationSignal?.aborted).toBe(true);
    } finally {
      await stalled.close();
    }
  });

  it("destroys incomplete TLS handshakes and releases connection capacity", async () => {
    const bounded = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async () => true,
      limits: {
        ...server.limits,
        maxConnections: 1,
        maxConnectionsPerAddress: 1,
        maxStreamsPerCredential: 1,
        tlsHandshakeTimeoutMs: 30,
      },
    });
    try {
      for (const partial of [undefined, Buffer.from([0x16, 0x03])]) {
        const socket = await openRawSocket(bounded.origin);
        if (partial !== undefined) socket.write(partial);
        await expect(waitForSocketClose(socket, 500)).resolves.toBeUndefined();
        expect((await request(bounded.origin, certificate, "/healthz")).status).toBe(204);
      }
    } finally {
      await bounded.close();
    }
  });

  it("constructs a route context without retaining TLS material", async () => {
    const authorizeProtocol = async (): Promise<boolean> => false;
    const context = createRequestHandlerContext({
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol,
    });

    expect(context).toEqual({ protocolInfo, authorizeProtocol, debugLogger: disabledDebugLogger });
    expect("tls" in context).toBe(false);
  });

  it("refuses a certificate that does not cover the bind address", async () => {
    await expectCertificateRejected(
      await certificateMaterial({ ip: "127.0.0.2" }),
      "TLS certificate does not cover the bind address.",
    );
  });

  it("refuses expired and not-yet-valid certificates", async () => {
    const now = Date.now();
    await expectCertificateRejected(
      await certificateMaterial({
        notBeforeDate: new Date(now - 172_800_000),
        notAfterDate: new Date(now - 86_400_000),
      }),
      "TLS certificate is outside its validity period.",
    );
    await expectCertificateRejected(
      await certificateMaterial({
        notBeforeDate: new Date(now + 86_400_000),
        notAfterDate: new Date(now + 172_800_000),
      }),
      "TLS certificate is outside its validity period.",
    );
  });

  it("refuses CA certificates and leaf certificates without server-auth EKU", async () => {
    await expectCertificateRejected(
      await certificateMaterial({ ca: true }),
      "TLS certificate must be a non-CA leaf certificate.",
    );
    await expectCertificateRejected(
      await certificateMaterial({ serverAuth: false }),
      "TLS certificate does not permit server authentication.",
    );
  });

  it("requires a verified CA chain for private-LAN certificates", async () => {
    const trusted = await signedCertificateMaterial("192.168.1.20");
    const untrusted = await signedCertificateMaterial("192.168.1.20");

    expect(() => validateTlsCertificate(
      trusted.server.cert,
      "192.168.1.20",
      "lan",
      trusted.ca.cert,
    )).not.toThrow();
    expect(() => validateTlsCertificate(
      trusted.server.cert,
      "192.168.1.20",
      "lan",
    )).toThrow("A private LAN bind requires an explicit TLS trust anchor.");
    expect(() => validateTlsCertificate(
      trusted.server.cert,
      "192.168.1.20",
      "lan",
      untrusted.ca.cert,
    )).toThrow("TLS certificate is not signed by the configured trust anchor.");
  });

  it("validates a private-LAN leaf through a bounded intermediate chain", async () => {
    const root = await generate([{ name: "commonName", value: "root-ca" }], {
      algorithm: "sha256",
      keyType: "ec",
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 1, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    });
    const intermediate = await generate([{ name: "commonName", value: "intermediate-ca" }], {
      algorithm: "sha256",
      keyType: "ec",
      ca: { key: root.private, cert: root.cert },
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    });
    const leaf = await generate([{ name: "commonName", value: "lan-server" }], {
      algorithm: "sha256",
      keyType: "ec",
      ca: { key: intermediate.private, cert: intermediate.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "192.168.1.21" }] },
      ],
    });

    expect(() => validateTlsCertificate(
      `${leaf.cert}\n${intermediate.cert}`,
      "192.168.1.21",
      "lan",
      root.cert,
    )).not.toThrow();
    expect(() => validateTlsCertificate(
      leaf.cert,
      "192.168.1.21",
      "lan",
      root.cert,
    )).toThrow("TLS certificate is not signed by the configured trust anchor.");
  });

  it("rejects an intermediate beneath a root with pathLenConstraint zero", async () => {
    const root = await generate([{ name: "commonName", value: "constrained-root" }], {
      algorithm: "sha256",
      keyType: "ec",
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    });
    const intermediate = await generate([{ name: "commonName", value: "forbidden-intermediate" }], {
      algorithm: "sha256",
      keyType: "ec",
      ca: { key: root.private, cert: root.cert },
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    });
    const leaf = await generate([{ name: "commonName", value: "lan-server" }], {
      algorithm: "sha256",
      keyType: "ec",
      ca: { key: intermediate.private, cert: intermediate.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "192.168.1.22" }] },
      ],
    });

    expect(() => validateTlsCertificate(
      `${leaf.cert}\n${intermediate.cert}`,
      "192.168.1.22",
      "lan",
      root.cert,
    )).toThrow("TLS certificate chain exceeds a CA path-length constraint.");
  });

  it("enforces bounded rate-limit bursts, recovery, and identity capacity", () => {
    let now = 0;
    const limiter = new RequestRateLimiter({
      ...server.limits,
      maxRequestsPerWindow: 2,
      rateLimitWindowMs: 2_000,
      maxRateLimitEntries: 1,
    }, 2, () => now);

    expect(limiter.consume("127.0.0.1")).toBeNull();
    expect(limiter.consume("127.0.0.1")).toBeNull();
    expect(limiter.consume("127.0.0.1")).toBe(2);
    expect(limiter.consume("127.0.0.2")).toBe(2);
    now = 2_001;
    expect(limiter.consume("127.0.0.2")).toBeNull();
  });

  it("does not debit global admission for address-rejected attacker traffic", () => {
    const limiter = new PreAuthAdmissionLimiter({
      ...server.limits,
      maxRequestsPerAddressWindow: 2,
      maxRequestsGlobalWindow: 4,
    }, () => 0);

    expect(limiter.consume("address:attacker")).toBeNull();
    expect(limiter.consume("address:attacker")).toBeNull();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiter.consume("address:attacker")).toBe(60);
    }
    expect(limiter.consume("address:fresh")).toBeNull();
    expect(limiter.consume("address:fresh")).toBeNull();
    expect(limiter.consume("address:third")).toBe(60);
  });

  it("preserves global admission for fresh source addresses through the HTTPS handler", async () => {
    let connection = 0;
    const limited = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async () => true,
      testHooks: {
        identifyRemoteAddress: () => {
          connection += 1;
          if (connection <= 22) return "attacker";
          if (connection <= 24) return "fresh";
          return "third";
        },
      },
      limits: {
        ...server.limits,
        maxRequestsPerWindow: 2,
        maxRequestsPerAddressWindow: 2,
        maxRequestsGlobalWindow: 4,
      },
    });
    try {
      expect((await request(limited.origin, certificate, "/healthz")).status)
        .toBe(204);
      expect((await request(limited.origin, certificate, "/healthz")).status)
        .toBe(204);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const rejected = await request(
          limited.origin,
          certificate,
          "/healthz",
        );
        expect(rejected.status).toBe(429);
        expect(rejected.headers["retry-after"]).toBe("60");
      }
      expect((await request(limited.origin, certificate, "/healthz")).status)
        .toBe(204);
      expect((await request(limited.origin, certificate, "/healthz")).status)
        .toBe(204);
      expect((await request(limited.origin, certificate, "/healthz")).status)
        .toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("rolls back reservations and admits exactly the synchronous global boundary", () => {
    const limits = {
      ...server.limits,
      maxRequestsPerAddressWindow: 10,
      maxRequestsGlobalWindow: 4,
    };
    const reservationLimiter = new RequestRateLimiter(limits, 2, () => 0);
    const rolledBack = reservationLimiter.reserve("address:victim");
    rolledBack.rollback();
    expect(reservationLimiter.consume("address:victim")).toBeNull();
    expect(reservationLimiter.consume("address:victim")).toBeNull();
    expect(reservationLimiter.consume("address:victim")).toBe(60);

    const admission = new PreAuthAdmissionLimiter(limits, () => 0);
    const outcomes = Array.from({ length: 20 }, (_, index) =>
      admission.consume(`address:${index}`));
    expect(outcomes.filter((retry) => retry === null)).toHaveLength(4);
    expect(outcomes.filter((retry) => retry === 60)).toHaveLength(16);
  });

  it("returns 429 for one credential without exhausting another credential's quota", async () => {
    const limited = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async () => true,
      limits: {
        ...server.limits,
        maxRequestsPerWindow: 2,
        rateLimitWindowMs: 60_000,
      },
    });
    try {
      const headers = { authorization: "Bearer accepted-test-token" };
      expect((await request(limited.origin, certificate, "/api/protocol", headers)).status).toBe(200);
      expect((await request(limited.origin, certificate, "/api/protocol", headers)).status).toBe(200);
      const rejected = await request(limited.origin, certificate, "/api/protocol", headers);
      expect(rejected.status).toBe(429);
      expect(rejected.headers["retry-after"]).toBe("60");
      expect(rejected.headers.connection).toBe("close");
      expect((await request(limited.origin, certificate, "/api/protocol", {
        authorization: "Bearer different-test-token",
      })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("does not allocate credential quota state for unauthenticated identities", async () => {
    const limited = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async (authorization) => authorization === "Bearer authenticated-client",
      limits: {
        ...server.limits,
        maxRequestsPerWindow: 1,
        maxRequestsPerAddressWindow: 20,
        maxRateLimitEntries: 1,
      },
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        expect((await request(limited.origin, certificate, "/api/protocol", {
          authorization: `Bearer attacker-${index}`,
        })).status).toBe(401);
      }
      const headers = { authorization: "Bearer authenticated-client" };
      expect((await request(limited.origin, certificate, "/api/protocol", headers)).status).toBe(200);
      expect((await request(limited.origin, certificate, "/api/protocol", headers)).status).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("rejects over-limit coordination POST, retry, and replay before state mutation", async () => {
    const clientId = "00000000-0000-4000-8000-000000000201";
    const retryKeys = new Set<string>();
    const logEntries: string[] = [];
    let replayCalls = 0;
    let handlerCalls = 0;
    const limited = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async () => true,
      authorizeCoordination: async (authorization) => {
        if (authorization === "Bearer mutation-client" ||
            authorization === "Bearer rotated-mutation-client") return clientPrincipal(clientId);
        if (authorization === "Bearer drone-mutation-client") {
          return droneSessionPrincipal({
            id: "00000000-0000-4000-8000-000000000206",
            clientId,
            cubeId: "00000000-0000-4000-8000-000000000203",
            droneId: "00000000-0000-4000-8000-000000000207",
          });
        }
        return authorization === undefined ? "missing" : "invalid";
      },
      handleCoordination: async (coordinationRequest) => {
        handlerCalls += 1;
        if (coordinationRequest.path === "/api/client/attach") {
          const retryKey = (coordinationRequest.body as {
            payload: { retry_key: string };
          }).payload.retry_key;
          retryKeys.add(retryKey);
          return { status: 201 };
        }
        if (coordinationRequest.path.endsWith("/logs")) {
          logEntries.push((coordinationRequest.body as { payload: { message: string } }).payload.message);
          return { status: 201 };
        }
        replayCalls += 1;
        return { status: 200, stream: heldStream(coordinationRequest.signal) };
      },
      limits: {
        ...server.limits,
        maxRequestsPerWindow: 2,
      },
    });
    try {
      const headers = { authorization: "Bearer mutation-client" };
      const retryKey = "00000000-0000-4000-8000-000000000202";
      const attachBody = JSON.stringify({ payload: { retry_key: retryKey } });
      expect((await request(
        limited.origin,
        certificate,
        "/api/client/attach",
        headers,
        attachBody,
        "POST",
      )).status).toBe(201);
      expect((await request(
        limited.origin,
        certificate,
        "/api/cubes/00000000-0000-4000-8000-000000000203/logs",
        { authorization: "Bearer drone-mutation-client" },
        JSON.stringify({ payload: { message: "allowed-boundary" } }),
        "POST",
      )).status).toBe(201);

      expect((await request(
        limited.origin,
        certificate,
        "/api/client/attach",
        { authorization: "Bearer rotated-mutation-client" },
        attachBody,
        "POST",
      )).status).toBe(429);
      expect((await request(
        limited.origin,
        certificate,
        "/api/cubes/00000000-0000-4000-8000-000000000203/stream",
        headers,
      )).status).toBe(429);
      expect(handlerCalls).toBe(2);
      expect(retryKeys).toEqual(new Set([retryKey]));
      expect(logEntries).toEqual(["allowed-boundary"]);
      expect(replayCalls).toBe(0);
    } finally {
      await limited.close();
    }
  });

  it("enforces independent concurrent quotas per credential identity", () => {
    const quota = new ConcurrentQuota(1);
    const releaseA = quota.acquire("client-a");
    expect(releaseA).not.toBeNull();
    expect(quota.acquire("client-a")).toBeNull();
    const releaseB = quota.acquire("client-b");
    expect(releaseB).not.toBeNull();
    releaseA!();
    expect(quota.acquire("client-a")).not.toBeNull();
    releaseB!();
  });

  it("limits concurrent SSE streams per credential without blocking another credential", async () => {
    let streamCleanups = 0;
    const streaming = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async () => true,
      authorizeCoordination: async (authorization) => {
        if (authorization === "Bearer stream-client-a") {
          return clientPrincipal("00000000-0000-4000-8000-000000000204");
        }
        if (authorization === "Bearer stream-client-b") {
          return droneSessionPrincipal({
            id: "00000000-0000-4000-8000-000000000208",
            clientId: "00000000-0000-4000-8000-000000000204",
            cubeId: "00000000-0000-4000-8000-000000000209",
            droneId: "00000000-0000-4000-8000-000000000210",
          });
        }
        return authorization === undefined ? "missing" : "invalid";
      },
      handleCoordination: async (coordinationRequest) => ({
        status: 200,
        stream: trackedStream(coordinationRequest.signal, () => { streamCleanups += 1; }),
      }),
      limits: {
        ...server.limits,
        maxStreamsPerCredential: 1,
      },
    });
    const path = "/api/cubes/00000000-0000-4000-8000-000000000001/stream";
    const first = await openStream(streaming.origin, certificate, path, "Bearer stream-client-a");
    try {
      expect(first.status).toBe(200);
      const rejected = await request(streaming.origin, certificate, path, {
        authorization: "Bearer stream-client-a",
      });
      expect(rejected.status).toBe(429);
      expect(streamCleanups).toBe(1);
      const other = await openStream(streaming.origin, certificate, path, "Bearer stream-client-b");
      try {
        expect(other.status).toBe(200);
      } finally {
        other.close();
      }
    } finally {
      first.close();
      await streaming.close();
    }
  });

  it("releases delayed SSE startup after a 503 handler timeout", async () => {
    let calls = 0;
    let cleanups = 0;
    const delayed = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol: async () => true,
      authorizeCoordination: async () => clientPrincipal("00000000-0000-4000-8000-000000000205"),
      handleCoordination: async (coordinationRequest) => {
        calls += 1;
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          status: 200,
          stream: trackedStream(coordinationRequest.signal, () => { cleanups += 1; }),
        };
      },
      limits: {
        ...server.limits,
        handlerTimeoutMs: 20,
        maxStreamsPerCredential: 1,
      },
    });
    const path = "/api/cubes/00000000-0000-4000-8000-000000000001/stream";
    try {
      const timedOut = await request(delayed.origin, certificate, path, {
        authorization: "Bearer delayed-stream-client",
      });
      expect(timedOut.status).toBe(503);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(cleanups).toBe(1);

      const retry = await openStream(
        delayed.origin,
        certificate,
        path,
        "Bearer delayed-stream-client",
      );
      expect(retry.status).toBe(200);
      retry.close();
    } finally {
      await delayed.close();
    }
  });
});

async function* heldStream(signal: AbortSignal): AsyncIterable<string> {
  yield "event: bookmark\ndata: {}\n\n";
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function trackedStream(signal: AbortSignal, cleanup: () => void): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = heldStream(signal)[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => {
          cleanup();
          return iterator.return?.() ?? { value: undefined, done: true };
        },
      };
    },
  };
}

function openStream(
  origin: string,
  ca: string,
  path: string,
  authorization: string,
): Promise<{ readonly status: number; readonly close: () => void }> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { authorization },
      ca,
      rejectUnauthorized: true,
      agent: false,
    });
    outgoing.on("response", (response) => {
      response.once("data", () => resolve({
        status: response.statusCode ?? 0,
        close: () => {
          response.destroy();
          outgoing.destroy();
        },
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function signedCertificateMaterial(ip: string) {
  const ca = await generate([{ name: "commonName", value: "test-ca" }], {
    algorithm: "sha256",
    keyType: "ec",
    extensions: [
      { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  const server = await generate([{ name: "commonName", value: "test-server" }], {
    algorithm: "sha256",
    keyType: "ec",
    ca: { key: ca.private, cert: ca.cert },
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip }] },
    ],
  });
  return { ca, server };
}

interface CertificateOptions {
  readonly ip?: string;
  readonly ca?: boolean;
  readonly serverAuth?: boolean;
  readonly notBeforeDate?: Date;
  readonly notAfterDate?: Date;
}

async function certificateMaterial(options: CertificateOptions = {}) {
  const ca = options.ca ?? false;
  const serverAuth = options.serverAuth ?? true;
  return generate([{ name: "commonName", value: "test-server" }], {
    algorithm: "sha256",
    keyType: "ec",
    ...(options.notBeforeDate === undefined ? {} : { notBeforeDate: options.notBeforeDate }),
    ...(options.notAfterDate === undefined ? {} : { notAfterDate: options.notAfterDate }),
    extensions: [
      { name: "basicConstraints", cA: ca, critical: true },
      ca
        ? { name: "keyUsage", digitalSignature: true, keyCertSign: true, critical: true }
        : { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
      serverAuth
        ? { name: "extKeyUsage", serverAuth: true }
        : { name: "extKeyUsage", clientAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: options.ip ?? "127.0.0.1" }] },
    ],
  });
}

async function expectCertificateRejected(
  material: Awaited<ReturnType<typeof generate>>,
  message: string,
): Promise<void> {
  await expect(startHttpsServer({
    bind: { port: 0 },
    tls: { key: material.private, cert: material.cert },
    protocolInfo,
    authorizeProtocol: async () => false,
  })).rejects.toThrow(message);
}

function request(
  origin: string,
  ca: string | undefined,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  body = "",
  method = "GET",
  localAddress?: string,
): Promise<TestResponse> {
  const url = new URL(path, origin);

  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, ...(body === "" ? {} : { "content-length": byteLength(body) }) },
        ca,
        rejectUnauthorized: true,
        agent: false,
        ...(localAddress === undefined ? {} : { localAddress }),
      },
      (response) => {
        response.setEncoding("utf8");
        let responseBody = "";
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: responseBody,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function openRawSocket(origin: string): Promise<Socket> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: url.hostname, port: Number(url.port) });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForSocketClose(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TLS handshake socket remained open."));
    }, timeoutMs);
    timer.unref();
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
