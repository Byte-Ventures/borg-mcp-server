import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRequestHandlerContext,
  startHttpsServer,
  type ProtocolInfoDocument,
  type RunningServer,
} from "../src/https-server.js";

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
        maxHeaderBytes: 8_192,
        maxRequestBodyBytes: 1_024,
        maxRequestsPerSocket: 10,
        requestTimeoutMs: 2_000,
        headersTimeoutMs: 1_000,
        keepAliveTimeoutMs: 500,
        handlerTimeoutMs: 250,
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves unauthenticated liveness as an empty 204 without identifying headers", async () => {
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
      maxHeaderBytes: 8_192,
      maxRequestBodyBytes: 1_024,
      maxRequestsPerSocket: 10,
      requestTimeoutMs: 2_000,
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
        maxHeaderBytes: 8_192,
        maxRequestBodyBytes: 8,
        maxRequestsPerSocket: 2,
        requestTimeoutMs: 200,
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

  it("constructs a route context without retaining TLS material", async () => {
    const authorizeProtocol = async (): Promise<boolean> => false;
    const context = createRequestHandlerContext({
      tls: { key, cert: certificate },
      protocolInfo,
      authorizeProtocol,
    });

    expect(context).toEqual({ protocolInfo, authorizeProtocol });
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
});

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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
