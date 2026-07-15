import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapServer, loadDigestKey } from "../src/bootstrap.js";
import { CredentialAuthority, CredentialDigester } from "../src/credentials.js";
import { CoordinationApi } from "../src/coordination-api.js";
import { createEnrollmentExchange } from "../src/enrollment.js";
import { startHttpsServer } from "../src/https-server.js";
import { createPart2ProtocolInfo } from "../src/protocol-draft.js";
import { acquireRuntimeLock, createOfflineCredentialService } from "../src/service.js";
import { openStore } from "../src/store.js";
import { DEFAULT_SERVICE_LIMITS } from "../src/https-server.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("offline operator flow", () => {
  it("rotates and revokes a hashed client credential without a listener", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-credential-")));
    directories.push(parent);
    const dataDirectory = join(parent, "server");
    const bootstrap = await bootstrapServer(dataDirectory);
    const enrolled = await withAuthority(dataDirectory, (authority) =>
      authority.exchangeInvitation({ invitation: bootstrap.initialInvitation, clientName: "operator" }));
    expect(enrolled).not.toBeNull();
    const service = createOfflineCredentialService(dataDirectory);

    const running = await acquireRuntimeLock(dataDirectory);
    await expect(service.rotateClient(enrolled!.clientId)).rejects.toThrow(
      "The server must be stopped before offline credential changes.",
    );
    await running.release();

    const rotated = await service.rotateClient(enrolled!.clientId);
    expect(await withAuthority(dataDirectory, (authority) =>
      authority.authenticate(`Bearer ${enrolled!.credential}`))).toBeNull();
    expect(await withAuthority(dataDirectory, (authority) =>
      authority.authenticate(`Bearer ${rotated}`))).toMatchObject({ kind: "client", id: enrolled!.clientId });

    await service.revokeClient(enrolled!.clientId);
    expect(await withAuthority(dataDirectory, (authority) =>
      authority.authenticate(`Bearer ${rotated}`))).toBeNull();
    expect(listen).not.toHaveBeenCalled();
  });

  it("shares request quota across issued sessions and actual client rotation", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-quota-")));
    directories.push(parent);
    const bootstrap = await bootstrapServer(join(parent, "server"));
    const runtime = await openStore({ path: bootstrap.paths.database });
    const digestKey = await loadDigestKey(bootstrap.paths.digestKey);
    const digester = new CredentialDigester(digestKey);
    digestKey.fill(0);
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const enrolled = authority.exchangeInvitation({
      invitation: bootstrap.initialInvitation,
      clientName: "quota-client",
    })!;
    const cubeId = "00000000-0000-4000-8000-000000000021";
    const roleId = "00000000-0000-4000-8000-000000000022";
    const retryKey = "00000000-0000-4000-8000-000000000023";
    runtime.maintenance.createCube({ id: cubeId, name: "Quota cube", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: enrolled.clientId, cubeId, access: "manage" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    const principal = authority.authenticate(`Bearer ${enrolled.credential}`)!;
    const issued = authority.attachSeat(runtime.forPrincipal(principal), { cubeId, roleId, retryKey });
    const reissued = authority.attachSeat(runtime.forPrincipal(principal), { cubeId, roleId, retryKey });
    expect(authority.authenticate(`Bearer ${issued.credential}`)).toBeNull();
    expect(authority.authenticate(`Bearer ${reissued.credential}`)).toMatchObject({
      kind: "drone-session",
      clientId: enrolled.clientId,
    });
    const coordination = new CoordinationApi(runtime, authority);
    const limits = { ...DEFAULT_SERVICE_LIMITS, maxRequestsPerWindow: 3 };
    const server = await startHttpsServer({
      bind: { port: 0 },
      tls: {
        key: await readFile(bootstrap.paths.serverKey),
        cert: await readFile(bootstrap.paths.serverCertificate),
      },
      limits,
      protocolInfo: createPart2ProtocolInfo(limits),
      authorizeProtocol: async (authorization) => authority.authenticate(authorization) !== null,
      authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
      handleCoordination: (coordinationRequest) => coordination.handle(coordinationRequest),
    });
    const ca = await readFile(bootstrap.paths.caCertificate);
    try {
      expect((await request(
        server.origin, ca, "/api/cubes", undefined, `Bearer ${enrolled.credential}`,
      )).status).toBe(200);
      expect((await request(
        server.origin, ca, "/api/cubes", undefined, `Bearer ${reissued.credential}`,
      )).status).toBe(200);

      const rotated = authority.rotateClient(enrolled.clientId);
      expect(authority.authenticate(`Bearer ${enrolled.credential}`)).toBeNull();
      expect((await request(
        server.origin, ca, "/api/cubes", undefined, `Bearer ${rotated}`,
      )).status).toBe(200);
      expect((await request(
        server.origin, ca, "/api/cubes", undefined, `Bearer ${reissued.credential}`,
      )).status).toBe(429);
    } finally {
      await server.close();
      digester.destroy();
      runtime.close();
    }
  });

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
      authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
      exchangeEnrollment: createEnrollmentExchange(authority),
      handleCoordination: (request) => coordination.handle(request),
    });

    try {
      const authCube = "00000000-0000-4000-8000-000000000011";
      for (const [path, body, method] of [
        ["/api/cubes", undefined, "GET"],
        ["/api/client/attach", "{}", "POST"],
        [`/api/cubes/${authCube}`, undefined, "GET"],
        [`/api/cubes/${authCube}/roles`, undefined, "GET"],
        [`/api/cubes/${authCube}/drones`, undefined, "GET"],
        [`/api/cubes/${authCube}/logs`, "{}", "POST"],
        [`/api/cubes/${authCube}/logs`, "{}", "PUT"],
        [`/api/cubes/${authCube}/acks`, "{}", "POST"],
        [`/api/cubes/${authCube}/decisions`, "{}", "POST"],
        [`/api/cubes/${authCube}/decisions`, "{}", "PUT"],
        [`/api/cubes/${authCube}/stream`, undefined, "GET"],
      ] as const) {
        const missing = await request(
          server.origin,
          await readFile(bootstrap.paths.caCertificate),
          path,
          body,
          undefined,
          method,
        );
        const invalid = await request(
          server.origin,
          await readFile(bootstrap.paths.caCertificate),
          path,
          body,
          "Bearer invalid-credential-material-that-is-long-enough-123",
          method,
        );
        expect(missing.status).toBe(401);
        expect((JSON.parse(missing.body) as { error: { code: string } }).error.code).toBe("AUTH_MISSING");
        expect(invalid.status).toBe(401);
        expect((JSON.parse(invalid.body) as { error: { code: string } }).error.code).toBe("AUTH_INVALID");
      }

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
      runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });

      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/protocol",
        undefined,
        `Bearer ${payload.credential}`,
      )).status).toBe(200);

      const attachment = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/client/attach",
        JSON.stringify({
          protocol_version: "1",
          request_id: "attach-1234",
          payload: {
            cube_id: cubeId,
            role_id: roleId,
            retry_key: "00000000-0000-4000-8000-000000000013",
          },
        }),
        `Bearer ${payload.credential}`,
      );
      expect(attachment.status).toBe(201);
      const attached = (JSON.parse(attachment.body) as {
        payload: { session: { token: string; generation: number } };
      }).payload;
      expect(attached.session.generation).toBe(1);
      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/protocol",
        undefined,
        `Bearer ${attached.session.token}`,
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

      const liveStream = await openEventStream(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/stream`,
        `Bearer ${payload.credential}`,
      );
      authority.revokeClient(payload.client_id);
      await expect(Promise.race([
        liveStream.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Stream remained open.")), 500)),
      ])).resolves.toBeUndefined();
      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/protocol",
        undefined,
        `Bearer ${payload.credential}`,
      )).status).toBe(401);
      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/stream`,
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

async function withAuthority<T>(
  dataDirectory: string,
  operation: (authority: CredentialAuthority) => T,
): Promise<T> {
  const runtime = await openStore({ path: join(dataDirectory, "borg.db") });
  const digestKey = await loadDigestKey(join(dataDirectory, "credential-digest.key"));
  const digester = new CredentialDigester(digestKey);
  digestKey.fill(0);
  try {
    return operation(new CredentialAuthority(runtime.credentials, digester));
  } finally {
    digester.destroy();
    runtime.close();
  }
}

function openEventStream(
  origin: string,
  ca: Buffer,
  path: string,
  authorization: string,
): Promise<{ readonly closed: Promise<void> }> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      ca,
      headers: { authorization },
      agent: false,
    });
    outgoing.on("response", (response) => {
      const closed = new Promise<void>((resolveClosed) => {
        response.once("end", resolveClosed);
        response.once("close", resolveClosed);
      });
      response.once("data", () => resolve({ closed }));
      response.resume();
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

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
