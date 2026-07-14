import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrapServer, loadDigestKey } from "../src/bootstrap.js";
import { CredentialAuthority, CredentialDigester } from "../src/credentials.js";
import { CoordinationApi } from "../src/coordination-api.js";
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
    const coordination = new CoordinationApi(runtime, authority);
    const server = await startHttpsServer({
      bind: { port: 0 },
      tls: {
        key: await readFile(bootstrap.paths.serverKey),
        cert: await readFile(bootstrap.paths.serverCertificate),
      },
      protocolInfo: createPart2ProtocolInfo(DEFAULT_SERVICE_LIMITS),
      authorizeProtocol: async (authorization) => authority.authenticate(authorization) !== null,
      exchangeEnrollment: createEnrollmentExchange(authority),
      handleCoordination: (request) => coordination.handle(request),
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
      const cubeId = "00000000-0000-4000-8000-000000000011";
      runtime.maintenance.createCube({ id: cubeId, name: "Offline cube", directive: "" });
      runtime.maintenance.grantClientCube({
        clientId: payload.client_id,
        cubeId,
        access: "manage",
      });
      const roleId = "00000000-0000-4000-8000-000000000012";
      const droneId = "00000000-0000-4000-8000-000000000013";
      runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
      runtime.maintenance.createDrone({
        id: droneId,
        cubeId,
        roleId,
        clientId: payload.client_id,
        label: "one-of-one-builder",
      });

      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/protocol",
        undefined,
        `Bearer ${payload.credential}`,
      )).status).toBe(200);

      for (const path of [
        "/api/cubes",
        `/api/cubes/${cubeId}`,
        `/api/cubes/${cubeId}/roles`,
        `/api/cubes/${cubeId}/drones`,
      ]) {
        expect((await request(
          server.origin,
          await readFile(bootstrap.paths.caCertificate),
          path,
          undefined,
          `Bearer ${payload.credential}`,
        )).status).toBe(200);
      }

      const append = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/logs`,
        JSON.stringify({
          protocol_version: "1",
          request_id: "append-1234",
          payload: { message: "offline coordination" },
        }),
        `Bearer ${payload.credential}`,
      );
      expect(append.status).toBe(201);
      const read = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/logs`,
        JSON.stringify({
          protocol_version: "1",
          request_id: "read-12345",
          payload: { cursor: null, limit: 10 },
        }),
        `Bearer ${payload.credential}`,
        "PUT",
      );
      expect(read.status).toBe(200);
      expect((JSON.parse(read.body) as { payload: { entries: unknown[] } }).payload.entries)
        .toHaveLength(1);

      const oversized = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/logs`,
        "x".repeat(DEFAULT_SERVICE_LIMITS.maxRequestBodyBytes + 1),
        `Bearer ${payload.credential}`,
      );
      expect(oversized.status).toBe(413);
      expect((JSON.parse(oversized.body) as { error: { code: string } }).error.code)
        .toBe("CONTENT_TOO_LARGE");

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
  method?: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method: method ?? (body === undefined ? "GET" : "POST"),
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
