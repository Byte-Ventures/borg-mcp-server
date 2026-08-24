import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapServer, loadDigestKey } from "../src/bootstrap.js";
import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import { CoordinationApi } from "../src/coordination-api.js";
import { createEnrollmentExchange } from "../src/enrollment.js";
import { startHttpsServer } from "../src/https-server.js";
import { runCli } from "../src/cli.js";
import { acquireRuntimeLock, createOfflineCredentialService } from "../src/service.js";
import { createRuntimeBuildIdentity } from "../src/runtime-identity.js";
import { openStore } from "../src/store.js";
import type { Principal } from "../src/principal.js";
import { DEFAULT_SERVICE_LIMITS } from "../src/https-server.js";
import type { PortableServerCredential } from "../src/portable-credential-store.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("offline operator flow", () => {
  it("returns DRONE_EVICTED before dispatching any coordination route", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-evicted-")));
    directories.push(parent);
    const { installation: bootstrap, ownerCredential } = await bootstrapWithOwner(join(parent, "server"));
    const runtime = await openStore({ path: bootstrap.paths.database });
    const digestKey = await loadDigestKey(bootstrap.paths.digestKey);
    const digester = new CredentialDigester(digestKey);
    digestKey.fill(0);
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const credential = generateSecret();
    const invitation = authority.createInvitationForOwnerCredential(ownerCredential, 60_000)!;
    const enrolled = authority.exchangeInvitation({
      invitation,
      retryKey: randomUUID(),
      clientCredential: credential,
      clientName: "eviction-client",
    })!;
    const cubeId = "00000000-0000-4000-8000-000000000041";
    const roleId = "00000000-0000-4000-8000-000000000042";
    const sessionCredential = generateSecret();
    runtime.maintenance.createCube({ id: cubeId, name: "Eviction cube", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: enrolled.clientId, cubeId, access: "manage" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    const principal = authority.authenticate(`Bearer ${credential}`)!;
    const attached = authority.attachSeat(runtime.forPrincipal(principal), {
      cubeId, roleId, sessionCredential,
    });
    const coordination = new CoordinationApi(runtime, authority);
    const server = await startHttpsServer({
      bind: { port: 0 },
      tls: {
        key: await readFile(bootstrap.paths.serverKey),
        cert: await readFile(bootstrap.paths.serverCertificate),
      },
      authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
      handleCoordination: (coordinationRequest) => coordination.handle(coordinationRequest),
    });
    const database = new DatabaseSync(bootstrap.paths.database);
    database.prepare("UPDATE drones SET evicted_at = ? WHERE id = ?")
      .run("2026-07-19T17:00:00.000Z", attached.drone.id);
    database.close();
    const ca = await readFile(bootstrap.paths.caCertificate);
    try {
      for (const [path, body, method] of [
        ["/api/cubes", undefined, "GET"],
        ["/api/client/attach", "{}", "POST"],
        [`/api/cubes/${cubeId}`, undefined, "GET"],
        [`/api/cubes/${cubeId}/roles`, undefined, "GET"],
        [`/api/cubes/${cubeId}/drones`, undefined, "GET"],
        [`/api/cubes/${cubeId}/logs`, "{}", "POST"],
        [`/api/cubes/${cubeId}/acks`, "{}", "POST"],
        [`/api/cubes/${cubeId}/decisions`, "{}", "POST"],
        [`/api/cubes/${cubeId}/documents`, "{}", "GET"],
        [`/api/cubes/${cubeId}/documents/00000000-0000-4000-8000-000000000099`, "{}", "GET"],
        [`/api/cubes/${cubeId}/stream`, undefined, "GET"],
      ] as const) {
        const response = await request(
          server.origin, ca, path, body, `Bearer ${sessionCredential}`, method,
        );
        expect(response.status).toBe(410);
        expect(JSON.parse(response.body)).toMatchObject({
          error: { code: "DRONE_EVICTED", message: "Authentication failed." },
        });
      }
    } finally {
      await server.close();
      digester.destroy();
      runtime.close();
    }
  });

  it("grants and removes only the named client cube authority while stopped", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-grant-")));
    directories.push(parent);
    const dataDirectory = join(parent, "server");
    const { installation: bootstrap, ownerCredential } = await bootstrapWithOwner(dataDirectory);
    const credential = generateSecret();
    const enrolled = await withAuthority(dataDirectory, (authority) => {
      const invitation = authority.createInvitationForOwnerCredential(ownerCredential, 60_000)!;
      return authority.exchangeInvitation({
        invitation,
        retryKey: randomUUID(),
        clientCredential: credential,
        clientName: "grant-client",
      });
    });
    if (enrolled === null) throw new Error("Enrollment failed.");
    const cubeId = "00000000-0000-4000-8000-000000000031";
    const runtime = await openStore({ path: bootstrap.paths.database });
    runtime.maintenance.createCube({ id: cubeId, name: "Explicit grant", directive: "" });
    runtime.close();
    const service = createOfflineCredentialService(dataDirectory);

    await service.grantClient(enrolled.clientId, cubeId, "read");
    expect(await withAuthority(dataDirectory, (authority) => {
      const principal = authority.authenticate(`Bearer ${credential}`);
      if (principal === null) throw new Error("Authentication failed.");
      return openScopedCubes(dataDirectory, principal);
    })).toEqual([cubeId]);
    await service.ungrantClient(enrolled.clientId, cubeId);
    expect(await withAuthority(dataDirectory, (authority) => {
      const principal = authority.authenticate(`Bearer ${credential}`);
      if (principal === null) throw new Error("Authentication failed.");
      return openScopedCubes(dataDirectory, principal);
    })).toEqual([]);
    await expect(service.ungrantClient(enrolled.clientId, cubeId)).rejects.toThrow(
      "Provide an existing client cube grant.",
    );
  });

  it.each(["grant", "ungrant", "revoke"] as const)(
    "refuses a duplicate client name for %s with disambiguating handles",
    async (verb) => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-ambiguous-client-")));
      directories.push(parent);
      const dataDirectory = join(parent, "server");
      const bootstrap = await bootstrapServer(dataDirectory);
      const firstId = "aaaaaaaa-1000-4000-8000-000000000001";
      const secondId = "aaaaaaaa-2000-4000-8000-000000000002";
      const cubeId = "00000000-0000-4000-8000-000000000051";
      const runtime = await openStore({ path: bootstrap.paths.database });
      runtime.maintenance.createClient({ id: firstId, name: "Local client" });
      runtime.maintenance.createClient({ id: secondId, name: "Local client" });
      runtime.maintenance.createCube({ id: cubeId, name: "Ambiguous grant", directive: "" });
      runtime.maintenance.grantClientCube({ clientId: firstId, cubeId, access: "manage" });
      runtime.close();

      const service = createOfflineCredentialService(dataDirectory);
      const operation = verb === "grant"
        ? service.grantClient("Local client", cubeId, "read")
        : verb === "ungrant"
          ? service.ungrantClient("Local client", cubeId)
          : service.revokeClient("Local client");
      let failure: unknown;
      try {
        await operation;
      } catch (error) {
        failure = error;
      }

      const database = new DatabaseSync(bootstrap.paths.database);
      try {
        expect(database.prepare(`
          SELECT client_id, access FROM client_cube_grants WHERE cube_id = ?
        `).all(cubeId)).toEqual([{ client_id: firstId, access: "manage" }]);
        expect(database.prepare(`
          SELECT id FROM clients WHERE revoked_at IS NOT NULL ORDER BY id
        `).all()).toEqual([]);
      } finally {
        database.close();
      }
      expect(failure).toMatchObject({
        message: "Client name is ambiguous. Use one of these selectors: " +
          "aaaaaaaa1, aaaaaaaa2.",
      });
    },
  );

  it.each([
    ["handle", "grant"],
    ["handle", "ungrant"],
    ["handle", "revoke"],
    ["uuid", "grant"],
    ["uuid", "ungrant"],
    ["uuid", "revoke"],
  ] as const)(
    "refuses a name-versus-%s collision before %s can target the wrong client",
    async (namespace, verb) => {
      const parent = await realpath(await mkdtemp(join(
        tmpdir(),
        `borg-operator-${namespace}-${verb}-collision-`,
      )));
      directories.push(parent);
      const dataDirectory = join(parent, "server");
      const bootstrap = await bootstrapServer(dataDirectory);
      const firstId = "aaaaaaaa-1000-4000-8000-000000000001";
      const secondId = "bbbbbbbb-2000-4000-8000-000000000002";
      const selector = namespace === "handle" ? "bbbbbbbb" : secondId;
      const cubeId = "00000000-0000-4000-8000-000000000053";
      const runtime = await openStore({ path: bootstrap.paths.database });
      runtime.maintenance.createClient({ id: firstId, name: selector });
      runtime.maintenance.createClient({ id: secondId, name: "Target client" });
      runtime.maintenance.createCube({ id: cubeId, name: "Collision grant", directive: "" });
      runtime.maintenance.grantClientCube({ clientId: firstId, cubeId, access: "manage" });
      runtime.maintenance.grantClientCube({ clientId: secondId, cubeId, access: "manage" });
      runtime.close();

      const service = createOfflineCredentialService(dataDirectory);
      const operation = verb === "grant"
        ? service.grantClient(selector, cubeId, "read")
        : verb === "ungrant"
          ? service.ungrantClient(selector, cubeId)
          : service.revokeClient(selector);
      let failure: unknown;
      try {
        await operation;
      } catch (error) {
        failure = error;
      }

      const database = new DatabaseSync(bootstrap.paths.database);
      try {
        expect(database.prepare(`
          SELECT client_id, access FROM client_cube_grants
          WHERE cube_id = ? ORDER BY client_id
        `).all(cubeId)).toEqual([
          { client_id: firstId, access: "manage" },
          { client_id: secondId, access: "manage" },
        ]);
        expect(database.prepare(`
          SELECT id FROM clients WHERE revoked_at IS NOT NULL ORDER BY id
        `).all()).toEqual([]);
      } finally {
        database.close();
      }
      expect(failure).toMatchObject({
        message: "Client selector matches more than one client. " +
          (namespace === "handle"
            ? "Use one of these selectors: aaaaaaaa, " +
              "id:bbbbbbbb-2000-4000-8000-000000000002."
            : "Use one of these selectors: aaaaaaaa, bbbbbbbb."),
      });
    },
  );

  it("offers selectors that each resolve the intended cross-namespace candidate", async () => {
    const parent = await realpath(await mkdtemp(join(
      tmpdir(),
      "borg-operator-actionable-collision-",
    )));
    directories.push(parent);
    const dataDirectory = join(parent, "server");
    const bootstrap = await bootstrapServer(dataDirectory);
    const firstId = "aaaaaaaa-1000-4000-8000-000000000001";
    const secondId = "bbbbbbbb-2000-4000-8000-000000000002";
    const cubeId = "00000000-0000-4000-8000-000000000054";
    const runtime = await openStore({ path: bootstrap.paths.database });
    runtime.maintenance.createClient({ id: firstId, name: "bbbbbbbb" });
    runtime.maintenance.createClient({ id: secondId, name: "Target client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Actionable selectors", directive: "" });
    runtime.close();

    const service = createOfflineCredentialService(dataDirectory);
    let failure: unknown;
    try {
      await service.grantClient("bbbbbbbb", cubeId, "read");
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : "";
    const offered = message
      .replace("Client selector matches more than one client. Use one of these selectors: ", "")
      .replace(/\.$/u, "")
      .split(", ");
    await service.grantClient(offered[0]!, cubeId, "read");
    await service.grantClient(offered[1]!, cubeId, "manage");

    const database = new DatabaseSync(bootstrap.paths.database);
    try {
      expect(database.prepare(`
        SELECT client_id, access FROM client_cube_grants
        WHERE cube_id = ? ORDER BY client_id
      `).all(cubeId)).toEqual([
        { client_id: firstId, access: "read" },
        { client_id: secondId, access: "manage" },
      ]);
    } finally {
      database.close();
    }
    expect(offered).toEqual([
      "aaaaaaaa",
      "id:bbbbbbbb-2000-4000-8000-000000000002",
    ]);
  });

  it("uses the current deterministic handle to grant exactly one duplicate-named client", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-handle-client-")));
    directories.push(parent);
    const dataDirectory = join(parent, "server");
    const bootstrap = await bootstrapServer(dataDirectory);
    const firstId = "aaaaaaaa-1000-4000-8000-000000000001";
    const secondId = "aaaaaaaa-2000-4000-8000-000000000002";
    const cubeId = "00000000-0000-4000-8000-000000000052";
    const runtime = await openStore({ path: bootstrap.paths.database });
    runtime.maintenance.createClient({ id: firstId, name: "Local client" });
    runtime.maintenance.createClient({ id: secondId, name: "Local client" });
    runtime.maintenance.createCube({
      id: cubeId,
      name: "Handle\u001b[31m grant",
      directive: "",
    });
    runtime.close();

    const service = createOfflineCredentialService(dataDirectory);
    await service.grantClient("aaaaaaaa1", cubeId, "read");
    expect(await service.listClients()).toEqual(expect.arrayContaining([
      {
        name: "Local client",
        handle: "aaaaaaaa1",
        state: "active",
        grants: [{
          cubeId,
          cubeName: "Handle\u001b[31m grant",
          access: "read",
        }],
      },
      {
        name: "Local client",
        handle: "aaaaaaaa2",
        state: "active",
        grants: [],
      },
    ]));
    const stdout = vi.fn();
    expect(await runCli(
      ["client-list"],
      { start: vi.fn(), ...service },
      { stdout, stderr: vi.fn() },
    )).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(
      `read  Handle grant (${cubeId})`,
    ));
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("\u001b");
    await service.revokeClient("aaaaaaaa1");
    expect(await service.listClients()).toEqual(expect.arrayContaining([{
      name: "Local client",
      handle: "aaaaaaaa1",
      state: "revoked",
      grants: [{
        cubeId,
        cubeName: "Handle\u001b[31m grant",
        access: "read",
      }],
    }]));
    await expect(service.grantClient("aaaaaaaa1", cubeId, "write")).rejects.toThrow(
      "Client exists but is revoked.",
    );
    await expect(service.ungrantClient("aaaaaaaa1", cubeId)).rejects.toThrow(
      "Client exists but is revoked.",
    );
    await expect(service.revokeClient("aaaaaaaa1")).rejects.toThrow(
      "Client exists but is revoked.",
    );
    await expect(service.grantClient("aaaaaaaa", cubeId, "write")).rejects.toThrow(
      "Client handle now matches more than one client. Use one of these selectors: " +
      "aaaaaaaa1, aaaaaaaa2.",
    );
    await expect(service.grantClient("Local client", cubeId, "write")).rejects.toThrow(
      "Client name is ambiguous. Use one of these selectors: aaaaaaaa1, aaaaaaaa2.",
    );
    await expect(service.grantClient("missing client", cubeId, "write")).rejects.toThrow(
      "Provide an existing client name, handle, or ID.",
    );

    const database = new DatabaseSync(bootstrap.paths.database);
    try {
      expect(database.prepare(`
        SELECT client_id, access FROM client_cube_grants WHERE cube_id = ?
      `).all(cubeId)).toEqual([{ client_id: firstId, access: "read" }]);
      expect(database.prepare(
        "SELECT revoked_at FROM clients WHERE id = ?",
      ).get(firstId)).toMatchObject({ revoked_at: expect.any(String) });
      expect(database.prepare(
        "SELECT revoked_at FROM clients WHERE id = ?",
      ).get(secondId)).toEqual({ revoked_at: null });
    } finally {
      database.close();
    }
  });

  it("rotates and revokes a hashed client credential without a listener", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-credential-")));
    directories.push(parent);
    const dataDirectory = join(parent, "server");
    const { ownerCredential } = await bootstrapWithOwner(dataDirectory);
    const credential = generateSecret();
    const enrolled = await withAuthority(dataDirectory, (authority) => {
      const invitation = authority.createInvitationForOwnerCredential(
        ownerCredential,
        60_000,
        "operator",
      )!;
      return authority.exchangeInvitation({
        invitation,
        retryKey: randomUUID(),
        clientCredential: credential,
        clientName: "operator",
      });
    });
    expect(enrolled).not.toBeNull();
    const service = createOfflineCredentialService(dataDirectory);

    const running = await acquireRuntimeLock(dataDirectory, "server", createRuntimeBuildIdentity());
    const rotated = await service.rotateClient(enrolled!.clientId);
    await running.release();

    expect(await withAuthority(dataDirectory, (authority) =>
      authority.authenticate(`Bearer ${credential}`))).toBeNull();
    expect(await withAuthority(dataDirectory, (authority) =>
      authority.authenticate(`Bearer ${rotated}`))).toMatchObject({ kind: "client", id: enrolled!.clientId });

    await service.revokeClient("operator");
    expect(await withAuthority(dataDirectory, (authority) =>
      authority.authenticate(`Bearer ${rotated}`))).toBeNull();
    expect(listen).not.toHaveBeenCalled();
  });

  it("shares request quota across issued sessions and actual client rotation", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-quota-")));
    directories.push(parent);
    const { installation: bootstrap, ownerCredential } = await bootstrapWithOwner(join(parent, "server"));
    const runtime = await openStore({ path: bootstrap.paths.database });
    const digestKey = await loadDigestKey(bootstrap.paths.digestKey);
    const digester = new CredentialDigester(digestKey);
    digestKey.fill(0);
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const credential = generateSecret();
    const invitation = authority.createInvitationForOwnerCredential(ownerCredential, 60_000)!;
    const enrolled = authority.exchangeInvitation({
      invitation,
      retryKey: randomUUID(),
      clientCredential: credential,
      clientName: "quota-client",
    })!;
    const cubeId = "00000000-0000-4000-8000-000000000021";
    const roleId = "00000000-0000-4000-8000-000000000022";
    const sessionCredential = generateSecret();
    runtime.maintenance.createCube({ id: cubeId, name: "Quota cube", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: enrolled.clientId, cubeId, access: "manage" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    const principal = authority.authenticate(`Bearer ${credential}`)!;
    const issued = authority.attachSeat(runtime.forPrincipal(principal), {
      cubeId, roleId, sessionCredential,
    });
    const reissued = authority.attachSeat(runtime.forPrincipal(principal), {
      cubeId, roleId, sessionCredential,
    });
    expect(issued.result).toBe("created");
    expect(reissued).toMatchObject({ result: "reused", sessionId: issued.sessionId });
    expect(authority.authenticate(`Bearer ${sessionCredential}`)).toMatchObject({
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
      authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
      handleCoordination: (coordinationRequest) => coordination.handle(coordinationRequest),
    });
    const ca = await readFile(bootstrap.paths.caCertificate);
    try {
      expect((await request(
        server.origin, ca, "/api/cubes", undefined, `Bearer ${credential}`,
      )).status).toBe(200);
      expect((await request(
        server.origin, ca, "/api/cubes", undefined, `Bearer ${sessionCredential}`,
      )).status).toBe(200);

      const rotated = authority.rotateClient(enrolled.clientId);
      expect(authority.authenticate(`Bearer ${credential}`)).toBeNull();
      expect((await request(
        server.origin, ca, "/api/cubes", undefined, `Bearer ${rotated}`,
      )).status).toBe(200);
      expect(authority.authenticateStatus(`Bearer ${sessionCredential}`)).toBe("revoked");
      const revokedSession = await request(
        server.origin, ca, "/api/cubes", undefined, `Bearer ${sessionCredential}`,
      );
      expect(revokedSession.status).toBe(401);
      expect(JSON.parse(revokedSession.body)).toMatchObject({
        error: { code: "SESSION_REVOKED", message: "Authentication failed." },
      });
    } finally {
      await server.close();
      digester.destroy();
      runtime.close();
    }
  });

  it("bootstraps, enrolls, authenticates, and revokes without cloud access", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-operator-flow-")));
    directories.push(parent);
    let ownerRecord: PortableServerCredential | undefined;
    const bootstrap = await bootstrapServer(
      join(parent, "server"),
      "127.0.0.1",
      () => new Date(),
      async (record) => { ownerRecord = record; },
    );
    if (ownerRecord === undefined) throw new Error("Owner credential was not provisioned.");
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
      authorizeCoordination: async (authorization) => authority.authenticateStatus(authorization),
      exchangeEnrollment: createEnrollmentExchange(authority),
      handleCoordination: (request) => coordination.handle(request),
    });

    try {
      const invitation = authority.createInvitationForOwnerCredential(ownerRecord.credential, 60_000)!;
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
        [`/api/cubes/${authCube}/documents`, "{}", "GET"],
        [`/api/cubes/${authCube}/documents/00000000-0000-4000-8000-000000000099`, "{}", "GET"],
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
          protocol_version: "13",
          request_id: "request-1234",
          payload: {
            invitation,
            retry_key: "00000000-0000-4000-8000-000000000101",
            client_credential: `${"z".repeat(42)}A`,
            client_name: "operator-laptop",
          },
        }),
      );
      expect(enrollment.status).toBe(201);
      const payload = (JSON.parse(enrollment.body) as {
        payload: { client_id: string; purpose: "client"; server_capabilities: [] };
      }).payload;
      const clientCredential = ownerRecord.credential;
      expect(payload).toMatchObject({ purpose: "client", server_capabilities: [] });
      expect(runtime.maintenance.observeAuthorityState()).toMatchObject({ cubes: 0, roles: 0, grants: 0 });
      const creation = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/cubes",
        JSON.stringify({
          protocol_version: "13",
          request_id: "create-1234",
          payload: {
            retry_key: "00000000-0000-4000-8000-000000000102",
            name: "Offline cube",
            working_repo_name: "offline-cube",
            repository: {
              kind: "local",
              value: "00000000-0000-4000-8000-000000000103",
            },
            template: "starter",
          },
        }),
        `Bearer ${clientCredential}`,
      );
      expect(creation.status).toBe(201);
      const created = (JSON.parse(creation.body) as { payload: {
        cube_id: string; default_worker_role_id: string;
      } }).payload;
      const cubeId = created.cube_id;
      const roleId = created.default_worker_role_id;

      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/cubes",
        undefined,
        `Bearer ${clientCredential}`,
      )).status).toBe(200);

      const sessionCredential = generateSecret();
      const attachment = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/client/attach",
        JSON.stringify({
          protocol_version: "13",
          request_id: "attach-1234",
          payload: {
            cube_id: cubeId,
            role_id: roleId,
            session_credential: sessionCredential,
          },
        }),
        `Bearer ${clientCredential}`,
      );
      expect(attachment.status).toBe(200);
      const attached = (JSON.parse(attachment.body) as {
        payload: { result: "created"; session: { id: string } };
      }).payload;
      expect(attached.result).toBe("created");
      expect(attached.session).not.toHaveProperty("token");
      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/cubes",
        undefined,
        `Bearer ${sessionCredential}`,
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
          `Bearer ${clientCredential}`,
        )).status).toBe(200);
      }

      const append = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/logs`,
        JSON.stringify({
          protocol_version: "13",
          request_id: "append-1234",
          payload: { post_id: randomUUID(), message: "offline coordination", to: "broadcast" },
        }),
        `Bearer ${clientCredential}`,
      );
      expect(append.status).toBe(201);
      const read = await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/logs`,
        JSON.stringify({
          protocol_version: "13",
          request_id: "read-12345",
          payload: { cursor: null, limit: 10 },
        }),
        `Bearer ${clientCredential}`,
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
        `Bearer ${clientCredential}`,
      );
      expect(oversized.status).toBe(413);
      expect((JSON.parse(oversized.body) as { error: { code: string } }).error.code)
        .toBe("CONTENT_TOO_LARGE");

      const liveStream = await openEventStream(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/stream`,
        `Bearer ${clientCredential}`,
      );
      authority.revokeClient(ownerRecord.clientId);
      await expect(Promise.race([
        liveStream.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Stream remained open.")), 500)),
      ])).resolves.toBeUndefined();
      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        "/api/cubes",
        undefined,
        `Bearer ${clientCredential}`,
      )).status).toBe(401);
      expect((await request(
        server.origin,
        await readFile(bootstrap.paths.caCertificate),
        `/api/cubes/${cubeId}/stream`,
        undefined,
        `Bearer ${clientCredential}`,
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

async function openScopedCubes(dataDirectory: string, principal: Principal): Promise<string[]> {
  const runtime = await openStore({ path: join(dataDirectory, "borg.db") });
  try {
    return runtime.forPrincipal(principal).listCubes().map((cube) => cube.id);
  } finally {
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

async function bootstrapWithOwner(dataDirectory: string): Promise<{
  readonly installation: Awaited<ReturnType<typeof bootstrapServer>>;
  readonly ownerCredential: string;
}> {
  let ownerCredential: string | undefined;
  const installation = await bootstrapServer(
    dataDirectory,
    "127.0.0.1",
    () => new Date(),
    async (record) => { ownerCredential = record.credential; },
  );
  if (ownerCredential === undefined) throw new Error("Owner credential was not provisioned.");
  return { installation, ownerCredential };
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
