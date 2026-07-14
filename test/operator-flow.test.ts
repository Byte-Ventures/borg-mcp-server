import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrapServer, loadDigestKey } from "../src/bootstrap.js";
import { CredentialAuthority, CredentialDigester } from "../src/credentials.js";
import { createEnrollmentExchange } from "../src/enrollment.js";
import { startHttpsServer } from "../src/https-server.js";
import { createPart2ProtocolInfo } from "../src/protocol-draft.js";
import { openStore } from "../src/store.js";
import { DEFAULT_SERVICE_LIMITS } from "../src/https-server.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("offline operator flow", () => {
  it("bootstraps, enrolls, authenticates, and revokes without cloud access", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-flow-")));
    directories.push(parent);
    const bootstrap = await bootstrapServer(join(parent, "server"));
    const runtime = await openStore({ path: bootstrap.paths.database });
    const digestKey = await loadDigestKey(bootstrap.paths.digestKey);
    const digester = new CredentialDigester(digestKey);
    digestKey.fill(0);
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const server = await startHttpsServer({
      bind: { port: 0 },
      tls: {
        key: await readFile(bootstrap.paths.serverKey),
        cert: await readFile(bootstrap.paths.serverCertificate),
      },
      protocolInfo: createPart2ProtocolInfo(DEFAULT_SERVICE_LIMITS),
      authorizeProtocol: async (authorization) => authority.authenticate(authorization) !== null,
      exchangeEnrollment: createEnrollmentExchange(authority),
    });

    try {
      const enrollment = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/enrollment/exchange",
        JSON.stringify({
          protocol_version: "1",
          request_id: "request-1234",
          payload: { invitation: bootstrap.initialInvitation, client_name: "operator-laptop" },
        }),
      );
      expect(enrollment.status).toBe(201);
      const payload = (JSON.parse(enrollment.body) as {
        payload: { client_id: string; credential: string };
      }).payload;

      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/protocol",
        undefined,
        `Bearer ${payload.credential}`,
      )).status).toBe(200);

      const live = authority.registerLiveSession(payload.client_id);
      authority.revokeClient(payload.client_id);
      expect(live.signal.aborted).toBe(true);
      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/protocol",
        undefined,
        `Bearer ${payload.credential}`,
      )).status).toBe(401);
    } finally {
      await server.close();
      digester.destroy();
      runtime.close();
    }
  });
});

function request(
  origin: string,
  ca: Buffer,
  path: string,
  body?: string,
  authorization?: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method: body === undefined ? "GET" : "POST",
      ca,
      headers: {
        ...(body === undefined ? {} : {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        }),
        ...(authorization === undefined ? {} : { authorization }),
      },
      agent: false,
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: responseBody,
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
