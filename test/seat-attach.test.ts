import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACH_RECONCILE_PATH,
  decodeAttachResponseEnvelope,
  decodeReconcileAttachmentResponseEnvelope,
  deriveAttachmentReceipt,
  type ReconcileAttachmentAction,
} from "borgmcp-shared/protocol";

import { CoordinationApi } from "../src/coordination-api.js";
import {
  CredentialAuthority,
  CredentialDigester,
  generateSecret,
} from "../src/credentials.js";
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
  clientB = enroll(authority, "Client B", clientA.credential);
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
      status: 200,
      payload: {
        result: "created",
        cube: { id: ids.cubeA },
        role: { id: ids.roleA },
        session: { id: expect.any(String) },
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

  it("keeps a human-seat role singly occupied until its current holder is evicted", async () => {
    const humanRoleId = randomUUID();
    runtime.maintenance.createRole({
      id: humanRoleId,
      cubeId: ids.cubeA,
      name: "Coordinator",
      isHumanSeat: true,
    });
    runtime.maintenance.grantClientCube({
      clientId: clientB.clientId,
      cubeId: ids.cubeA,
      access: "manage",
    });
    const firstCredential = generateSecret();
    const first = await attach(
      clientA.credential,
      ids.cubeA,
      humanRoleId,
      firstCredential,
      "attach-human-first",
    );
    const reused = await attach(
      clientA.credential,
      ids.cubeA,
      humanRoleId,
      firstCredential,
      "attach-human-reused",
    );
    expect(reused).toMatchObject({
      status: 200,
      payload: { result: "reused", drone: first.payload.drone, session: first.payload.session },
    });

    const refusedCredential = generateSecret();
    const refused = await attach(
      clientB.credential,
      ids.cubeA,
      humanRoleId,
      refusedCredential,
      "attach-human-refused",
    );
    expect(refused).toMatchObject({
      status: 409,
      error: {
        code: "ROLE_IN_USE",
        message: `The human-seat role is already occupied by ${first.payload.drone.label}.`,
      },
    });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
    expect(authority.authenticateStatus(`Bearer ${refusedCredential}`)).toBe("invalid");

    runtime.forPrincipal(authenticatedPrincipal(clientA.credential))
      .evictDrone(ids.cubeA, first.payload.drone.id);
    const replacementCredential = generateSecret();
    const replacement = await attach(
      clientB.credential,
      ids.cubeA,
      humanRoleId,
      replacementCredential,
      "attach-human-replacement",
    );
    expect(replacement).toMatchObject({ status: 200, payload: { result: "created" } });
    expect(authority.authenticateStatus(`Bearer ${replacementCredential}`)).toMatchObject({
      kind: "drone-session",
      clientId: clientB.clientId,
      cubeId: ids.cubeA,
    });
  });

  it("keeps eviction and revocation distinct while time never expires a session", async () => {
    const revokedCredential = generateSecret();
    const revoked = await attach(
      clientA.credential, ids.cubeA, ids.roleA, revokedCredential, "attach-revoked",
    );
    runtime.maintenance.revokeDroneSession(revoked.payload.session.id);

    const evictedCredential = generateSecret();
    const evicted = await attach(
      clientA.credential, ids.cubeA, ids.roleA, evictedCredential, "attach-evicted",
    );
    runtime.maintenance.revokeDroneSession(evicted.payload.session.id);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE drones SET evicted_at = ? WHERE id = ?")
      .run("2026-07-14T13:01:00.000Z", evicted.payload.drone.id);
    database.close();

    const longLivedCredential = generateSecret();
    await attach(clientA.credential, ids.cubeA, ids.roleA, longLivedCredential, "attach-long-lived");
    now = new Date("2026-07-15T13:00:01.000Z");

    expect(authority.authenticateStatus(`Bearer ${revokedCredential}`)).toBe("revoked");
    expect(authority.authenticateStatus(`Bearer ${evictedCredential}`)).toBe("evicted");
    expect(authority.authenticateStatus(`Bearer ${longLivedCredential}`)).toMatchObject({
      kind: "drone-session",
    });
  });

  it("reuses the matching active digest without mutating session identity", async () => {
    const sessionCredential = generateSecret();
    const initial = runtime.forPrincipal(authenticatedPrincipal(clientA.credential)).appendLog(ids.cubeA, { visibility: "broadcast",
      message: "before attach",
    });
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-reuse-1");
    runtime.forPrincipal(authenticatedPrincipal(clientA.credential)).appendLog(ids.cubeA, { visibility: "broadcast",
      message: "after attach",
    });
    now = new Date("2126-07-14T13:00:00.000Z");
    const reused = await attach(clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-reuse-2");

    expect(reused).toMatchObject({
      status: 200,
      payload: {
        result: "reused",
        drone: created.payload.drone,
        session: { id: created.payload.session.id },
        initial_log_cursor: { id: initial.id, created_at: initial.created_at },
      },
    });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
    expect(count("drone_session_credentials")).toBe(1);

    now = new Date(now.getTime() + 1);
    const lostResponseRetry = await attach(
      clientA.credential,
      ids.cubeA,
      ids.roleA,
      sessionCredential,
      "attach-reuse-3",
      created.payload.drone.id,
    );
    expect(lostResponseRetry).toMatchObject({
      status: 200,
      payload: { result: "reused", drone: created.payload.drone, session: reused.payload.session },
    });
    expect(lostResponseRetry.payload.initial_log_cursor).toEqual(created.payload.initial_log_cursor);
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

  it("rejects foreign and role-mismatched digest reuse without time expiry", async () => {
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

    now = new Date("2126-07-15T13:00:00.000Z");
    const reused = await attach(clientA.credential, ids.cubeA, ids.roleA, ownCredential, "attach-scope-4");
    expect(reused).toMatchObject({ status: 200, payload: { result: "reused" } });
    expect(count("drones")).toBe(1);
  });

  it("never replaces an active prior session because time elapsed", async () => {
    const firstCredential = generateSecret();
    const first = await attach(clientA.credential, ids.cubeA, ids.roleA, firstCredential, "attach-renew-1");
    now = new Date("2126-07-15T13:00:00.000Z");
    const nextCredential = generateSecret();
    const rejected = await attach(
      clientA.credential,
      ids.cubeA,
      ids.roleA,
      nextCredential,
      "attach-renew-2",
      first.payload.drone.id,
    );

    expect(rejected).toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
    expect(authority.authenticateStatus(`Bearer ${firstCredential}`)).toMatchObject({
      kind: "drone-session",
    });
    expect(authority.authenticateStatus(`Bearer ${nextCredential}`)).toBe("invalid");
  });

  it("keeps an explicitly revoked seat terminal after client rotation", async () => {
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
      status: 401,
      error: { code: "SESSION_REVOKED" },
    });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
  });

  it("never creates a replacement for a missing or evicted prior seat", async () => {
    const missing = await attach(
      clientA.credential,
      ids.cubeA,
      ids.roleA,
      generateSecret(),
      "attach-missing-prior",
      randomUUID(),
    );
    expect(missing).toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });
    expect(count("drones")).toBe(0);

    const created = await attach(
      clientA.credential, ids.cubeA, ids.roleA, generateSecret(), "attach-before-eviction",
    );
    runtime.forPrincipal(authenticatedPrincipal(clientA.credential))
      .evictDrone(ids.cubeA, created.payload.drone.id);
    const evicted = await attach(
      clientA.credential,
      ids.cubeA,
      ids.roleA,
      generateSecret(),
      "attach-evicted-prior",
      created.payload.drone.id,
    );
    expect(evicted).toMatchObject({ status: 410, error: { code: "DRONE_EVICTED" } });
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
  });

  it("preserves the same directed recipient and unread entry far beyond the old session TTL", async () => {
    const sessionCredential = generateSecret();
    const created = await attach(
      clientA.credential, ids.cubeA, ids.roleA, sessionCredential, "attach-long-lived-1",
    );

    for (let reuse = 0; reuse < 3; reuse += 1) {
      now = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1_000);
      const response = await attach(
        clientA.credential,
        ids.cubeA,
        ids.roleA,
        sessionCredential,
        `attach-long-lived-${reuse + 2}`,
        created.payload.drone.id,
      );
      expect(response).toMatchObject({
        status: 200,
        payload: { result: "reused", drone: created.payload.drone },
      });
    }

    const renewedPrincipal = authenticatedPrincipal(sessionCredential);
    const stream = await api.handle({
      method: "GET",
      path: `/api/cubes/${ids.cubeA}/stream`,
      principal: renewedPrincipal,
      signal: new AbortController().signal,
    });
    const iterator = stream.stream![Symbol.asyncIterator]();
    await iterator.next();
    const wake = iterator.next();
    const clientStore = runtime.forPrincipal(authenticatedPrincipal(clientA.credential));
    clientStore.appendLog(ids.cubeA, {
      message: "directed after centuries",
      visibility: "direct",
      recipientDroneIds: [created.payload.drone.id],
    });
    await expect(wake).resolves.toMatchObject({ done: false });
    await iterator.return?.();
    const sessionStore = runtime.forPrincipal(renewedPrincipal);
    const unread = sessionStore.readLog(ids.cubeA, null, 100);
    expect(unread.entries.filter((entry) => entry.message === "directed after centuries"))
      .toHaveLength(1);
    expect(count("drones")).toBe(1);
    expect(count("drone_sessions")).toBe(1);
  });

  it("rejects a prior seat when the requested role does not match", async () => {
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
      body: envelope("append-stream", { post_id: randomUUID(), message: "reuse did not close stream" }),
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
        protocol_version: "14",
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
        protocol_version: "15",
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

describe("pending attachment reconciliation", () => {
  it("persists exact session/cursor through restart, finalize retry and ordinary bearer reuse", async () => {
    const bearer = generateSecret();
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "receipt-created");
    const expected = { disposition: "accepted", drone_id: created.payload.drone.id, session_id: created.payload.session.id };
    expect(await reconcile(bearer, "inspect")).toMatchObject({ status: 200, payload: expected });
    runtime.close();
    digester.destroy();
    runtime = await openStore({ path: databasePath, clock: () => new Date(now) });
    ({ digester, authority, api } = authorityRuntime(runtime));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await reconcile(bearer, "finalize")).toMatchObject({ status: 200, payload: { ...expected, disposition: "finalized" } });
    }
    expect(await reconcile(bearer, "retire")).toMatchObject({ status: 409, error: { code: "ATTACHMENT_FINALIZED" } });
    const reused = await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "receipt-reuse", created.payload.drone.id);
    expect(reused.payload).toEqual({ ...created.payload, result: "reused" });
    expect(count("drone_sessions")).toBe(1);
  });

  it.each([false, true])("retirement survives restart and fences a delayed attach (accepted=%s)", async (accepted) => {
    const bearer = generateSecret();
    if (accepted) await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "retirement-created");
    else expect(await reconcile(bearer, "inspect")).toMatchObject({ status: 200, payload: { disposition: "absent" } });
    expect(await reconcile(bearer, "retire")).toMatchObject({ status: 200, payload: { disposition: "retired" } });
    runtime.close();
    digester.destroy();
    runtime = await openStore({ path: databasePath, clock: () => new Date(now) });
    ({ digester, authority, api } = authorityRuntime(runtime));
    expect(await reconcile(bearer, "retire")).toMatchObject({ status: 200, payload: { disposition: "retired" } });
    expect(await reconcile(bearer, "inspect")).toMatchObject({ status: 200, payload: { disposition: "retired" } });
    expect(await reconcile(bearer, "finalize")).toMatchObject({ status: 409, error: { code: "ATTACHMENT_RETIRED" } });
    expect(await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "retirement-late"))
      .toMatchObject({ status: 409, error: { code: "ATTACHMENT_RETIRED" } });
    expect(await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "retirement-wrong-prior", randomUUID()))
      .toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });
    expect(authority.authenticate(`Bearer ${bearer}`)).toBeNull();
    expect(count("drone_sessions")).toBe(accepted ? 1 : 0);
  });

  it("isolates foreign receipts and cancellation fences by authenticated parent", async () => {
    const bearer = generateSecret();
    runtime.maintenance.grantClientCube({ clientId: clientB.clientId, cubeId: ids.cubeA, access: "read" });
    // A different parent's pre-admission cancellation must not fence the original parent's POST.
    expect(await reconcile(bearer, "retire", { credential: clientB.credential })).toMatchObject({ status: 200 });
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "foreign-created");
    expect(created.status).toBe(200);
    expect(await reconcile(bearer, "retire", { credential: clientB.credential })).toMatchObject({ status: 200 });
    expect(authority.authenticate(`Bearer ${bearer}`)).not.toBeNull();
    const other = generateSecret();
    await attach(clientA.credential, ids.cubeA, ids.roleA, other, "foreign-known");
    for (const action of ["inspect", "finalize", "retire"] as const) {
      expect(await reconcile(other, action, { credential: clientB.credential })).toMatchObject({ status: 404 });
    }
    expect(await reconcile(other, "inspect")).toMatchObject({ status: 200, payload: { disposition: "accepted" } });
  });

  it("checks original prior absence and current grant for every action without changing state", async () => {
    const bearer = generateSecret();
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "tuple-created");
    for (const action of ["inspect", "finalize", "retire"] as const) {
      expect(await reconcile(bearer, action, { prior: created.payload.drone.id }))
        .toMatchObject({ status: 401, error: { code: "SESSION_REJECTED" } });
    }
    const principal = authenticatedPrincipal(clientA.credential);
    const store = runtime.forPrincipal(principal);
    const receipt = await deriveAttachmentReceipt(bearer);
    runtime.maintenance.removeClientCubeGrant(clientA.clientId, ids.cubeA);
    for (const action of ["inspect", "finalize", "retire"] as const) {
      expect(() => store.reconcileAttachment({ receipt, cube_id: ids.cubeA, role_id: ids.roleA, action })).toThrow();
    }
    runtime.maintenance.grantClientCube({ clientId: clientA.clientId, cubeId: ids.cubeA, access: "read" });
    expect(await reconcile(bearer, "inspect")).toMatchObject({ payload: { disposition: "accepted" } });
    // Pending retirement is deliberately available to the owning read-granted parent, not general eviction.
    expect(() => store.evictDrone(ids.cubeA, created.payload.drone.id)).toThrow();
    expect(await reconcile(bearer, "retire")).toMatchObject({ status: 200 });
  });

  it.each(["revoked", "evicted", "superseded"] as const)("refuses externally %s sessions, including repeated finalized ACK", async (terminal) => {
    const bearer = generateSecret();
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "terminal-created");
    await reconcile(bearer, "finalize");
    const sessionId = created.payload.session.id;
    if (terminal === "revoked") runtime.maintenance.revokeDroneSession(sessionId);
    else if (terminal === "evicted") runtime.forPrincipal(authenticatedPrincipal(clientA.credential)).evictDrone(ids.cubeA, created.payload.drone.id);
    else withDatabase((db) => db.prepare("UPDATE drone_sessions SET superseded_at = ? WHERE id = ?").run(now.toISOString(), sessionId));
    const expected = terminal === "evicted" ? "DRONE_EVICTED" : terminal === "revoked" ? "SESSION_REVOKED" : "SESSION_REJECTED";
    for (const action of ["inspect", "finalize", "retire"] as const) {
      expect(await reconcile(bearer, action)).toMatchObject({ error: { code: expected } });
    }
    expect(await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "terminal-retry"))
      .toMatchObject({ error: { code: expected } });
  });

  it("rolls back attachment and retirement when SQLite fails partway through either transaction", async () => {
    const bearer = generateSecret();
    withDatabase((db) => db.exec(`CREATE TRIGGER fail_attachment BEFORE INSERT ON attachment_operations
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`));
    await expect(attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "rollback-create")).rejects.toThrow("fixture failure");
    expect(count("drones")).toBe(0);
    expect(count("drone_sessions")).toBe(0);
    expect(count("drone_session_credentials")).toBe(0);
    withDatabase((db) => db.exec("DROP TRIGGER fail_attachment"));
    const created = await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "rollback-positive");
    withDatabase((db) => db.exec(`CREATE TRIGGER fail_retirement BEFORE UPDATE OF disposition ON attachment_operations
      WHEN NEW.disposition = 'retired' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`));
    await expect(reconcile(bearer, "retire")).rejects.toThrow("fixture failure");
    expect(authority.authenticate(`Bearer ${bearer}`)).not.toBeNull();
    expect(await reconcile(bearer, "inspect")).toMatchObject({ payload: { disposition: "accepted", session_id: created.payload.session.id } });
    withDatabase((db) => db.exec("DROP TRIGGER fail_retirement"));
    expect(await reconcile(bearer, "retire")).toMatchObject({ status: 200 });
  });

  it.each(["finalize", "retire"] as const)("serializes %s first against the conflicting transition", async (first) => {
    const bearer = generateSecret();
    await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "race-created");
    const second = first === "finalize" ? "retire" : "finalize";
    const results = await Promise.all([reconcile(bearer, first), reconcile(bearer, second)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const finalized = results[0]!.status === 200 ? first === "finalize" : second === "finalize";
    expect(results.find((result) => result.status === 409)).toMatchObject({
      error: { code: finalized ? "ATTACHMENT_FINALIZED" : "ATTACHMENT_RETIRED" },
    });
    expect(authority.authenticate(`Bearer ${bearer}`) !== null).toBe(finalized);
  });

  it("rechecks parent revocation after async receipt derivation before creating state", async () => {
    const bearer = generateSecret();
    const pending = attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "auth-race");
    authority.revokeClient(clientA.clientId);
    expect(await pending).toMatchObject({ status: 404 });
    expect(count("drones")).toBe(0);
  });

  it("serializes competing real SQLite connections without partial revocation or a replacement", async () => {
    const bearer = generateSecret();
    const attached = await attach(clientA.credential, ids.cubeA, ids.roleA, bearer, "connections-created");
    const receipt = await deriveAttachmentReceipt(bearer);
    const workers = (["finalize", "retire"] as const).map((action) => new Worker(
      new URL("./fixtures/attachment-transaction-worker.mjs", import.meta.url),
      { workerData: { path: databasePath, clientId: clientA.clientId,
        request: { receipt, cube_id: ids.cubeA, role_id: ids.roleA, action } } },
    ));
    try {
      await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
        worker.once("message", (message) => { expect(message).toEqual({ ready: true }); resolve(); });
        worker.once("error", reject);
      })));
      const results = await Promise.all(workers.map((worker) => new Promise<{ result?: { disposition: string }; code?: string }>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.postMessage("go");
      })));
      const finalized = results[0]!.result?.disposition === "finalized";
      expect(results).toEqual(finalized
        ? [{ result: { disposition: "finalized", drone_id: attached.payload.drone.id, session_id: attached.payload.session.id } }, { code: "ATTACHMENT_FINALIZED" }]
        : [{ code: "ATTACHMENT_RETIRED" }, { result: { disposition: "retired" } }]);
      expect(authority.authenticate(`Bearer ${bearer}`) !== null).toBe(finalized);
      expect(count("drone_sessions")).toBe(1);
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  });

  it("returns static malformed/tag diagnostics without echoing request secrets", async () => {
    const secret = generateSecret();
    for (const tag of ["14", "15"]) {
      const response = await api.handle({ method: "POST", path: ATTACH_RECONCILE_PATH,
        principal: authenticatedPrincipal(clientA.credential),
        body: { protocol_version: tag, request_id: "receipt-malformed", payload: { [secret]: secret } },
        signal: new AbortController().signal });
      expect(response.status).toBe(tag === "14" ? 426 : 400);
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
  });
});

