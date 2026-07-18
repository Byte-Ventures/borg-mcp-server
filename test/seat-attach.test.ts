import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoordinationApi } from "../src/coordination-api.js";
import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import { openStore, type StoreRuntime } from "../src/store.js";

const ids = {
  cubeA: "00000000-0000-4000-8000-000000000101",
  cubeB: "00000000-0000-4000-8000-000000000102",
  roleA: "00000000-0000-4000-8000-000000000103",
  roleB: "00000000-0000-4000-8000-000000000104",
} as const;

let directory: string;
let databasePath: string;
let runtime: StoreRuntime;
let digester: CredentialDigester;
let authority: CredentialAuthority;
let api: CoordinationApi;
let now: Date;
let clientA: { readonly clientId: string; readonly credential: string };
let clientB: { readonly clientId: string; readonly credential: string };

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "borg-attach-")));
  databasePath = join(directory, "borg.db");
  now = new Date("2026-07-14T13:00:00.000Z");
  runtime = await openStore({ path: databasePath, clock: () => new Date(now) });
  ({ digester, authority, api } = authorityRuntime(runtime));
  clientA = enroll(authority, "Client A");
  clientB = enroll(authority, "Client B");
  runtime.maintenance.createCube({ id: ids.cubeA, ownerId: clientA.clientId, name: "Cube A", directive: "" });
  runtime.maintenance.createCube({ id: ids.cubeB, ownerId: clientB.clientId, name: "Cube B", directive: "" });
  runtime.maintenance.createRole({ id: ids.roleA, cubeId: ids.cubeA, name: "Builder" });
  runtime.maintenance.createRole({ id: ids.roleB, cubeId: ids.cubeB, name: "Reviewer" });
  runtime.maintenance.grantClientCube({ clientId: clientA.clientId, cubeId: ids.cubeA, access: "manage" });
  runtime.maintenance.grantClientCube({ clientId: clientB.clientId, cubeId: ids.cubeB, access: "manage" });
});

afterEach(async () => {
  runtime.close();
  digester.destroy();
  await rm(directory, { recursive: true, force: true });
});

