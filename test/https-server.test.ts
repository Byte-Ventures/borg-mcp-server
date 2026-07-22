import { Agent, request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createRequestHandlerContext,
  ConcurrentQuota,
  DEFAULT_SERVICE_LIMITS,
  PreAuthAdmissionLimiter,
  RequestRateLimiter,
  startHttpsServer,
  validateTlsCertificate,
  type RunningServer,
} from "../src/https-server.js";
import { clientPrincipal, droneSessionPrincipal } from "../src/principal.js";
import { createDebugLogger, disabledDebugLogger } from "../src/debug-log.js";
import { createRuntimeBuildIdentity } from "../src/runtime-identity.js";

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
  let coordinationQuery: { readonly cursor?: string; readonly since?: string } = {};

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
      authorizeCoordination: async (authorization) => authorization === "Bearer accepted-test-token"
        ? clientPrincipal("00000000-0000-4000-8000-000000000200")
        : authorization === "Bearer revoked-test-token" ? "revoked"
        : authorization === "Bearer rejected-test-token" ? "rejected"
        : authorization === undefined ? "missing" : "invalid",
      exchangeEnrollment: async (body) => {
        if (body === undefined) {
          return {
            status: 400,
            body: {
              protocol_version: "2",
              error: { code: "INVALID_INPUT", message: "Invalid enrollment request." },
            },
          };
        }
        if ((body as { denied?: boolean }).denied === true) {
          return {
            status: 401,
            body: {
              protocol_version: "2",
              request_id: "request-1234",
              error: { code: "AUTH_INVALID", message: "Enrollment authentication failed." },
            },
          };
        }
        return {
          status: 201,
          body: { protocol_version: "2", request_id: "request-1234", payload: { ok: true } },
        };
      },
      handleCoordination: async (coordinationRequest) => {
        coordinationCalls += 1;
        coordinationQuery = {
          ...(coordinationRequest.cursor === undefined ? {} : { cursor: coordinationRequest.cursor }),
          ...(coordinationRequest.since === undefined ? {} : { since: coordinationRequest.since }),
        };
        return { status: 200, body: { protocol_version: "2", request_id: "unexpected" } };
      },
      runtimeIdentity: createRuntimeBuildIdentity({
        sourceSha: "a".repeat(40),
        artifactIntegrity: `sha512-${"A".repeat(86)}==`,
        startedAt: new Date("2026-07-21T12:00:00.000Z"),
      }),
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

  it("serves the exact protocol tag without reading authorization", async () => {
    const missing = await request(server.origin, certificate, "/api/protocol");
    const invalid = await request(server.origin, certificate, "/api/protocol", {
      authorization: "Bearer invalid-test-token",
    });

    expect(missing).toMatchObject({ status: 200, body: '{"protocol_version":"2"}' });
    expect(invalid).toMatchObject({ status: 200, body: '{"protocol_version":"2"}' });
  });

  it("serves build identity only to an authenticated principal without coordination mutation", async () => {
    const before = coordinationCalls;
    const missing = await request(server.origin, certificate, "/api/runtime");
    const invalid = await request(server.origin, certificate, "/api/runtime", {
      authorization: "Bearer invalid-test-token",
    });
    const accepted = await request(server.origin, certificate, "/api/runtime", {
      authorization: "Bearer accepted-test-token",
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({
      package_version: "0.1.12",
      source_sha: "a".repeat(40),
      artifact_integrity: `sha512-${"A".repeat(86)}==`,
      protocol_version: "2",
      started_at: "2026-07-21T12:00:00.000Z",
    });
    expect(coordinationCalls).toBe(before);
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
      const authentication = await request(server.origin, certificate, "/api/cubes", {
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
      debugLogger: createDebugLogger((line) => lines.push(line)),
    });
    const urlSecret = "secret-url-component";
    const bearerSecret = "secret-bearer-component";
    try {
      await request(debugServer.origin, certificate, `/api/${urlSecret}`, {
        authorization: `Bearer ${bearerSecret}`,
      });
      await request(debugServer.origin, certificate, "/api/protocol");
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
        authentication: "not_required",
        authorization: "not_checked",
        status: 200,
      }),
    ]));
  });

  it("returns only the protocol tag without authorization", async () => {
    const response = await request(server.origin, certificate, "/api/protocol");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ protocol_version: "2" });
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

  it("reports a revoked session distinctly before routing", async () => {
    coordinationCalls = 0;
    for (const path of [
      "/api/cubes",
      "/api/cubes/00000000-0000-4000-8000-000000000001/stream",
    ]) {
      const response = await request(
        server.origin,
        certificate,
        path,
        { authorization: "Bearer revoked-test-token" },
      );
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({
        protocol_version: "2",
        error: { code: "SESSION_REVOKED", message: "Authentication failed." },
      });
    }
    expect(coordinationCalls).toBe(0);
  });

  it("reports a taken-over session distinctly before routing", async () => {
    coordinationCalls = 0;
    for (const path of [
      "/api/cubes",
      "/api/cubes/00000000-0000-4000-8000-000000000001/stream",
    ]) {
      const response = await request(
        server.origin,
        certificate,
        path,
        { authorization: "Bearer rejected-test-token" },
      );
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({
        protocol_version: "2",
        error: { code: "SESSION_REJECTED", message: "Authentication failed." },
      });
    }
    expect(coordinationCalls).toBe(0);
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
      handleCoordination: async () => ({ status: 204 }),
    })).rejects.toThrow("Coordination routes require server-derived principal authentication.");
  });

  it("serves invitation-authorized enrollment through the bounded JSON route", async () => {
    const response = await request(
      server.origin,
      certificate,
      "/api/enrollment/exchange",
      { "content-type": "application/json" },
      JSON.stringify({ protocol_version: "2", request_id: "request-1234", payload: {} }),
      "POST",
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toEqual({
      protocol_version: "2",
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
      protocol_version: "2",
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
      protocol_version: "2",
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

  it("forwards one roster liveness anchor and rejects ambiguous anchors", async () => {
    const path = "/api/cubes/00000000-0000-4000-8000-000000000001/drones";
    const accepted = await request(
      server.origin,
      certificate,
      `${path}?since=2026-07-19T09%3A00%3A00.000Z`,
      { authorization: "Bearer accepted-test-token" },
    );
    expect(accepted.status).toBe(200);
    expect(coordinationQuery).toEqual({ since: "2026-07-19T09:00:00.000Z" });

    coordinationCalls = 0;
    const rejected = await request(
      server.origin,
      certificate,
      `${path}?since=first&since=second`,
      { authorization: "Bearer accepted-test-token" },
    );
    expect(rejected.status).toBe(400);
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

  it("destroys incomplete TLS handshakes and releases connection capacity", async () => {
    const bounded = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
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

  it("bounds incomplete handshakes per address without exhausting the independent global limit", async () => {
    let connections = 0;
    const bounded = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      testHooks: {
        identifyConnectionAddress: () => {
          connections += 1;
          return connections <= 31 ? "attacker" : "fresh";
        },
      },
      limits: {
        ...DEFAULT_SERVICE_LIMITS,
        maxConnections: 32,
        maxConnectionsPerAddress: 30,
        maxStreamsPerCredential: 8,
        tlsHandshakeTimeoutMs: 1_000,
      },
    });
    const attackers: Socket[] = [];
    try {
      attackers.push(...await Promise.all(Array.from({ length: 31 }, () => openRawSocket(bounded.origin))));
      expect((await request(
        bounded.origin,
        certificate,
        "/healthz",
        {},
        "",
        "GET",
      )).status).toBe(204);

      await Promise.all(attackers.map((socket) => waitForSocketClose(socket, 2_000)));
      expect((await request(bounded.origin, certificate, "/healthz")).status).toBe(204);
    } finally {
      attackers.forEach((socket) => socket.destroy());
      await bounded.close();
    }
  });

  it("allows only one requestless over-cap TLS socket per address", async () => {
    const bounded = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      limits: {
        ...DEFAULT_SERVICE_LIMITS,
        maxConnections: 32,
        maxConnectionsPerAddress: 30,
        maxStreamsPerCredential: 8,
      },
    });
    const secureSockets: TLSSocket[] = [];
    let overflow: Socket | undefined;
    try {
      secureSockets.push(...await Promise.all(Array.from(
        { length: 31 },
        () => openSecureSocket(bounded.origin, certificate),
      )));
      overflow = await openRawSocket(bounded.origin);
      await expect(waitForSocketClose(overflow, 500)).resolves.toBeUndefined();
    } finally {
      overflow?.destroy();
      secureSockets.forEach((socket) => socket.destroy());
      await bounded.close();
    }
  });

  it("constructs a route context without retaining TLS material", async () => {
    const context = createRequestHandlerContext({
      tls: { key, cert: certificate },
    });

    expect(context).toEqual({ debugLogger: disabledDebugLogger });
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
      authorizeCoordination: async (authorization) => authorization === "Bearer accepted-test-token"
        ? clientPrincipal("00000000-0000-4000-8000-000000000210")
        : authorization === "Bearer different-test-token"
          ? clientPrincipal("00000000-0000-4000-8000-000000000211")
          : "invalid",
      handleCoordination: async () => ({ status: 200, body: {} }),
      limits: {
        ...server.limits,
        maxRequestsPerWindow: 2,
        rateLimitWindowMs: 60_000,
      },
    });
    try {
      const headers = { authorization: "Bearer accepted-test-token" };
      expect((await request(limited.origin, certificate, "/api/cubes", headers)).status).toBe(200);
      expect((await request(limited.origin, certificate, "/api/cubes", headers)).status).toBe(200);
      const rejected = await request(limited.origin, certificate, "/api/cubes", headers);
      expect(rejected.status).toBe(429);
      expect(rejected.headers["retry-after"]).toBe("60");
      expect(rejected.headers.connection).toBe("close");
      expect((await request(limited.origin, certificate, "/api/cubes", {
        authorization: "Bearer different-test-token",
      })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("isolates routine-read rate limits between drone sessions owned by one client", async () => {
    const clientId = "00000000-0000-4000-8000-000000000220";
    const limited = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      authorizeCoordination: async (authorization) => {
        if (authorization === "Bearer drone-a") {
          return droneSessionPrincipal({
            id: "00000000-0000-4000-8000-000000000221",
            clientId,
            cubeId: "00000000-0000-4000-8000-000000000223",
            droneId: "00000000-0000-4000-8000-000000000224",
          });
        }
        if (authorization === "Bearer drone-b") {
          return droneSessionPrincipal({
            id: "00000000-0000-4000-8000-000000000222",
            clientId,
            cubeId: "00000000-0000-4000-8000-000000000223",
            droneId: "00000000-0000-4000-8000-000000000225",
          });
        }
        return "invalid";
      },
      handleCoordination: async () => ({ status: 200, body: {} }),
      limits: {
        ...server.limits,
        maxRequestsPerWindow: 3,
      },
    });
    try {
      const routineReads = [
        { path: "/api/cubes", method: "GET", body: "" },
        {
          path: "/api/cubes/00000000-0000-4000-8000-000000000223/logs",
          method: "PUT",
          body: JSON.stringify({ payload: { cursor: null, limit: 20 } }),
        },
        {
          path: "/api/cubes/00000000-0000-4000-8000-000000000223/decisions",
          method: "PUT",
          body: JSON.stringify({ payload: {} }),
        },
      ];
      for (const token of ["drone-a", "drone-b"]) {
        const headers = { authorization: `Bearer ${token}` };
        for (const read of routineReads) {
          expect((await request(
            limited.origin,
            certificate,
            read.path,
            headers,
            read.body,
            read.method,
          )).status).toBe(200);
        }
        expect((await request(limited.origin, certificate, "/api/cubes", headers)).status).toBe(429);
      }
    } finally {
      await limited.close();
    }
  });

  it("aggregates mutation and stream rate limits across sibling drone sessions", async () => {
    const clientId = "00000000-0000-4000-8000-000000000230";
    const authorize = async (authorization: string | undefined) => {
      const suffix = authorization === "Bearer drone-a" ? "1" : authorization === "Bearer drone-b" ? "2" : null;
      if (suffix === null) return "invalid" as const;
      return droneSessionPrincipal({
        id: `00000000-0000-4000-8000-00000000023${suffix}`,
        clientId,
        cubeId: "00000000-0000-4000-8000-000000000233",
        droneId: `00000000-0000-4000-8000-00000000024${suffix}`,
      });
    };
    const mutationLimited = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      authorizeCoordination: authorize,
      handleCoordination: async () => ({ status: 201 }),
      limits: { ...server.limits, maxRequestsPerWindow: 1 },
    });
    const logPath = "/api/cubes/00000000-0000-4000-8000-000000000233/logs";
    try {
      expect((await request(
        mutationLimited.origin,
        certificate,
        logPath,
        { authorization: "Bearer drone-a" },
        JSON.stringify({ payload: { message: "first" } }),
        "POST",
      )).status).toBe(201);
      expect((await request(
        mutationLimited.origin,
        certificate,
        logPath,
        { authorization: "Bearer drone-b" },
        JSON.stringify({ payload: { message: "second" } }),
        "POST",
      )).status).toBe(429);
    } finally {
      await mutationLimited.close();
    }

    const streamLimited = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      authorizeCoordination: authorize,
      handleCoordination: async (coordinationRequest) => ({
        status: 200,
        stream: heldStream(coordinationRequest.signal),
      }),
      limits: { ...server.limits, maxRequestsPerWindow: 1 },
    });
    const streamPath = "/api/cubes/00000000-0000-4000-8000-000000000233/stream";
    const first = await openStream(streamLimited.origin, certificate, streamPath, "Bearer drone-a");
    try {
      expect(first.status).toBe(200);
      expect((await request(streamLimited.origin, certificate, streamPath, {
        authorization: "Bearer drone-b",
      })).status).toBe(429);
    } finally {
      first.close();
      await streamLimited.close();
    }
  });

  it("keeps a cursor-complete log read burst on a reusable connection", async () => {
    let expectedCursor: number | null = null;
    const readCount = 150;
    const burst = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      authorizeCoordination: async () => clientPrincipal(
        "00000000-0000-4000-8000-000000000226",
      ),
      handleCoordination: async (coordinationRequest) => {
        const cursor = (coordinationRequest.body as { payload: { cursor: number | null } }).payload.cursor;
        expect(cursor).toBe(expectedCursor);
        expectedCursor = expectedCursor === null ? 0 : expectedCursor + 1;
        return {
          status: 200,
          body: {
            protocol_version: "2",
            request_id: `read-${expectedCursor}`,
            payload: {
              entries: [{ sequence: expectedCursor }],
              cursor: expectedCursor,
              behind_by: readCount - expectedCursor - 1,
              has_more: expectedCursor + 1 < readCount,
            },
          },
        };
      },
      limits: {
        ...DEFAULT_SERVICE_LIMITS,
        maxRequestsPerWindow: 200,
        maxRequestsPerAddressWindow: 250,
        maxRequestsGlobalWindow: 300,
      },
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      let cursor: number | null = null;
      for (let index = 0; index < readCount; index += 1) {
        const response = await request(
          burst.origin,
          certificate,
          "/api/cubes/00000000-0000-4000-8000-000000000227/logs",
          { authorization: "Bearer burst-client" },
          JSON.stringify({ payload: { cursor, limit: 1 } }),
          "PUT",
          undefined,
          agent,
        );
        expect(response.status).toBe(200);
        expect(response.headers.connection).not.toBe("close");
        const payload = JSON.parse(response.body) as { payload: { cursor: number } };
        cursor = payload.payload.cursor;
      }
      expect(cursor).toBe(readCount - 1);
    } finally {
      agent.destroy();
      await burst.close();
    }
  });

  it("admits thirty simultaneous same-loopback TLS appends and drains each entry exactly once", async () => {
    const messages: string[] = [];
    let releaseAppends!: () => void;
    const allAppendsAdmitted = new Promise<void>((resolve) => { releaseAppends = resolve; });
    const path = "/api/cubes/00000000-0000-4000-8000-000000000228/logs";
    const burst = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      authorizeCoordination: async () => clientPrincipal(
        "00000000-0000-4000-8000-000000000229",
      ),
      handleCoordination: async (coordinationRequest) => {
        if (coordinationRequest.path === path && coordinationRequest.method === "POST") {
          const message = (coordinationRequest.body as { payload: { message: string } }).payload.message;
          messages.push(message);
          if (messages.length === 30) releaseAppends();
          await allAppendsAdmitted;
          return { status: 201, body: { protocol_version: "2", payload: { accepted: true } } };
        }
        if (coordinationRequest.path === path && coordinationRequest.method === "PUT") {
          return {
            status: 200,
            body: {
              protocol_version: "2",
              payload: { entries: messages.map((message) => ({ message })) },
            },
          };
        }
        return { status: 404 };
      },
    });
    const submitted = Array.from({ length: 30 }, (_, index) => `append-${index}`);
    try {
      const responses = await Promise.all(submitted.map((message, index) => request(
        burst.origin,
        certificate,
        path,
        { authorization: "Bearer burst-client" },
        JSON.stringify({ protocol_version: "2", request_id: `append-${index}`, payload: { message } }),
        "POST",
      )));
      expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 30 }, () => 201));

      const drained = await request(
        burst.origin,
        certificate,
        path,
        { authorization: "Bearer burst-client" },
        JSON.stringify({ protocol_version: "2", request_id: "drain", payload: {} }),
        "PUT",
      );
      expect(drained.status).toBe(200);
      const entries = (JSON.parse(drained.body) as { payload: { entries: Array<{ message: string }> } })
        .payload.entries.map((entry) => entry.message);
      expect(entries).toHaveLength(30);
      expect(new Set(entries)).toEqual(new Set(submitted));
      expect(new Set(messages)).toEqual(new Set(submitted));
    } finally {
      await burst.close();
    }
  });

  it("returns controlled 429 admission backpressure above the same-address connection cap without mutation", async () => {
    const messages: string[] = [];
    let markAppendsAdmitted!: () => void;
    const allAppendsAdmitted = new Promise<void>((resolve) => { markAppendsAdmitted = resolve; });
    let releaseAppends!: () => void;
    const releaseHeldAppends = new Promise<void>((resolve) => { releaseAppends = resolve; });
    const path = "/api/cubes/00000000-0000-4000-8000-000000000230/logs";
    const burst = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      authorizeCoordination: async () => clientPrincipal(
        "00000000-0000-4000-8000-000000000231",
      ),
      handleCoordination: async (coordinationRequest) => {
        if (coordinationRequest.path !== path || coordinationRequest.method !== "POST") {
          return { status: 404 };
        }
        const message = (coordinationRequest.body as { payload: { message: string } }).payload.message;
        messages.push(message);
        if (messages.length === 30) markAppendsAdmitted();
        await releaseHeldAppends;
        return { status: 201, body: { protocol_version: "2", payload: { accepted: true } } };
      },
    });
    const submitted = Array.from({ length: 31 }, (_, index) => `append-${index}`);
    try {
      const acceptedRequests = submitted.slice(0, 30).map((message, index) => request(
        burst.origin,
        certificate,
        path,
        { authorization: "Bearer burst-client" },
        JSON.stringify({ protocol_version: "2", request_id: `over-cap-${index}`, payload: { message } }),
        "POST",
      ));
      await allAppendsAdmitted;
      const rejected = await request(
        burst.origin,
        certificate,
        path,
        { authorization: "Bearer burst-client" },
        JSON.stringify({ protocol_version: "2", request_id: "over-cap-30", payload: { message: submitted[30] } }),
        "POST",
      );
      expect(rejected.status).toBe(429);
      expect(rejected.headers.connection).toBe("close");
      releaseAppends();
      const acceptedResponses = await Promise.all(acceptedRequests);
      expect(acceptedResponses.map((response) => response.status)).toEqual(Array.from({ length: 30 }, () => 201));
      expect(messages).toHaveLength(30);
      expect(new Set(messages)).toEqual(new Set(submitted.slice(0, 30)));
    } finally {
      await burst.close();
    }
  });

  it("does not allocate credential quota state for unauthenticated identities", async () => {
    const limited = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      authorizeCoordination: async (authorization) => authorization === "Bearer authenticated-client"
        ? clientPrincipal("00000000-0000-4000-8000-000000000212")
        : "invalid",
      handleCoordination: async () => ({ status: 200, body: {} }),
      limits: {
        ...server.limits,
        maxRequestsPerWindow: 1,
        maxRequestsPerAddressWindow: 20,
        maxRateLimitEntries: 1,
      },
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        expect((await request(limited.origin, certificate, "/api/cubes", {
          authorization: `Bearer attacker-${index}`,
        })).status).toBe(401);
      }
      const headers = { authorization: "Bearer authenticated-client" };
      expect((await request(limited.origin, certificate, "/api/cubes", headers)).status).toBe(200);
      expect((await request(limited.origin, certificate, "/api/cubes", headers)).status).toBe(429);
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

  it("keeps ten heartbeat-active SSE responses open beyond the inactivity timeout", async () => {
    const streaming = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
      authorizeCoordination: async () => clientPrincipal(
        "00000000-0000-4000-8000-000000000211",
      ),
      handleCoordination: async (coordinationRequest) => ({
        status: 200,
        stream: heartbeatStream(coordinationRequest.signal, 5),
      }),
      limits: {
        ...server.limits,
        handlerTimeoutMs: 10,
        maxConnections: 12,
        maxConnectionsPerAddress: 12,
        maxStreamsPerCredential: 10,
      },
    });
    const path = "/api/cubes/00000000-0000-4000-8000-000000000001/stream";
    const opened = await Promise.all(Array.from({ length: 10 }, () => openStream(
      streaming.origin,
      certificate,
      path,
      "Bearer idle-client",
    )));
    const closed = Array.from({ length: 10 }, () => false);
    opened.forEach((stream, index) => {
      void stream.closed.then(() => { closed[index] = true; });
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(closed).toEqual(Array.from({ length: 10 }, () => false));
    } finally {
      for (const stream of opened) stream.close();
      await streaming.close();
    }
  });

  it("releases delayed SSE startup after a 503 handler timeout", async () => {
    let calls = 0;
    let cleanups = 0;
    const delayed = await startHttpsServer({
      bind: { port: 0 },
      tls: { key, cert: certificate },
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

async function* heartbeatStream(signal: AbortSignal, intervalMs: number): AsyncIterable<string> {
  yield "event: bookmark\ndata: {}\n\n";
  while (!signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (!signal.aborted) yield `event: heartbeat\ndata: {"ts":"test"}\n\n`;
  }
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
): Promise<{
  readonly status: number;
  readonly close: () => void;
  readonly closed: Promise<void>;
}> {
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
      const closed = new Promise<void>((resolveClosed) => {
        response.once("close", () => resolveClosed());
      });
      response.once("data", () => resolve({
        status: response.statusCode ?? 0,
        closed,
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
  agent: Agent | false = false,
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
        agent,
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

function openRawSocket(origin: string, localAddress?: string): Promise<Socket> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connectTcp({
      host: url.hostname,
      port: Number(url.port),
      ...(localAddress === undefined ? {} : { localAddress }),
    });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function openSecureSocket(
  origin: string,
  ca: string,
  localAddress?: string,
): Promise<TLSSocket> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connectTls({
      host: url.hostname,
      port: Number(url.port),
      ca,
      rejectUnauthorized: true,
      ...(localAddress === undefined ? {} : { localAddress }),
    });
    socket.once("secureConnect", () => resolve(socket));
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
