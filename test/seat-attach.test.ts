import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoordinationApi } from "../src/coordination-api.js";
import { CredentialAuthority, CredentialDigester } from "../src/credentials.js";
import { openStore, type StoreRuntime } from "../src/store.js";

const ids = {
  cubeA: "00000000-0000-4000-8000-000000000101",
  cubeB: "00000000-0000-4000-8000-000000000102",
  roleA: "00000000-0000-4000-8000-000000000103",
  roleB: "00000000-0000-4000-8000-000000000104",
  roleA2: "00000000-0000-4000-8000-000000000109",
  retryA: "00000000-0000-4000-8000-000000000105",
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
  runtime.maintenance.createRole({
    id: ids.roleA,
    cubeId: ids.cubeA,
    name: "Builder",
    roleClass: "worker",
  });
  runtime.maintenance.createRole({
    id: ids.roleA2,
    cubeId: ids.cubeA,
    name: "Reviewer",
    roleClass: "worker",
  });
  runtime.maintenance.createRole({
    id: ids.roleB,
    cubeId: ids.cubeB,
    name: "Queen",
    roleClass: "queen",
    isHumanSeat: true,
  });
  runtime.maintenance.grantClientCube({ clientId: clientA.clientId, cubeId: ids.cubeA, access: "manage" });
  runtime.maintenance.grantClientCube({ clientId: clientB.clientId, cubeId: ids.cubeB, access: "manage" });
});

afterEach(async () => {
  runtime.close();
  digester.destroy();
  await rm(directory, { recursive: true, force: true });
});