async function reconcile(bearer: string, action: ReconcileAttachmentAction, options: { credential?: string; prior?: string } = {}) {
  const response = await api.handle({ method: "POST", path: ATTACH_RECONCILE_PATH,
    principal: authenticatedPrincipal(options.credential ?? clientA.credential),
    body: envelope(`reconcile-${action}`, { receipt: await deriveAttachmentReceipt(bearer), cube_id: ids.cubeA,
      role_id: ids.roleA, action, ...(options.prior === undefined ? {} : { prior_drone_id: options.prior }) }),
    signal: new AbortController().signal });
  const body = response.body as { error?: { code: string } };
  return { status: response.status,
    ...(response.status === 200 ? { payload: decodeReconcileAttachmentResponseEnvelope(response.body, action).payload } : { error: body.error }) };
}

function withDatabase<T>(op: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databasePath);
  try { return op(database); } finally { database.close(); }
}

function authorityRuntime(store: StoreRuntime) {
  const nextDigester = new CredentialDigester(Buffer.alloc(32, 6));
  const nextAuthority = new CredentialAuthority(store.credentials, nextDigester, () => new Date(now));
  return {
    digester: nextDigester,
    authority: nextAuthority,
    api: new CoordinationApi(store, nextAuthority),
  };
}

function enroll(nextAuthority: CredentialAuthority, name: string, ownerCredential?: string) {
  const invitation = ownerCredential === undefined
    ? nextAuthority.createBootstrapInvitation(60_000)
    : nextAuthority.createInvitationForOwnerCredential(ownerCredential, 60_000);
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
    readonly session: { readonly id: string };
    readonly initial_log_cursor: { readonly id: string; readonly created_at: string } | null;
  };
  readonly error?: { readonly code: string; readonly message: string };
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
  const body = response.body as { payload?: unknown; error?: { code: string; message: string } };
  const payload = body.payload === undefined
    ? undefined
    : decodeAttachResponseEnvelope(response.body).payload;
  return {
    status: response.status,
    payload: payload as Awaited<ReturnType<typeof attach>>["payload"],
    ...(body.error === undefined ? {} : { error: body.error }),
  };
}

function authenticatedPrincipal(credential: string) {
  const principal = authority.authenticate(`Bearer ${credential}`);
  if (principal === null) throw new Error("Test credential did not authenticate.");
  return principal;
}

function envelope(requestId: string, payload: Record<string, unknown>) {
  return { protocol_version: "15", request_id: requestId, payload };
}

function count(table: "drones" | "drone_sessions" | "drone_session_credentials"): number {
  const database = new DatabaseSync(databasePath);
  try {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    database.close();
  }
}
