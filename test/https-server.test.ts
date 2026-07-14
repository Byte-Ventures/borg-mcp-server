import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startHttpsServer,
  type ProtocolInfoDocument,
  type RunningServer,
} from "../src/https-server.js";

const protocolInfo: ProtocolInfoDocument = {
  protocol_version: "1",
  package: {
    name: "@borgmcp/shared",
    version: "0.2.0-draft",
  },
  capabilities: ["transport.tls", "authority.no-cloud-fallback"],
  limits: {
    max_request_bytes: 8,
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
  let server: RunningServer;

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
    server = await startHttpsServer({
      bind: { port: 0 },
      tls: { key: material.private, cert: certificate },
      protocolInfo,
      authorizeProtocol: async (authorization) => authorization === "Bearer accepted-test-token",
      limits: {
        maxConnections: 4,
        maxHeaderBytes: 8_192,
        maxRequestBodyBytes: 8,
        maxRequestsPerSocket: 10,
        requestTimeoutMs: 2_000,
        headersTimeoutMs: 1_000,
        keepAliveTimeoutMs: 500,
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

  it("returns the same empty 401 for missing and invalid protocol authorization", async () => {
    const missing = await request(server.origin, certificate, "/api/protocol");
    const invalid = await request(server.origin, certificate, "/api/protocol", {
      authorization: "Bearer invalid-test-token",
    });

    expect(missing).toMatchObject({ status: 401, body: "" });
    expect(invalid).toMatchObject({ status: 401, body: "" });
    expect(missing.headers["content-length"]).toBe("0");
    expect(invalid.headers["content-length"]).toBe("0");
  });

  it("returns protocol readiness and capabilities only after authorization", async () => {
    const response = await request(server.origin, certificate, "/api/protocol", {
      authorization: "Bearer accepted-test-token",
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(protocolInfo);
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
      "123456789",
      "POST",
    );

    expect(response).toMatchObject({ status: 413, body: "" });
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
      maxRequestBodyBytes: 8,
      maxRequestsPerSocket: 10,
      requestTimeoutMs: 2_000,
      headersTimeoutMs: 1_000,
      keepAliveTimeoutMs: 500,
    });
  });

  it("refuses a certificate that does not cover the bind address", async () => {
    const material = await generate([{ name: "commonName", value: "mismatch" }], {
      algorithm: "sha256",
      keyType: "ec",
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyAgreement: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.2" }] },
      ],
    });

    await expect(startHttpsServer({
      bind: { port: 0 },
      tls: { key: material.private, cert: material.cert },
      protocolInfo,
      authorizeProtocol: async () => false,
    })).rejects.toThrow("TLS certificate does not cover the bind address.");
  });
});

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
        path: url.pathname,
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