describe("client seat attach", () => {
  it("keeps identity idempotent while rotating credentials by monotonic generation", async () => {
    const first = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-001");
    const second = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-002");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.payload.drone).toEqual(first.payload.drone);
    expect(first.payload).toMatchObject({ reattached: false, session: { generation: 1 } });
    expect(second.payload).toMatchObject({ reattached: true, session: { generation: 2 } });
    expect(second.payload.session.token).not.toBe(first.payload.session.token);
    expect(authority.authenticateStatus(`Bearer ${first.payload.session.token}`)).toBe("revoked");
    expect(authority.authenticateStatus(`Bearer ${second.payload.session.token}`)).toMatchObject({
      kind: "drone-session",
      clientId: clientA.clientId,
      cubeId: ids.cubeA,
      droneId: first.payload.drone.id,
    });
    expect((await readFile(databasePath)).includes(Buffer.from(second.payload.session.token)))
      .toBe(false);
  });

  it("serializes concurrent first attach and lets generation reject a delayed response", async () => {
    const [one, two] = await Promise.all([
      attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-101"),
      attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-102"),
    ]);
    const ordered = [one, two].sort(
      (left, right) => left.payload.session.generation - right.payload.session.generation,
    );

    expect(ordered.map((response) => response.payload.session.generation)).toEqual([1, 2]);
    expect(ordered[0]!.payload.drone).toEqual(ordered[1]!.payload.drone);
    expect(authority.authenticateStatus(
      `Bearer ${ordered[0]!.payload.session.token}`,
    )).toBe("revoked");
    expect(authority.authenticateStatus(
      `Bearer ${ordered[1]!.payload.session.token}`,
    )).toMatchObject({ kind: "drone-session" });
  });

  it("permanently binds retry keys to one cube and role without mutation on mismatch", async () => {
    runtime.maintenance.grantClientCube({
      clientId: clientA.clientId,
      cubeId: ids.cubeB,
      access: "manage",
    });
    const first = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-201");
    const mismatch = await attach(api, clientA.credential, ids.cubeA, ids.roleA2, ids.retryA, "attach-202");

    expect(mismatch.status).toBe(409);
    expect(mismatch.error?.code).toBe("INVALID_INPUT");
    expect(authority.authenticateStatus(`Bearer ${first.payload.session.token}`))
      .toMatchObject({ kind: "drone-session" });
    const retry = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-203");
    expect(retry.payload.session.generation).toBe(2);
  });

  it("isolates the same retry key across clients and rejects unauthorized cube or role selection", async () => {
    const attachedA = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-301");
    const attachedB = await attach(api, clientB.credential, ids.cubeB, ids.roleB, ids.retryA, "attach-302");
    expect(attachedA.payload.drone.id).not.toBe(attachedB.payload.drone.id);

    const crossCube = await attach(
      api,
      clientA.credential,
      ids.cubeB,
      ids.roleB,
      "00000000-0000-4000-8000-000000000106",
      "attach-303",
    );
    const crossRole = await attach(
      api,
      clientA.credential,
      ids.cubeA,
      ids.roleB,
      "00000000-0000-4000-8000-000000000107",
      "attach-304",
    );
    expect(crossCube).toMatchObject({ status: 404, error: { code: "NOT_FOUND" } });
    expect(crossRole).toMatchObject({ status: 404, error: { code: "NOT_FOUND" } });
  });

  it("persists canonical identity across restart and lost-response retry", async () => {
    const first = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-401");
    runtime.close();
    digester.destroy();
    runtime = await openStore({ path: databasePath, clock: () => new Date(now) });
    ({ digester, authority, api } = authorityRuntime(runtime));

    const retried = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-402");
    expect(retried.payload.drone).toEqual(first.payload.drone);
    expect(retried.payload).toMatchObject({ reattached: true, session: { generation: 2 } });
    expect(authority.authenticateStatus(`Bearer ${first.payload.session.token}`)).toBe("revoked");
  });

  it("keeps drone authority cube-bound and below the parent client grant", async () => {
    const attached = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-501");
    const token = attached.payload.session.token;
    const ownAppend = await api.handle({
      method: "POST",
      path: `/api/cubes/${ids.cubeA}/logs`,
      principal: authenticatedPrincipal(token),
      body: envelope("append-500", { message: "drone-scoped append" }),
      signal: new AbortController().signal,
    });
    expect(ownAppend).toMatchObject({
      status: 201,
      body: { payload: { entry: { drone_id: attached.payload.drone.id } } },
    });
    const decision = await api.handle({
      method: "POST",
      path: `/api/cubes/${ids.cubeA}/decisions`,
      principal: authenticatedPrincipal(token),
      body: envelope("decision-501", { topic: "authority", decision: "escalate" }),
      signal: new AbortController().signal,
    });
    expect(decision.status).toBe(404);
    const crossCube = await api.handle({
      method: "PUT",
      path: `/api/cubes/${ids.cubeB}/logs`,
      principal: authenticatedPrincipal(token),
      body: envelope("read-0501", { cursor: null, limit: 10 }),
      signal: new AbortController().signal,
    });
    expect(crossCube.status).toBe(404);
    const nestedAttach = await attach(
      api,
      token,
      ids.cubeA,
      ids.roleA,
      "00000000-0000-4000-8000-000000000108",
      "attach-502",
    );
    expect(nestedAttach).toMatchObject({ status: 404, error: { code: "NOT_FOUND" } });

    runtime.maintenance.grantClientCube({ clientId: clientA.clientId, cubeId: ids.cubeA, access: "read" });
    const append = await api.handle({
      method: "POST",
      path: `/api/cubes/${ids.cubeA}/logs`,
      principal: authenticatedPrincipal(token),
      body: envelope("append-501", { message: "must remain read-only" }),
      signal: new AbortController().signal,
    });
    expect(append.status).toBe(404);
    runtime.maintenance.removeClientCubeGrant(clientA.clientId, ids.cubeA);
    const read = await api.handle({
      method: "PUT",
      path: `/api/cubes/${ids.cubeA}/logs`,
      principal: authenticatedPrincipal(token),
      body: envelope("read-0502", { cursor: null, limit: 10 }),
      signal: new AbortController().signal,
    });
    expect(read.status).toBe(404);
  });

  it("preserves the prior credential when a retry loses its parent grant", async () => {
    const attached = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-601");
    runtime.maintenance.removeClientCubeGrant(clientA.clientId, ids.cubeA);
    const failed = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-602");
    expect(failed.status).toBe(404);

    runtime.maintenance.grantClientCube({ clientId: clientA.clientId, cubeId: ids.cubeA, access: "read" });
    expect(authority.authenticateStatus(`Bearer ${attached.payload.session.token}`))
      .toMatchObject({ kind: "drone-session" });
    const recovered = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-603");
    expect(recovered.payload.session.generation).toBe(2);
  });

  it("expires session credentials and terminates an active stream after rotation", async () => {
    const attached = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-701");
    const token = attached.payload.session.token;
    const stream = await api.handle({
      method: "GET",
      path: `/api/cubes/${ids.cubeA}/stream`,
      principal: authenticatedPrincipal(token),
      signal: new AbortController().signal,
    });
    const iterator = stream.stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value).toContain("event: bookmark");
    const pending = iterator.next();
    await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-702");
    await expect(pending).resolves.toMatchObject({ done: true });

    now = new Date("2026-07-16T13:00:00.000Z");
    const current = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-703");
    now = new Date(current.payload.session.expires_at);
    expect(authority.authenticateStatus(`Bearer ${current.payload.session.token}`)).toBe("revoked");
  });

  it("revokes child credentials and streams with the parent client regardless of role label", async () => {
    const attached = await attach(api, clientB.credential, ids.cubeB, ids.roleB, ids.retryA, "attach-801");
    const token = attached.payload.session.token;
    const decision = await api.handle({
      method: "POST",
      path: `/api/cubes/${ids.cubeB}/decisions`,
      principal: authenticatedPrincipal(token),
      body: envelope("decision-801", { topic: "role", decision: "Queen cannot manage" }),
      signal: new AbortController().signal,
    });
    expect(decision.status).toBe(404);

    const stream = await api.handle({
      method: "GET",
      path: `/api/cubes/${ids.cubeB}/stream`,
      principal: authenticatedPrincipal(token),
      signal: new AbortController().signal,
    });
    const iterator = stream.stream![Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    authority.revokeClient(clientB.clientId);
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(authority.authenticateStatus(`Bearer ${token}`)).toBe("revoked");
    expect(authority.authenticateStatus(`Bearer ${clientB.credential}`)).toBe("revoked");
  });

  it("rejects unsupported protocol input before creating an attachment", async () => {
    const malformed = await api.handle({
      method: "POST",
      path: "/api/client/attach",
      principal: authenticatedPrincipal(clientA.credential),
      body: {
        protocol_version: "2",
        request_id: "attach-901",
        payload: { cube_id: ids.cubeA, role_id: ids.roleA, retry_key: ids.retryA },
      },
      signal: new AbortController().signal,
    });
    expect(malformed.status).toBe(400);
    const first = await attach(api, clientA.credential, ids.cubeA, ids.roleA, ids.retryA, "attach-902");
    expect(first.payload.session.generation).toBe(1);
  });
});

