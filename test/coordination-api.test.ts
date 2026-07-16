import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CoordinationApi } from "../src/coordination-api.js";
import {
  CredentialAuthority,
  CredentialDigester,
  LiveCredentialRegistry,
  generateSecret,
} from "../src/credentials.js";
import { openStore, type StoreRuntime } from "../src/store.js";
import { clientPrincipal, droneSessionPrincipal } from "../src/principal.js";

const directories: string[] = [];
let runtime: StoreRuntime | undefined;
let digester: CredentialDigester | undefined;

afterEach(async () => {
  runtime?.close();
  digester?.destroy();
  runtime = undefined;
  digester = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("coordination stream setup", () => {
  it("releases live registrations and listeners when stream setup fails", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 4));
    const registry = new LiveCredentialRegistry();
    const authority = new CredentialAuthority(runtime.credentials, digester, () => new Date(), registry);
    const invitation = authority.createBootstrapInvitation(60_000);
    const credential = generateSecret();
    const enrollment = authority.exchangeInvitation({
      invitation, retryKey: randomUUID(), clientCredential: credential,
    });
    expect(enrollment).not.toBeNull();
    const clientId = enrollment!.clientId;
    const principal = authority.authenticate(`Bearer ${credential}`)!;
    const cubeId = "00000000-0000-4000-8000-000000000021";
    runtime.maintenance.createCube({ id: cubeId, name: "Authorized", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const api = new CoordinationApi(runtime, authority);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await api.handle({
        method: "GET",
        path: "/api/cubes/00000000-0000-4000-8000-000000000022/stream",
        principal,
        signal: new AbortController().signal,
      });
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe("NOT_FOUND");
      expect(registry.activeSessionCount(clientId)).toBe(0);
    }

    const invalidCursor = Buffer.from(JSON.stringify({
      id: "00000000-0000-4000-8000-000000000023",
      created_at: "2026-07-14T13:00:00.000Z",
    })).toString("base64url");
    const invalidReplay = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      principal,
      cursor: invalidCursor,
      signal: new AbortController().signal,
    });
    expect(invalidReplay.status).toBe(404);
    expect(registry.activeSessionCount(clientId)).toBe(0);

  });

  it("rejects bearer-only and caller-forged requests before any operation", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-principal-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 4));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const api = new CoordinationApi(runtime, authority);
    const request = {
      method: "GET",
      path: "/api/cubes",
      authorization: "Bearer arbitrary-caller-value",
      signal: new AbortController().signal,
    };

    // @ts-expect-error Coordination dispatch requires a server-derived principal.
    await expect(api.handle(request)).rejects.toThrow(
      "Principal must be created by the server authentication boundary.",
    );
    await expect(api.handle({
      ...request,
      principal: { kind: "client", id: "00000000-0000-4000-8000-000000000024" },
    } as never)).rejects.toThrow("Principal must be created by the server authentication boundary.");
  });

  it("returns a secret-free capacity error without appending", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-capacity-")));
    directories.push(directory);
    let capacity = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    runtime = await openStore({
      path: join(directory, "borg.db"),
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 10_000,
      },
      capacityProbe: () => capacity,
    });
    digester = new CredentialDigester(Buffer.alloc(32, 5));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const credential = generateSecret();
    const enrollment = authority.exchangeInvitation({
      invitation: authority.createBootstrapInvitation(60_000),
      retryKey: randomUUID(),
      clientCredential: credential,
    })!;
    const principal = authority.authenticate(`Bearer ${credential}`)!;
    const cubeId = "00000000-0000-4000-8000-000000000025";
    runtime.maintenance.createCube({ id: cubeId, name: "Capacity", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: enrollment.clientId, cubeId, access: "manage" });
    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };
    const api = new CoordinationApi(runtime, authority);
    const response = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal,
      body: {
        protocol_version: "1",
        request_id: "capacity-request",
        payload: { message: "secret-capacity-payload" },
      },
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({
      status: 507,
      body: {
        request_id: "capacity-request",
        error: { code: "CAPACITY_EXCEEDED", message: "Storage capacity is unavailable." },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-capacity-payload");
    expect(runtime.forPrincipal(principal).readLog(cubeId, null, 10).entries).toEqual([]);

    const roleResponse = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles`,
      principal,
      body: {
        protocol_version: "1",
        request_id: "capacity-role-request",
        payload: { name: "secret-capacity-role" },
      },
      signal: new AbortController().signal,
    });
    expect(roleResponse).toMatchObject({
      status: 507,
      body: { error: { code: "CAPACITY_EXCEEDED" } },
    });
    expect(JSON.stringify(roleResponse.body)).not.toContain("secret-capacity-role");
    expect(runtime.forPrincipal(principal).listRoles(cubeId)).toEqual([]);
  });

  it("creates full roles only for cube managers and rejects malformed or duplicate requests", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-roles-")));
    directories.push(directory);
    runtime = await openStore({
      path: join(directory, "borg.db"),
      clock: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    digester = new CredentialDigester(Buffer.alloc(32, 6));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const api = new CoordinationApi(runtime, authority);
    const managerId = "00000000-0000-4000-8000-000000000041";
    const readerId = "00000000-0000-4000-8000-000000000042";
    const cubeId = "00000000-0000-4000-8000-000000000043";
    const droneRoleId = "00000000-0000-4000-8000-000000000044";
    const droneId = "00000000-0000-4000-8000-000000000045";
    const sessionId = "00000000-0000-4000-8000-000000000046";
    runtime.maintenance.createClient({ id: managerId, name: "Manager" });
    runtime.maintenance.createClient({ id: readerId, name: "Reader" });
    runtime.maintenance.createCube({ id: cubeId, name: "Roles", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: managerId, cubeId, access: "manage" });
    runtime.maintenance.grantClientCube({ clientId: readerId, cubeId, access: "read" });
    runtime.maintenance.createRole({ id: droneRoleId, cubeId, name: "Queen", roleClass: "queen" });
    runtime.maintenance.createDrone({
      id: droneId, cubeId, roleId: droneRoleId, clientId: managerId, label: "queen-seat",
    });
    runtime.maintenance.createDroneSession({
      id: sessionId,
      clientId: managerId,
      cubeId,
      droneId,
      expiresAt: "2026-07-16T13:00:00.000Z",
    });
    const manager = clientPrincipal(managerId);
    const payload = {
      name: "Security Auditor",
      short_description: "Audits security boundaries",
      detailed_description: "Security workflow:\nReview exact evidence.",
      is_default: true,
      is_mandatory: true,
      is_human_seat: false,
      can_broadcast: true,
      receives_all_direct: true,
    };
    const body = { protocol_version: "1", request_id: "role-create-request", payload };

    const created = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles`,
      principal: manager,
      body,
      signal: new AbortController().signal,
    });
    expect(created).toMatchObject({
      status: 201,
      body: {
        request_id: "role-create-request",
        payload: { role: {
          ...payload,
          cube_id: cubeId,
          role_class: "worker",
        } },
      },
    });
    const createdRoleId = runtime.forPrincipal(manager).listRoles(cubeId)
      .find((role) => role.name === payload.name)!.id;
    const updated = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}`,
      principal: manager,
      body: {
        protocol_version: "1",
        request_id: "role-update-request",
        payload: { name: "Release Quality", is_default: false, is_mandatory: false },
      },
      signal: new AbortController().signal,
    });
    expect(updated).toMatchObject({
      status: 200,
      body: { request_id: "role-update-request", payload: { role: {
        id: createdRoleId,
        name: "Release Quality",
        is_default: false,
        is_mandatory: false,
      } } },
    });
    const patched = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
      principal: manager,
      body: {
        protocol_version: "1",
        request_id: "role-section-request",
        payload: { action: "replace", heading: "Release workflow", body: "Review exact SHA." },
      },
      signal: new AbortController().signal,
    });
    expect(patched).toMatchObject({
      status: 409,
      body: { request_id: "role-section-request", error: { code: "ROLE_SECTION_CONFLICT" } },
    });
    const inserted = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
      principal: manager,
      body: {
        protocol_version: "1",
        request_id: "role-section-insert",
        payload: { action: "insert", heading: "Release workflow", body: "Review exact SHA." },
      },
      signal: new AbortController().signal,
    });
    expect(inserted).toMatchObject({
      status: 200,
      body: { payload: { role: {
        id: createdRoleId,
        detailed_description: expect.stringContaining("Release workflow:\nReview exact SHA.\n"),
      } } },
    });

    for (const principal of [
      clientPrincipal(readerId),
      droneSessionPrincipal({ id: sessionId, clientId: managerId, cubeId, droneId }),
    ]) {
      const denied = await api.handle({
        method: "POST",
        path: `/api/cubes/${cubeId}/roles`,
        principal,
        body: { ...body, request_id: "role-denied-request", payload: { name: "Denied" } },
        signal: new AbortController().signal,
      });
      expect(denied).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
      const updateDenied = await api.handle({
        method: "PATCH",
        path: `/api/cubes/${cubeId}/roles/${createdRoleId}`,
        principal,
        body: { ...body, request_id: "role-update-denied", payload: { name: "Denied" } },
        signal: new AbortController().signal,
      });
      expect(updateDenied).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    }

    const duplicate = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles`,
      principal: manager,
      body: { ...body, payload: { ...payload, name: "Release Quality" } },
      signal: new AbortController().signal,
    });
    expect(duplicate).toMatchObject({
      status: 409,
      body: { request_id: "role-create-request", error: { code: "ROLE_ALREADY_EXISTS" } },
    });
    const malformed = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles`,
      principal: manager,
      body: {
        ...body,
        request_id: "role-invalid-request",
        payload: { ...payload, role_class: "queen" },
      },
      signal: new AbortController().signal,
    });
    expect(malformed).toMatchObject({
      status: 400,
      body: { request_id: "role-invalid-request", error: { code: "INVALID_INPUT" } },
    });
    const emptyUpdate = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}`,
      principal: manager,
      body: { ...body, request_id: "role-update-empty", payload: {} },
      signal: new AbortController().signal,
    });
    expect(emptyUpdate).toMatchObject({
      status: 400,
      body: { request_id: "role-update-empty", error: { code: "INVALID_INPUT" } },
    });
    expect(runtime.forPrincipal(manager).listRoles(cubeId).map((role) => role.name))
      .toEqual(["Queen", "Release Quality"]);
  });
});
