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
import { createDebugLogger, disabledDebugLogger } from "../src/debug-log.js";

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
  it("drains every replay page before switching to live delivery", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-replay-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 3));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-000000000071";
    const clientId = "00000000-0000-4000-8000-000000000072";
    runtime.maintenance.createClient({ id: clientId, name: "Replay client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Replay", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const principal = clientPrincipal(clientId);
    const store = runtime.forPrincipal(principal);
    for (let index = 0; index < 425; index += 1) {
      store.appendLog(cubeId, { message: `replay-${index}` });
    }
    const api = new CoordinationApi(runtime, authority);
    const barrier = api.armReplayTransition();
    const opening = api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      principal,
      signal: new AbortController().signal,
    });
    await barrier.reached;
    store.appendLog(cubeId, { message: "replay-boundary" });
    barrier.release();

    const response = await opening;
    const iterator = response.stream![Symbol.asyncIterator]();
    const messages: string[] = [];
    for (;;) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (next.value.includes("event: bookmark")) break;
      const data = JSON.parse(next.value.match(/data: (.+)\n\n/u)![1]!);
      messages.push(data.entry.message);
    }

    expect(messages).toEqual([
      ...Array.from({ length: 425 }, (_, index) => `replay-${index}`),
      "replay-boundary",
    ]);
    await iterator.return?.();
  });

  it("emits heartbeat events while a live stream is idle", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-heartbeat-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 2));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-000000000073";
    const clientId = "00000000-0000-4000-8000-000000000074";
    runtime.maintenance.createClient({ id: clientId, name: "Heartbeat client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Heartbeat", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const api = new CoordinationApi(runtime, authority, disabledDebugLogger, 10);
    const response = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      principal: clientPrincipal(clientId),
      signal: new AbortController().signal,
    });
    const iterator = response.stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value).toContain("event: bookmark");
    const heartbeat = (await iterator.next()).value!;
    expect(heartbeat).toContain("event: heartbeat");
    expect(JSON.parse(heartbeat.match(/data: (.+)\n\n/u)![1]!)).toEqual({
      ts: expect.any(String),
    });
    await iterator.return?.();
  });

  it("attaches read grants as observers and excludes them from directed work", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-observer-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 12));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const api = new CoordinationApi(runtime, authority);
    const cubeId = "00000000-0000-4000-8000-000000000061";
    const roleId = "00000000-0000-4000-8000-000000000062";
    const observerClientId = "00000000-0000-4000-8000-000000000063";
    const participantClientId = "00000000-0000-4000-8000-000000000064";
    runtime.maintenance.createClient({ id: observerClientId, name: "Observer" });
    runtime.maintenance.createClient({ id: participantClientId, name: "Participant" });
    runtime.maintenance.createCube({ id: cubeId, name: "Postures", directive: "" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    runtime.maintenance.grantClientCube({ clientId: observerClientId, cubeId, access: "read" });
    runtime.maintenance.grantClientCube({ clientId: participantClientId, cubeId, access: "write" });
    const observerClient = clientPrincipal(observerClientId);
    const participantClient = clientPrincipal(participantClientId);

    const attach = async (
      principal: ReturnType<typeof clientPrincipal>,
      requestId: string,
      sessionCredential: string,
    ) => api.handle({
      method: "POST",
      path: "/api/client/attach",
      principal,
      body: {
        protocol_version: "2",
        request_id: requestId,
        payload: { cube_id: cubeId, role_id: roleId, session_credential: sessionCredential },
      },
      signal: new AbortController().signal,
    });
    const observerSessionCredential = generateSecret();
    const participantSessionCredential = generateSecret();
    const observerAttach = await attach(observerClient, "observer-attach", observerSessionCredential);
    const participantAttach = await attach(
      participantClient,
      "participant-attach",
      participantSessionCredential,
    );
    expect(observerAttach).toMatchObject({
      status: 201,
      body: { payload: { result: "created", session: { id: expect.any(String) } } },
    });
    expect(participantAttach).toMatchObject({
      status: 201,
      body: { payload: { result: "created", session: { id: expect.any(String) } } },
    });
    const observerPayload = (observerAttach.body as any).payload;
    const participantPayload = (participantAttach.body as any).payload;
    const observerSession = authority.authenticate(`Bearer ${observerSessionCredential}`)!;
    const participantSession = authority.authenticate(`Bearer ${participantSessionCredential}`)!;

    const cubes = await api.handle({
      method: "GET",
      path: "/api/cubes",
      principal: observerSession,
      signal: new AbortController().signal,
    });
    expect(cubes).toMatchObject({
      status: 200,
      body: { payload: { cubes: [expect.objectContaining({ id: cubeId })] } },
    });
    const roles = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/roles`,
      principal: observerSession,
      signal: new AbortController().signal,
    });
    expect(roles).toMatchObject({
      status: 200,
      body: { payload: { roles: [expect.objectContaining({ id: roleId })] } },
    });

    const drones = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: observerSession,
      signal: new AbortController().signal,
    });
    expect((drones.body as any).payload.drones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: observerPayload.drone.id, posture: "observer" }),
      expect.objectContaining({ id: participantPayload.drone.id, posture: "participant" }),
    ]));

    const observerPost = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal: observerSession,
      body: {
        protocol_version: "2",
        request_id: "observer-post",
        payload: { message: "denied" },
      },
      signal: new AbortController().signal,
    });
    expect(observerPost.status).toBe(404);
    const observerManage = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles`,
      principal: observerSession,
      body: {
        protocol_version: "2",
        request_id: "observer-manage",
        payload: { name: "Denied" },
      },
      signal: new AbortController().signal,
    });
    expect(observerManage.status).toBe(404);

    const observerController = new AbortController();
    const participantController = new AbortController();
    const observerStream = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      principal: observerSession,
      signal: observerController.signal,
    });
    const participantStream = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      principal: participantSession,
      signal: participantController.signal,
    });
    const observerIterator = observerStream.stream![Symbol.asyncIterator]();
    const participantIterator = participantStream.stream![Symbol.asyncIterator]();
    expect((await observerIterator.next()).value).toContain("event: bookmark");
    expect((await participantIterator.next()).value).toContain("event: bookmark");

    const observerTarget = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal: participantSession,
      body: {
        protocol_version: "2",
        request_id: "observer-target",
        payload: {
          message: "must-not-arrive",
          visibility: "direct",
          recipientDroneIds: [observerPayload.drone.id],
        },
      },
      signal: new AbortController().signal,
    });
    expect(observerTarget.status).toBe(404);
    const directed = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal: participantSession,
      body: {
        protocol_version: "2",
        request_id: "participant-target",
        payload: {
          message: "participant-work",
          visibility: "direct",
          recipientDroneIds: [participantPayload.drone.id],
        },
      },
      signal: new AbortController().signal,
    });
    expect(directed.status).toBe(201);
    expect((await participantIterator.next()).value).toContain("participant-work");
    const directedEntryId = (directed.body as any).payload.entry.id;
    for (const kind of ["ack", "claim"] as const) {
      const acknowledgement = await api.handle({
        method: "POST",
        path: `/api/cubes/${cubeId}/acks`,
        principal: observerSession,
        body: {
          protocol_version: "2",
          request_id: `observer-${kind}`,
          payload: { entry_id: directedEntryId, kind },
        },
        signal: new AbortController().signal,
      });
      expect(acknowledgement.status).toBe(404);
    }
    const broadcast = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal: participantSession,
      body: {
        protocol_version: "2",
        request_id: "participant-broadcast",
        payload: { message: "shared-update" },
      },
      signal: new AbortController().signal,
    });
    expect(broadcast.status).toBe(201);
    const observerWake = (await observerIterator.next()).value!;
    expect(observerWake).toContain("shared-update");
    expect(observerWake).not.toContain("participant-work");

    const observerRead = await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal: observerSession,
      body: {
        protocol_version: "2",
        request_id: "observer-read",
        payload: { cursor: null },
      },
      signal: new AbortController().signal,
    });
    expect(observerRead.status).toBe(200);
    expect((observerRead.body as any).payload.entries.map((entry: any) => entry.message))
      .toEqual(["shared-update"]);
    observerController.abort();
    participantController.abort();
    await observerIterator.return?.();
    await participantIterator.return?.();
  });

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

  it("returns a clear protocol mismatch before cube creation mutation", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-version-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 5));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const credential = generateSecret();
    authority.exchangeInvitation({
      invitation: authority.createBootstrapInvitation(60_000),
      retryKey: randomUUID(),
      clientCredential: credential,
    });
    const principal = authority.authenticate(`Bearer ${credential}`)!;
    const api = new CoordinationApi(runtime, authority);

    const response = await api.handle({
      method: "POST",
      path: "/api/cubes",
      principal,
      body: {
        protocol_version: "1",
        request_id: "cube-version-old",
        payload: { retry_key: randomUUID(), name: "Must not exist", template: "default" },
      },
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({
      status: 426,
      body: {
        protocol_version: "2",
        request_id: "cube-version-old",
        error: {
          code: "UNSUPPORTED_PROTOCOL_VERSION",
          message: "Unsupported protocol version.",
        },
      },
    });
    expect(runtime.maintenance.observeAuthorityState().cubes).toBe(0);
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
        protocol_version: "2",
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
        protocol_version: "2",
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
    const malformedRoleId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (const [method, suffix, payload] of [
      ["PATCH", "", { name: "Malformed" }],
      ["POST", "/section-patch", { action: "delete", heading: "Workflow" }],
    ] as const) {
      const malformedRole = await api.handle({
        method,
        path: `/api/cubes/${cubeId}/roles/${malformedRoleId}${suffix}`,
        principal: manager,
        body: {
          protocol_version: "2",
          request_id: "malformed-role-id",
          payload,
        },
        signal: new AbortController().signal,
      });
      expect(malformedRole).toMatchObject({
        status: 404,
        body: { error: { code: "NOT_FOUND" } },
      });
    }
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
    const body = { protocol_version: "2", request_id: "role-create-request", payload };

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
    const demoted = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}`,
      principal: manager,
      body: {
        protocol_version: "2",
        request_id: "role-demote-request",
        payload: { is_default: false },
      },
      signal: new AbortController().signal,
    });
    expect(demoted).toMatchObject({
      status: 409,
      body: { request_id: "role-demote-request", error: { code: "DEFAULT_ROLE_REQUIRED" } },
    });
    const updated = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}`,
      principal: manager,
      body: {
        protocol_version: "2",
        request_id: "role-update-request",
        payload: { name: "Release Quality", is_mandatory: false },
      },
      signal: new AbortController().signal,
    });
    expect(updated).toMatchObject({
      status: 200,
      body: { request_id: "role-update-request", payload: { role: {
        id: createdRoleId,
        name: "Release Quality",
        is_default: true,
        is_mandatory: false,
      } } },
    });
    const patched = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
      principal: manager,
      body: {
        protocol_version: "2",
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
        protocol_version: "2",
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

  it("logs coordination routing and stream semantics without content bodies", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-debug-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 11));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const lines: string[] = [];
    const api = new CoordinationApi(
      runtime,
      authority,
      createDebugLogger((line) => lines.push(line)),
    );
    const clientId = "00000000-0000-4000-8000-000000000051";
    const cubeId = "00000000-0000-4000-8000-000000000052";
    const roleId = "00000000-0000-4000-8000-000000000053";
    const droneId = "00000000-0000-4000-8000-000000000054";
    runtime.maintenance.createClient({ id: clientId, name: "Debug manager" });
    runtime.maintenance.createCube({ id: cubeId, name: "Debug cube", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    runtime.maintenance.createDrone({ id: droneId, cubeId, roleId, clientId, label: "builder-one" });
    const principal = clientPrincipal(clientId);
    const signal = new AbortController().signal;
    const message = "secret-message-body";
    const decisionText = "secret-decision-body";

    const appended = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal,
      body: {
        protocol_version: "2",
        request_id: "debug-append-request",
        payload: { message, visibility: "direct", recipientDroneIds: [droneId] },
      },
      signal,
    });
    const entryId = (appended.body as any).payload.entry.id as string;
    await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal,
      body: {
        protocol_version: "2",
        request_id: "debug-replay-request",
        payload: { cursor: null },
      },
      signal,
    });
    await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/acks`,
      principal,
      body: {
        protocol_version: "2",
        request_id: "debug-ack-request",
        payload: { entry_id: entryId, kind: "ack" },
      },
      signal,
    });
    await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/decisions`,
      principal,
      body: {
        protocol_version: "2",
        request_id: "debug-decision-request",
        payload: { topic: "secret-topic", decision: decisionText, rationale: "secret-rationale" },
      },
      signal,
    });
    const streamed = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      principal,
      signal,
    });
    const iterator = streamed.stream![Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    const output = lines.join("\n");
    for (const secret of [message, decisionText, "secret-topic", "secret-rationale", "debug-append-request"]) {
      expect(output).not.toContain(secret);
    }
    const events = lines.map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      event: "activity_append",
      visibility: "direct",
      recipient_count: 1,
      recipient_drone_ids: [droneId],
    }));
    expect(events).toContainEqual(expect.objectContaining({ event: "cursor_replay", mode: "page" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "ack_write", entry_id: entryId }));
    expect(events).toContainEqual(expect.objectContaining({ event: "decision_write" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "sse_subscribe", replay_count: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ event: "sse_unsubscribe", delivery_count: 1 }));
  });
});