function authorityRuntime(store: StoreRuntime): {
  readonly digester: CredentialDigester;
  readonly authority: CredentialAuthority;
  readonly api: CoordinationApi;
} {
  const nextDigester = new CredentialDigester(Buffer.alloc(32, 6));
  const nextAuthority = new CredentialAuthority(store.credentials, nextDigester, () => new Date(now));
  return {
    digester: nextDigester,
    authority: nextAuthority,
    api: new CoordinationApi(store, nextAuthority),
  };
}

function enroll(nextAuthority: CredentialAuthority, name: string) {
  const invitation = nextAuthority.createBootstrapInvitation(60_000);
  const enrollment = nextAuthority.exchangeInvitation({ invitation, clientName: name });
  if (enrollment === null) throw new Error("Enrollment failed.");
  return enrollment;
}

async function attach(
  nextApi: CoordinationApi,
  credential: string,
  cubeId: string,
  roleId: string,
  retryKey: string,
  requestId: string,
): Promise<{
  readonly status: number;
  readonly payload: {
    readonly cube: { readonly id: string; readonly name: string };
    readonly role: { readonly id: string; readonly name: string };
    readonly drone: { readonly id: string; readonly label: string };
    readonly session: {
      readonly token: string;
      readonly expires_at: string;
      readonly generation: number;
    };
    readonly reattached: boolean;
  };
  readonly error?: { readonly code: string };
}> {
  const response = await nextApi.handle({
    method: "POST",
    path: "/api/client/attach",
    principal: authenticatedPrincipal(credential),
    body: envelope(requestId, { cube_id: cubeId, role_id: roleId, retry_key: retryKey }),
    signal: new AbortController().signal,
  });
  const body = response.body as {
    payload?: unknown;
    error?: { code: string };
  };
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
  return { protocol_version: "1", request_id: requestId, payload };
}