describe("client seat attach", () => {
  it("creates a digest-bound session without returning its bearer", async () => {
    const sessionCredential = generateSecret();
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-created");

    expect(created).toMatchObject({
      status: 201,
      payload: {
        result: "created",
        cube: { id: ids.cubeA },
        role: { id: ids.roleA },
        session: { id: expect.any(String), expires_at: "2026-07-15T13:00:00.000Z" },
      },
    });
    expect(created.payload.session).not.toHaveProperty("token");
    expect(created.payload.session).not.toHaveProperty("generation");
    expect(created.payload.session).not.toHaveProperty("posture");
    expect(created.payload).not.toHaveProperty("reattached");
    expect(authority.authenticateStatus(`Bearer ${sessionCredential}`)).toMatchObject({
      kind: "drone-session",
      clientId: clientA.clientId,
      cubeId: ids.cubeA,
      droneId: created.payload.drone.id,
    });
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      const bytes = await readFile(path).catch(() => Buffer.alloc(0));
      expect(bytes.includes(Buffer.from(sessionCredential))).toBe(false);
    }
  });

  it("reuses the matching active digest without mutating session identity", async () => {
    const sessionCredential = generateSecret();
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-reuse-1");
    const reused = await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-reuse-2");

    expect(reused).toMatchObject({
      status: 200,
      payload: {
        result: "reused",
        drone: created.payload.drone,
        session: created.payload.session,
      },
    });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
    expect(count("drone_session_credentials")).toBe(1);
  });

  it("recovers a lost first response after restart using only the persisted bearer", async () => {
    const sessionCredential = generateSecret();
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-lost-1");
    runtime.close();
    digester.destroy();
    runtime = await openStore({ path: databasePath, clock: () => new Date(now) });
    ({ digester, authority, api } = authorityRuntime(runtime));

    const recovered = await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-lost-2");
    expect(recovered).toMatchObject({
      status: 200,
      payload: { result: "reused", drone: created.payload.drone, session: created.payload.session },
    });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
  });

  it("serializes concurrent first requests into one creation and one reuse", async () => {
    const sessionCredential = generateSecret();
    const responses = await Promise.all([
      attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-race-1"),
      attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-race-2"),
    ]);

    expect(responses.map((response) => response.payload.result).sort()).toEqual(["created", "reused"]);
    expect(responses[0]!.payload.drone).toEqual(responses[1]!.payload.drone);
    expect(responses[0]!.payload.session).toEqual(responses[1]!.payload.session);
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
  });

  it("rejects a fresh bearer targeting an occupied seat without mutation", async () => {
    const boundCredential = generateSecret();
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, boundCredential, "attach-bound-1");
    const stream = await api.handle({
      method: "GET",
      path: `/api/cubes/${ids.cubeA}/stream`,
      principal: authenticatedPrincipal(boundCredential),
      signal: new AbortController().signal,
    });
    const iterator = stream.stream![Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();

    const rejected = await attach(
      clientA.credential,
      ids.cubeA,
      ids.roleA,
      generateSecret(),
      "attach-bound-2",
      created.payload.drone.id,
    );
    expect(rejected).toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
    expect(authority.authenticateStatus(`Bearer ${boundCredential}`)).toMatchObject({ kind: "drone-session" });

    await api.handle({
      method: "POST",
      path: `/api/cubes/${ids.cubeA}/logs`,
      principal: authenticatedPrincipal(boundCredential),
      body: envelope("append-bound", { message: "still active" }),
      signal: new AbortController().signal,
    });
    await expect(pending).resolves.toMatchObject({ done: false });
    await iterator.return?.();
  });

  it("rejects foreign, expired, and role-mismatched digest reuse", async () => {
    const ownCredential = generateSecret();
    await attach(clientA.credential, ids.cubeA, ids.roleA, ownCredential, "attach-scope-1");
    const foreign = await attach(clientB.credential, ids.cubeB, ids.roleB, ownCredential, "attach-scope-2");
    expect(foreign).toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });

    runtime.maintenance.createRole({ id: randomUUID(), cubeId: ids.cubeA, name: "Other" });
    const otherRoleId = runtime.forPrincipal(authenticatedPrincipal(clientA.credential))
      .listRoles(ids.cubeA).find((role) => role.name === "Other")!.id;
    const roleMismatch = await attach(
      clientA.credential, ids.cubeA, otherRoleId, ownCredential, "attach-scope-3",
    );
    expect(roleMismatch).toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });

    now = new Date("2026-07-15T13:00:00.000Z");
    const expired = await attach(clientA.credential, ids.cubeA, ids.roleA, ownCredential, "attach-scope-4");
    expect(expired).toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });
    expect(count("drones")).toBe(1);
  });

  it("creates a replacement session only after the prior session is no longer active", async () => {
    const firstCredential = generateSecret();
    const first = await attach(clientA.credential, ids.cubeA, ids.roleA, firstCredential, "attach-renew-1");
    now = new Date(first.payload.session.expires_at);
    const nextCredential = generateSecret();
    const renewed = await attach(
      clientA.credential,
      ids.cubeA,
      ids.roleA,
      nextCredential,
      "attach-renew-2",
      first.payload.drone.id,
    );

    expect(renewed).toMatchObject({
      status: 201,
      payload: { result: "created", drone: first.payload.drone },
    });
    expect(renewed.payload.session.id).not.toBe(first.payload.session.id);
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(2);
    expect(authority.authenticateStatus(`Bearer ${nextCredential}`)).toMatchObject({ kind: "drone-session" });
  });

  it("revokes the active session and permits a fresh attach after explicit client rotation", async () => {
    const firstCredential = generateSecret();
    const first = await attach(
      clientA.credential,
      ids.cubeA,
      ids.roleA,
      firstCredential,
      "attach-rotate-1",
    );

    const rotatedClientCredential = authority.rotateClient(clientA.clientId);
    const nextCredential = generateSecret();
    const replacement = await attach(
      rotatedClientCredential,
      ids.cubeA,
      ids.roleA,
      nextCredential,
      "attach-rotate-2",
      first.payload.drone.id,
    );

    expect(authority.authenticateStatus(`Bearer ${firstCredential}`)).toBe("revoked");
    expect(replacement).toMatchObject({
      status: 201,
      payload: { result: "created", drone: first.payload.drone },
    });
    expect(replacement.payload.session.id).not.toBe(first.payload.session.id);
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(2);
  });

  it("rejects an expired prior seat when the requested role does not match", async () => {
    const first = await attach(
      clientA.credential,
      ids.cubeA,
      ids.roleA,
      generateSecret(),
      "attach-prior-role-1",
    );
    runtime.maintenance.createRole({ id: randomUUID(), cubeId: ids.cubeA, name: "Other" });
    const otherRoleId = runtime.forPrincipal(authenticatedPrincipal(clientA.credential))
      .listRoles(ids.cubeA).find((role) => role.name === "Other")!.id;
    now = new Date(first.payload.session.expires_at);

    const rejected = await attach(
      clientA.credential,
      ids.cubeA,
      otherRoleId,
      generateSecret(),
      "attach-prior-role-2",
      first.payload.drone.id,
    );

    expect(rejected).toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
  });

  it("keeps reuse streams live and closes them on explicit parent revocation", async () => {
    const sessionCredential = generateSecret();
    await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-stream-1");
    const stream = await api.handle({
      method: "GET",
      path: `/api/cubes/${ids.cubeA}/stream`,
      principal: authenticatedPrincipal(sessionCredential),
      signal: new AbortController().signal,
    });
    const iterator = stream.stream![Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();

    await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-stream-2");
    await api.handle({
      method: "POST",
      path: `/api/cubes/${ids.cubeA}/logs`,
      principal: authenticatedPrincipal(sessionCredential),
      body: envelope("append-stream", { message: "reuse did not close stream" }),
      signal: new AbortController().signal,
    });
    await expect(pending).resolves.toMatchObject({ done: false });

    const closed = iterator.next();
    authority.revokeClient(clientA.clientId);
    await expect(closed).resolves.toMatchObject({ done: true });
  });

  it("rejects the old protocol tag before creating attachment state", async () => {
    const response = await api.handle({
      method: "POST",
      path: "/api/client/attach",
      principal: authenticatedPrincipal(clientA.credential),
      body: {
        protocol_version: "1",
        request_id: "attach-version-old",
        payload: {
          cube_id: ids.cubeA,
          role_id: ids.roleA,
          session_credential: generateSecret(),
        },
      },
      signal: new AbortController().signal,
    });
    expect(response).toMatchObject({
      status: 426,
      body: {
        protocol_version: "2",
        request_id: "attach-version-old",
        error: {
          code: "UNSUPPORTED_PROTOCOL_VERSION",
          message: "Unsupported protocol version.",
        },
      },
    });
    expect(count("drones")).toBe(0);
    expect(count("drone_sessions")).toBe(0);
  });
});

function authorityRuntime(store: StoreRuntime) {
  const nextDigester = new CredentialDigester(Buffer.alloc(32, 6));
  const nextAuthority = new CredentialAuthority(store.credentials, nextDigester, () => new Date(now));
  return {
    digester: nextDigester,
    authority: nextAuthority,
    api: new CoordinationApi(store, nextAuthority),
  };
}

function enroll(nextAuthority: CredentialAuthority, name: string) {
  const recovery = nextAuthority.createRecoveryCredential();
  const invitation = nextAuthority.createInvitation(recovery, 60_000);
  if (invitation === null) throw new Error("Invitation failed.");
  const credential = generateSecret();
  const enrollment = nextAuthority.exchangeInvitation({
    invitation,
    retryKey: randomUUID(),
    clientCredential: credential,
    clientName: name,
  });
  if (enrollment === null) throw new Error("Enrollment failed.");
  return { clientId: enrollment.clientId, credential };
}

async function attach(
  parentCredential: string,
  cubeId: string,
  roleId: string,
  sessionCredential: string,
  requestId: string,
  priorDroneId?: string,
): Promise<{
  readonly status: number;
  readonly payload: {
    readonly result: "created" | "reused";
    readonly cube: { readonly id: string; readonly name: string };
    readonly role: { readonly id: string; readonly name: string };
    readonly drone: { readonly id: string; readonly label: string };
    readonly session: { readonly id: string; readonly expires_at: string };
  };
  readonly error?: { readonly code: string };
}> {
  const response = await api.handle({
    method: "POST",
    path: "/api/client/attach",
    principal: authenticatedPrincipal(parentCredential),
    body: envelope(requestId, {
      cube_id: cubeId,
      role_id: roleId,
      session_credential: sessionCredential,
      ...(priorDroneId === undefined ? {} : { prior_drone_id: priorDroneId }),
    }),
    signal: new AbortController().signal,
  });
  const body = response.body as { payload?: unknown; error?: { code: string } };
  return {
    status: response.status,
    payload: body.payload as Awaited<ReturnType<typeof attach>>["payload"],
    ...(body.error === undefined ? {} : { error: body.error }),
  };
}

function authenticatedPrincipal(credential: string) {
  const principal = authority.authenticate(`Bearer ${credential}`);
  if (principal === null) throw new Error("Test credential did not authenticate.");
  return principal;
}

function envelope(requestId: string, payload: Record<string, unknown>) {
  return { protocol_version: "2", request_id: requestId, payload };
}

function count(table: "drones" | "drone_sessions" | "drone_session_credentials"): number {
  const database = new DatabaseSync(databasePath);
  try {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    database.close();
  }
}
