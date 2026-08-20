import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProtocolEnvelope,
  decodeAckStatusResultEnvelope,
} from "borgmcp-shared/protocol";
import { getTemplate, NEW_CUBE_TEMPLATE_PRESENTATIONS } from "borgmcp-shared/templates";

import { CoordinationApi } from "../src/coordination-api.js";
import {
  CredentialAuthority,
  CredentialDigester,
  LiveCredentialRegistry,
  generateSecret,
} from "../src/credentials.js";
import { openStore, type ActivityStreamRecord, type StoreRuntime } from "../src/store.js";
import { clientPrincipal, droneSessionPrincipal, type Principal } from "../src/principal.js";
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
  it("returns strict scoped acknowledgement status without mutating authority state", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-ack-status-")));
    directories.push(directory);
    const databasePath = join(directory, "borg.db");
    runtime = await openStore({ path: databasePath, clock: () => new Date("2026-07-14T12:00:00.000Z") });
    digester = new CredentialDigester(Buffer.alloc(32, 35));
    const api = new CoordinationApi(runtime, new CredentialAuthority(runtime.credentials, digester));
    const managerId = "00000000-0000-4000-8000-000000000351";
    const observerId = "00000000-0000-4000-8000-000000000352";
    const cubeId = "00000000-0000-4000-8000-000000000353";
    const foreignCubeId = "00000000-0000-4000-8000-000000000354";
    const roleId = "00000000-0000-4000-8000-000000000355";
    const recipientId = "00000000-0000-4000-8000-000000000356";
    const claimantId = "00000000-0000-4000-8000-000000000357";
    const recipientSessionId = "00000000-0000-4000-8000-000000000358";
    const claimantSessionId = "00000000-0000-4000-8000-000000000359";
    runtime.maintenance.createClient({ id: managerId, name: "Manager" });
    runtime.maintenance.createClient({ id: observerId, name: "Observer" });
    runtime.maintenance.createCube({ id: cubeId, name: "Ack status", directive: "" });
    runtime.maintenance.createCube({ id: foreignCubeId, name: "Foreign", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: managerId, cubeId, access: "manage" });
    runtime.maintenance.grantClientCube({ clientId: observerId, cubeId, access: "read" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    for (const [droneId, sessionId, label] of [
      [recipientId, recipientSessionId, "recipient"],
      [claimantId, claimantSessionId, "claimant"],
    ] as const) {
      runtime.maintenance.createDrone({
        id: droneId, cubeId, roleId, clientId: managerId, label,
      });
      runtime.maintenance.createDroneSession({
        id: sessionId, clientId: managerId, cubeId, droneId,
      });
    }
    const manager = runtime.forPrincipal(clientPrincipal(managerId));
    const direct = manager.appendLog(cubeId, {
      message: "direct status",
      visibility: "direct",
      recipientDroneIds: [recipientId, claimantId],
    });
    runtime.forPrincipal(droneSessionPrincipal({
      id: recipientSessionId, clientId: managerId, cubeId, droneId: recipientId,
    })).acknowledge(cubeId, direct.id, "ack");
    runtime.forPrincipal(droneSessionPrincipal({
      id: claimantSessionId, clientId: managerId, cubeId, droneId: claimantId,
    })).acknowledge(cubeId, direct.id, "claim");
    const database = new DatabaseSync(databasePath);
    const metadataMissingId = "00000000-0000-4000-8000-000000000360";
    database.prepare(`
      INSERT INTO activity_acks (
        entry_id, principal_kind, principal_id, kind, created_at, claimant_drone_id
      ) VALUES (?, 'drone-session', ?, 'claim', ?, ?)
    `).run(direct.id, randomUUID(), "2026-07-14T12:00:01.000Z", metadataMissingId);
    database.close();
    const before = runtime.maintenance.observeAuthorityState();
    const request = createProtocolEnvelope("ack-status", { entry_id: direct.id });
    const response = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/${direct.id}/ack-status`,
      principal: clientPrincipal(managerId),
      body: request,
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(200);
    expect(decodeAckStatusResultEnvelope(response.body).payload).toEqual({
      entry_id: direct.id,
      visibility: "direct",
      recipients: [
        expect.objectContaining({ drone_id: recipientId, acknowledged_at: expect.any(String) }),
        expect.objectContaining({ drone_id: claimantId, acknowledged_at: null }),
      ],
      claims: [
        expect.objectContaining({ drone_id: claimantId, drone_label: "claimant", drone_role: "Builder" }),
        {
          drone_id: metadataMissingId,
          drone_label: null,
          drone_role: null,
          claimed_at: "2026-07-14T12:00:01.000Z",
        },
      ],
    });
    expect(runtime.maintenance.observeAuthorityState()).toEqual(before);
    expect(manager.readLog(cubeId, null, 10).entries.map((entry) => entry.id)).toContain(direct.id);

    const broadcast = manager.appendLog(cubeId, { visibility: "broadcast", message: "broadcast status" });
    const broadcastResponse = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/${broadcast.id}/ack-status`,
      principal: clientPrincipal(observerId),
      body: createProtocolEnvelope("ack-status-broadcast", { entry_id: broadcast.id }),
      signal: new AbortController().signal,
    });
    expect(decodeAckStatusResultEnvelope(broadcastResponse.body).payload).toEqual({
      entry_id: broadcast.id,
      visibility: "broadcast",
      recipients: [],
      claims: [],
    });

    const hidden = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/${direct.id}/ack-status`,
      principal: clientPrincipal(observerId),
      body: request,
      signal: new AbortController().signal,
    });
    const unknownId = randomUUID();
    const unknown = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/${unknownId}/ack-status`,
      principal: clientPrincipal(managerId),
      body: createProtocolEnvelope("ack-status", { entry_id: unknownId }),
      signal: new AbortController().signal,
    });
    const crossCube = await api.handle({
      method: "GET",
      path: `/api/cubes/${foreignCubeId}/logs/${direct.id}/ack-status`,
      principal: clientPrincipal(managerId),
      body: request,
      signal: new AbortController().signal,
    });
    for (const refused of [hidden, unknown, crossCube]) {
      expect(refused).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    }
    const mismatched = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/${direct.id}/ack-status`,
      principal: clientPrincipal(managerId),
      body: createProtocolEnvelope("ack-status-mismatch", { entry_id: randomUUID() }),
      signal: new AbortController().signal,
    });
    expect(mismatched).toMatchObject({ status: 400, body: { error: { code: "INVALID_INPUT" } } });
    const malformed = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/not-a-uuid/ack-status`,
      principal: clientPrincipal(managerId),
      body: request,
      signal: new AbortController().signal,
    });
    expect(malformed).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
  });

  it("deduplicates equivalent resolved recipient sets and ignores unused request class", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-routing-retry-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 31));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const api = new CoordinationApi(runtime, authority);
    const clientId = "00000000-0000-4000-8000-000000000301";
    const cubeId = "00000000-0000-4000-8000-000000000302";
    const roleId = "00000000-0000-4000-8000-000000000303";
    const droneA = "00000000-0000-4000-8000-000000000304";
    const droneB = "00000000-0000-4000-8000-000000000305";
    runtime.maintenance.createClient({ id: clientId, name: "Retry manager" });
    runtime.maintenance.createCube({ id: cubeId, name: "Retry", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Worker" });
    runtime.maintenance.createDrone({ id: droneA, cubeId, roleId, clientId, label: "worker-a" });
    runtime.maintenance.createDrone({ id: droneB, cubeId, roleId, clientId, label: "worker-b" });
    const principal = clientPrincipal(clientId);
    const events: ActivityStreamRecord[] = [];
    const unsubscribe = runtime.forPrincipal(principal).subscribeActivity(cubeId, (entry) => events.push(entry));
    const postId = "00000000-0000-4000-8000-000000000306";
    const append = (recipients: string[], includeClass: boolean) => api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal,
      body: {
        protocol_version: "12",
        request_id: randomUUID(),
        payload: {
          post_id: postId,
          message: "direct retry",
          to: recipients,
          ...(includeClass ? { class: "request-shape-only" } : {}),
        },
      },
      signal: new AbortController().signal,
    });

    const created = await append([droneA, droneB], true);
    const replay = await append([droneB, droneA], false);
    expect(replay).toMatchObject({
      status: 201,
      body: { payload: { entry: { id: (created.body as any).payload.entry.id }, deduplicated: true } },
    });
    expect(events).toHaveLength(1);
    const conflict = await append([droneA], false);
    expect(conflict).toMatchObject({ status: 409, body: { error: { code: "POST_ID_CONFLICT" } } });
    expect(events).toHaveLength(1);
    unsubscribe();
  });

  it("emits a terminal CUBE_DELETED error before closing an active stream", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-delete-stream-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 26));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-000000000075";
    const managerId = "00000000-0000-4000-8000-000000000076";
    const participantId = "00000000-0000-4000-8000-000000000077";
    runtime.maintenance.createClient({ id: managerId, name: "Delete manager" });
    runtime.maintenance.createClient({ id: participantId, name: "Delete participant" });
    runtime.maintenance.createCube({ id: cubeId, name: "Delete stream", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: managerId, cubeId, access: "manage" });
    runtime.maintenance.grantClientCube({ clientId: participantId, cubeId, access: "write" });
    const api = new CoordinationApi(runtime, authority);
    const stream = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      principal: clientPrincipal(participantId),
      signal: new AbortController().signal,
    });
    const iterator = stream.stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value).toContain("event: bookmark");

    const deletion = await api.handle({
      method: "DELETE",
      path: `/api/cubes/${cubeId}`,
      principal: clientPrincipal(managerId),
      body: {
        protocol_version: "12",
        request_id: "delete-stream-cube",
        payload: {},
      },
      signal: new AbortController().signal,
    });

    expect(deletion).toMatchObject({
      status: 200,
      body: {
        request_id: "delete-stream-cube",
        payload: { cube_id: cubeId, deleted: true },
      },
    });
    const terminal = await iterator.next();
    expect(terminal.done).toBe(false);
    expect(terminal.value).toContain("event: error");
    expect(JSON.parse(terminal.value!.match(/data: (.+)\n\n/u)![1]!)).toEqual({
      protocol_version: "12",
      error: { code: "CUBE_DELETED", message: "The cube was deleted." },
    });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

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
      store.appendLog(cubeId, { visibility: "broadcast", message: `replay-${index}` });
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
    store.appendLog(cubeId, { visibility: "broadcast", message: "replay-boundary" });
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
  }, 15_000);

  it("preserves a wake nonce emitted during the replay barrier", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-replay-wake-")));
    directories.push(directory);
    let now = new Date("2026-07-14T12:00:00.000Z");
    runtime = await openStore({ path: join(directory, "borg.db"), clock: () => now });
    digester = new CredentialDigester(Buffer.alloc(32, 27));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const clientId = "00000000-0000-4000-8000-0000000000f1";
    const cubeId = "00000000-0000-4000-8000-0000000000f2";
    const roleId = "00000000-0000-4000-8000-0000000000f3";
    const droneId = "00000000-0000-4000-8000-0000000000f4";
    const sessionId = "00000000-0000-4000-8000-0000000000f5";
    runtime.maintenance.createClient({ id: clientId, name: "Replay wake client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Replay wake", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Replay worker" });
    runtime.maintenance.createDrone({ id: droneId, cubeId, roleId, clientId, label: "replay-worker" });
    runtime.maintenance.createDroneSession({ id: sessionId, clientId, cubeId, droneId });
    const manager = runtime.forPrincipal(clientPrincipal(clientId));
    const entry = manager.appendLog(cubeId, {
      message: "replay wake",
      visibility: "direct",
      recipientDroneIds: [droneId],
    });
    const principal = droneSessionPrincipal({ id: sessionId, clientId, cubeId, droneId });
    const api = new CoordinationApi(runtime, authority);
    const barrier = api.armReplayTransition();
    const opening = api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/stream`,
      principal,
      signal: new AbortController().signal,
    });
    await barrier.reached;
    now = new Date("2026-07-14T12:01:01.000Z");
    runtime.liveness.scan();
    barrier.release();

    const response = await opening;
    const iterator = response.stream![Symbol.asyncIterator]();
    const wakeFrames: Array<{ entry: { id: string; wake_nonce?: string } }> = [];
    for (;;) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (next.value.includes("event: bookmark")) break;
      const data = JSON.parse(next.value.match(/data: (.+)\n\n/u)![1]!);
      if (data.entry?.wake_nonce !== undefined) wakeFrames.push(data);
    }
    expect(wakeFrames).toHaveLength(1);
    expect(wakeFrames[0]!.entry).toMatchObject({ id: entry.id, wake_nonce: expect.any(String) });
    await iterator.return?.();
  }, 15_000);

  it("keeps 200 replay-time notifications ordered before the bookmark", async () => {
    const fixture = await createNotificationPressureFixture(200, "ordered");
    const barrier = fixture.api.armReplayTransition();
    const opening = fixture.api.handle({
      method: "GET",
      path: `/api/cubes/${fixture.cubeId}/stream`,
      principal: fixture.authorPrincipal,
      cursor: fixture.cursor,
      signal: new AbortController().signal,
    });
    await barrier.reached;
    for (const entry of fixture.entries) fixture.peerStore.acknowledge(fixture.cubeId, entry.id, "ack");
    barrier.release();

    const response = await opening;
    const iterator = response.stream![Symbol.asyncIterator]();
    const replayed: string[] = [];
    const notifications: string[] = [];
    for (;;) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (next.value.includes("event: bookmark")) break;
      const data = JSON.parse(next.value.match(/data: (.+)\n\n/u)![1]!);
      if (data.entry.kind === "ack") notifications.push(data.entry.log_entry_id);
      else replayed.push(data.entry.id);
    }

    expect(replayed).toEqual(fixture.entries.map((entry) => entry.id));
    expect(notifications).toEqual(fixture.entries.map((entry) => entry.id));
    await iterator.return?.();
  });

  it("closes on the 201st replay-time notification and replays durable entries after reconnect", async () => {
    const lines: string[] = [];
    const fixture = await createNotificationPressureFixture(
      201,
      "overflow",
      createDebugLogger((line) => lines.push(line)),
    );
    const barrier = fixture.api.armReplayTransition();
    const opening = fixture.api.handle({
      method: "GET",
      path: `/api/cubes/${fixture.cubeId}/stream`,
      principal: fixture.authorPrincipal,
      cursor: fixture.cursor,
      signal: new AbortController().signal,
    });
    await barrier.reached;
    for (const entry of fixture.entries) fixture.peerStore.acknowledge(fixture.cubeId, entry.id, "ack");
    const durableAfterOverflow = fixture.authorStore.appendLog(fixture.cubeId, {
      visibility: "broadcast",
      message: "durable-after-overflow",
    });
    barrier.release();

    const response = await opening;
    const iterator = response.stream![Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    const overflowEvents = lines.map((line) => JSON.parse(line));
    expect(overflowEvents).toContainEqual(expect.objectContaining({
      event: "sse_overflow",
      buffered_count: 200,
    }));
    expect(overflowEvents).toContainEqual(expect.objectContaining({ event: "sse_unsubscribe" }));
    expect(overflowEvents).not.toContainEqual(expect.objectContaining({ event: "sse_subscribe" }));

    const reconnect = await fixture.api.handle({
      method: "GET",
      path: `/api/cubes/${fixture.cubeId}/stream`,
      principal: fixture.authorPrincipal,
      cursor: fixture.cursor,
      signal: new AbortController().signal,
    });
    const reconnectIterator = reconnect.stream![Symbol.asyncIterator]();
    const replayed: string[] = [];
    for (;;) {
      const next = await reconnectIterator.next();
      expect(next.done).toBe(false);
      if (next.value.includes("event: bookmark")) break;
      const data = JSON.parse(next.value.match(/data: (.+)\n\n/u)![1]!);
      expect(data.entry.kind).toBeUndefined();
      replayed.push(data.entry.id);
    }
    expect(replayed).toEqual([...fixture.entries.map((entry) => entry.id), durableAfterOverflow.id]);
    await reconnectIterator.return?.();
  });

  it("keeps 201 peer-targeted wake retries isolated from a nonrecipient pre-live stream", async () => {
    const lines: string[] = [];
    let now = new Date("2026-07-14T12:00:00.000Z");
    const fixture = await createNotificationPressureFixture(
      201,
      "recipient-isolation",
      createDebugLogger((line) => lines.push(line)),
      true,
      () => now,
    );
    const intended = await fixture.api.handle({
      method: "GET",
      path: `/api/cubes/${fixture.cubeId}/stream`,
      principal: fixture.authorPrincipal,
      cursor: fixture.lastEntryCursor,
      signal: new AbortController().signal,
    });
    const intendedIterator = intended.stream![Symbol.asyncIterator]();
    expect((await intendedIterator.next()).value).toContain("event: bookmark");

    const barrier = fixture.api.armReplayTransition();
    const opening = fixture.api.handle({
      method: "GET",
      path: `/api/cubes/${fixture.cubeId}/stream`,
      principal: fixture.outsiderPrincipal,
      cursor: fixture.lastEntryCursor,
      signal: new AbortController().signal,
    });
    await barrier.reached;
    now = new Date("2026-07-14T12:01:01.000Z");
    const firstWake = intendedIterator.next();
    runtime!.liveness.scan();
    barrier.release();

    const response = await opening;
    const iterator = response.stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value).toContain("event: bookmark");

    const wakeEntryIds: string[] = [];
    for (let index = 0; index < fixture.entries.length; index += 1) {
      const next = index === 0 ? await firstWake : await intendedIterator.next();
      expect(next.done).toBe(false);
      const data = JSON.parse(next.value!.match(/data: (.+)\n\n/u)![1]!);
      expect(data.entry.wake_nonce).toEqual(expect.any(String));
      wakeEntryIds.push(data.entry.id);
    }
    expect(wakeEntryIds).toEqual(fixture.entries.map((entry) => entry.id));
    expect(lines.map((line) => JSON.parse(line))).not.toContainEqual(
      expect.objectContaining({ event: "sse_overflow" }),
    );
    await iterator.return?.();
    await intendedIterator.return?.();
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
        protocol_version: "12",
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
      status: 200,
      body: { payload: { result: "created", session: { id: expect.any(String) } } },
    });
    expect(participantAttach).toMatchObject({
      status: 200,
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
        protocol_version: "12",
        request_id: "observer-post",
        payload: { post_id: randomUUID(), message: "denied", to: "broadcast" },
      },
      signal: new AbortController().signal,
    });
    expect(observerPost.status).toBe(404);
    const observerManage = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles`,
      principal: observerSession,
      body: {
        protocol_version: "12",
        request_id: "observer-manage",
        payload: { name: "Denied" },
      },
      signal: new AbortController().signal,
    });
    expect(observerManage).toMatchObject({
      status: 403,
      body: { error: { code: "ACCESS_DENIED" } },
    });

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
        protocol_version: "12",
        request_id: "observer-target",
        payload: {
          post_id: randomUUID(),
          message: "must-not-arrive",
          to: [observerPayload.drone.id],
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
        protocol_version: "12",
        request_id: "participant-target",
        payload: {
          post_id: randomUUID(),
          message: "participant-work",
          to: [participantPayload.drone.id],
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
          protocol_version: "12",
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
        protocol_version: "12",
        request_id: "participant-broadcast",
        payload: { post_id: randomUUID(), message: "shared-update", to: "broadcast" },
      },
      signal: new AbortController().signal,
    });
    expect(broadcast.status).toBe(201);
    const broadcastEntry = (broadcast.body as any).payload.entry;
    const database = new DatabaseSync(join(directory, "borg.db"));
    const collisionCreatedAt = broadcastEntry.created_at;
    database.prepare(`
      INSERT INTO activity_log (id, cube_id, drone_id, actor_kind, actor_id, message, created_at, visibility)
      VALUES (?, ?, NULL, 'client', ?, ?, ?, 'broadcast')
    `).run(
      "deadbeef-0000-4000-8000-000000000001", cubeId, participantClientId,
      "collision-one", collisionCreatedAt,
    );
    database.prepare(`
      INSERT INTO activity_log (id, cube_id, drone_id, actor_kind, actor_id, message, created_at, visibility)
      VALUES (?, ?, NULL, 'client', ?, ?, ?, 'broadcast')
    `).run(
      "deadbeef-0000-4000-8000-000000000002", cubeId, participantClientId,
      "collision-two", collisionCreatedAt,
    );
    database.prepare(`
      INSERT INTO activity_log (id, cube_id, drone_id, actor_kind, actor_id, message, created_at, visibility)
      VALUES (?, ?, NULL, 'client', ?, ?, ?, 'direct')
    `).run(
      "cafebabe-0000-4000-8000-000000000001", cubeId, participantClientId,
      "hidden-entry", collisionCreatedAt,
    );
    database.close();
    const fullCollisionLookup = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/deadbeef-0000-4000-8000-000000000001`,
      principal: observerSession,
      signal: new AbortController().signal,
    });
    expect(fullCollisionLookup).toMatchObject({
      status: 200,
      body: { payload: { entry: { message: "collision-one" } } },
    });
    const ambiguousPointLookup = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/deadbeef`,
      principal: observerSession,
      signal: new AbortController().signal,
    });
    expect(ambiguousPointLookup).toMatchObject({
      status: 409,
      body: { error: { code: "LOG_ENTRY_PREFIX_AMBIGUOUS" } },
    });
    const hiddenLookup = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/cafebabe-0000-4000-8000-000000000001`,
      principal: observerSession,
      signal: new AbortController().signal,
    });
    const nonexistentLookup = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/aaaaaaaa-0000-4000-8000-000000000001`,
      principal: observerSession,
      signal: new AbortController().signal,
    });
    expect(hiddenLookup).toEqual(nonexistentLookup);
    const hiddenCursor = await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal: observerSession,
      body: {
        protocol_version: "12",
        request_id: "hidden-prefix-cursor",
        payload: { cursor: { id: "cafebabe", created_at: collisionCreatedAt } },
      },
      signal: new AbortController().signal,
    });
    const missingCursor = await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal: observerSession,
      body: {
        protocol_version: "12",
        request_id: "missing-prefix-cursor",
        payload: { cursor: { id: "aaaaaaaa", created_at: collisionCreatedAt } },
      },
      signal: new AbortController().signal,
    });
    expect(hiddenCursor).toEqual(missingCursor);
    const fullCollisionSince = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: observerSession,
      since: "deadbeef-0000-4000-8000-000000000001",
      signal: new AbortController().signal,
    });
    expect(fullCollisionSince.status).toBe(200);
    const ambiguousSince = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: observerSession,
      since: "deadbeef",
      signal: new AbortController().signal,
    });
    expect(ambiguousSince).toMatchObject({
      status: 409,
      body: { error: { code: "LOG_ENTRY_PREFIX_AMBIGUOUS" } },
    });
    const prefixSince = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: observerSession,
      since: broadcastEntry.id.slice(0, 8),
      signal: new AbortController().signal,
    });
    expect(prefixSince.status).toBe(200);
    const participantPrefixSince = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: participantSession,
      since: directedEntryId.slice(0, 8),
      signal: new AbortController().signal,
    });
    expect(participantPrefixSince.status).toBe(200);
    const hiddenSince = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: observerSession,
      since: "cafebabe",
      signal: new AbortController().signal,
    });
    const missingSince = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: observerSession,
      since: "aaaaaaaa",
      signal: new AbortController().signal,
    });
    expect(hiddenSince).toEqual(missingSince);
    const invalidSince = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: observerSession,
      since: "not-a-cursor",
      signal: new AbortController().signal,
    });
    expect(invalidSince).toMatchObject({
      status: 400,
      body: {
        error: {
          message: "Log cursor must be a full UUID, 8-hex prefix, or ISO-8601 timestamp.",
        },
      },
    });
    const invalidTimestamp = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal: observerSession,
      since: "2026-07-19T10:00:00.000Z-extra-garbage",
      signal: new AbortController().signal,
    });
    expect(invalidTimestamp).toMatchObject({
      status: 400,
      body: {
        error: {
          message: "Log cursor must be a full UUID, 8-hex prefix, or ISO-8601 timestamp.",
        },
      },
    });
    const pointLookup = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/${broadcastEntry.id.slice(0, 8)}`,
      principal: observerSession,
      signal: new AbortController().signal,
    });
    expect(pointLookup).toMatchObject({
      status: 200,
      body: { payload: { entry: { id: broadcastEntry.id, message: "shared-update" } } },
    });
    const pointLookupWithBody = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/logs/${broadcastEntry.id.slice(0, 8)}`,
      principal: observerSession,
      body: createProtocolEnvelope("point-lookup-body", {
        entry_id: broadcastEntry.id.slice(0, 8),
      }),
      signal: new AbortController().signal,
    });
    expect(pointLookupWithBody).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_INPUT" } },
    });
    const prefixedPage = await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal: observerSession,
      body: {
        protocol_version: "12",
        request_id: "prefix-cursor-read",
        payload: {
          cursor: { id: broadcastEntry.id.slice(0, 8), created_at: broadcastEntry.created_at },
        },
      },
      signal: new AbortController().signal,
    });
    expect(prefixedPage).toMatchObject({
      status: 200,
      body: { payload: { entries: expect.any(Array) } },
    });
    const secondPrecisionPage = await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal: observerSession,
      body: {
        protocol_version: "12",
        request_id: "second-precision-cursor",
        payload: {
          cursor: { id: broadcastEntry.id.slice(0, 8), created_at: `${broadcastEntry.created_at.slice(0, 19)}Z` },
        },
      },
      signal: new AbortController().signal,
    });
    expect(secondPrecisionPage).toMatchObject({
      status: 200,
      body: { payload: { entries: expect.any(Array) } },
    });
    const invalidCursor = await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal: observerSession,
      body: {
        protocol_version: "12",
        request_id: "invalid-log-cursor",
        payload: { cursor: { id: "not-a-cursor", created_at: broadcastEntry.created_at } },
      },
      signal: new AbortController().signal,
    });
    expect(invalidCursor).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_INPUT", message: "Log cursor id must be a full UUID or 8-hex prefix." } },
    });
    const observerWake = (await observerIterator.next()).value!;
    expect(observerWake).toContain("shared-update");
    expect(observerWake).not.toContain("participant-work");

    const observerRead = await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal: observerSession,
      body: {
        protocol_version: "12",
        request_id: "observer-read",
        payload: { cursor: null },
      },
      signal: new AbortController().signal,
    });
    expect(observerRead.status).toBe(200);
    const observerMessages = (observerRead.body as any).payload.entries.map((entry: any) => entry.message);
    expect(observerMessages).toHaveLength(3);
    expect(observerMessages).toEqual(expect.arrayContaining(["shared-update", "collision-one", "collision-two"]));
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
        protocol_version: "5",
        request_id: "cube-version-old",
        payload: { retry_key: randomUUID(), name: "Must not exist", template: "default" },
      },
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({
      status: 426,
      body: {
        protocol_version: "12",
        request_id: "cube-version-old",
        error: {
          code: "UNSUPPORTED_PROTOCOL_VERSION",
          message: "Unsupported protocol version.",
        },
      },
    });
    expect(runtime.maintenance.observeAuthorityState().cubes).toBe(0);
  });

  it("creates and reads back the software-development template through the API", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-create-cube-")));
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
    const repository = {
      kind: "origin" as const,
      value: "https://github.com/Byte-Ventures/example",
    };
    const create = async (requestId: string, payload: Record<string, unknown>) => api.handle({
      method: "POST",
      path: "/api/cubes",
      principal,
      body: { protocol_version: "12", request_id: requestId, payload },
      signal: new AbortController().signal,
    });
    const retryKey = randomUUID();
    const created = await create("cube-create", {
      retry_key: retryKey,
      name: "Example",
      working_repo_name: "example",
      repository,
      template: "software-dev",
    });
    expect(created).toMatchObject({
      status: 201,
      body: {
        protocol_version: "12",
        request_id: "cube-create",
        payload: {
          result: "created",
          name: "Example",
          working_repo_name: "example",
          repository,
          template: "software-dev",
          access: "manage",
        },
      },
    });
    const createdPayload = (created.body as {
      payload: { cube_id: string; human_seat_role_id: string; default_worker_role_id: string };
    }).payload;
    const template = getTemplate("software-dev");
    if (template === null) throw new Error("Shared software-development template is unavailable.");
    const expectedRoles = [
      {
        name: "Coordinator",
        short_description: "Orders authorized work to start, verifies progress, preserves scope, and asks before rescoping or integrating.",
      },
      {
        name: "Builder",
        short_description: "Implements explicitly assigned software changes within the stated slice and returns exact verification evidence.",
      },
      {
        name: "Code Reviewer",
        short_description: "Reviews routed exact revisions for correctness, scope, tests, and maintainability without creating work.",
      },
      {
        name: "Release Quality",
        short_description: "Performs routed exact-revision behavior and documentation verification proportionate to the changed surface.",
      },
      {
        name: "Product Design",
        short_description: "Reviews routed user-facing behavior, accessibility, states, and copy; creates mockups only when useful.",
      },
      {
        name: "Product Strategy",
        short_description: "Produces bounded, source-verified product analysis and advisory proposals when requested.",
      },
      {
        name: "Security Auditor",
        short_description: "Reviews routed security-relevant touched surfaces and explicit sweeps without broadening scope.",
      },
    ];
    const expectedTaxonomy = template.message_taxonomy;
    expect(NEW_CUBE_TEMPLATE_PRESENTATIONS[0]).toEqual({
      name: "software-dev",
      label: "Software Development",
      short_description: "Recommended for code repositories.",
    });
    expect(template.roles.map(({ name, short_description }) => ({ name, short_description })))
      .toEqual(expectedRoles);
    expect(template.message_taxonomy).toEqual(expectedTaxonomy);

    const cubeRead = await api.handle({
      method: "GET",
      path: `/api/cubes/${createdPayload.cube_id}`,
      principal,
      signal: new AbortController().signal,
    });
    expect(cubeRead).toMatchObject({
      status: 200,
      body: {
        payload: {
          cube: {
            id: createdPayload.cube_id,
            cube_directive: expect.stringContaining(
              "A release tag starts the tag-restricted staging workflow automatically",
            ),
            message_taxonomy: expectedTaxonomy,
          },
        },
      },
    });
    const rolesRead = await api.handle({
      method: "GET",
      path: `/api/cubes/${createdPayload.cube_id}/roles`,
      principal,
      signal: new AbortController().signal,
    });
    expect(rolesRead.status).toBe(200);
    const roles = (rolesRead.body as {
      payload: {
        roles: Array<{
          id: string;
          name: string;
          short_description: string;
          detailed_description: string;
          is_default: boolean;
          is_human_seat: boolean;
        }>;
      };
    }).payload.roles;
    expect(roles).toHaveLength(expectedRoles.length);
    expect(roles.map((role) => role.name).sort()).toEqual(
      expectedRoles.map((role) => role.name).sort(),
    );
    expect(expectedRoles.map((expected) => roles.find((role) => role.name === expected.name)))
      .toEqual(expectedRoles.map((expected) => expect.objectContaining(expected)));
    const coordinator = roles.find((role) => role.name === "Coordinator")!;
    const builder = roles.find((role) => role.name === "Builder")!;
    expect(coordinator).toMatchObject({
      id: createdPayload.human_seat_role_id,
      is_default: false,
      is_human_seat: true,
    });
    expect(builder).toMatchObject({
      id: createdPayload.default_worker_role_id,
      is_default: true,
      is_human_seat: false,
    });
    for (const phrase of [
      "Require one proof per property",
      "Mechanical, version, lock, and generated changes require exact-revision CI plus one Code Review only",
      "Give a successor revision delta review",
      "Carry unchanged green evidence without rerunning it",
    ]) {
      expect(coordinator.detailed_description).toContain(phrase);
    }
    for (const phrase of [
      "Post PROGRESS only when a substantive milestone changes what the Coordinator needs to know",
      "Do not interrupt slow local work merely to satisfy a reporting cadence",
      "Run focused verification required by the touched surface",
      "do not rerun green CI checks merely to duplicate exact-revision evidence",
      "Check documentation or a separately published site only when the changed behavior, public API, package metadata, or named user claim belongs to that surface",
    ]) {
      expect(builder.detailed_description).toContain(phrase);
    }
    const directive = (cubeRead.body as {
      payload: { cube: { cube_directive: string } };
    }).payload.cube.cube_directive;
    for (const phrase of [
      "A release tag starts the tag-restricted staging workflow automatically",
      "npm stage approval is the sole human publication boundary",
      "Before npm accepts a stage, correct a failed workflow and retry the same immutable tag",
      "Never move, replace, or force-update the tag",
    ]) {
      expect(directive).toContain(phrase);
    }

    const resolved = await create("cube-resolve", {
      retry_key: randomUUID(),
      name: "Ignored replacement",
      working_repo_name: "ignored-display",
      repository,
      template: "starter",
    });
    expect(resolved).toMatchObject({
      status: 201,
      body: {
        payload: {
          result: "resolved",
          cube_id: createdPayload.cube_id,
          name: "Example",
          working_repo_name: "example",
          repository,
          template: "software-dev",
          human_seat_role_id: createdPayload.human_seat_role_id,
          default_worker_role_id: createdPayload.default_worker_role_id,
        },
      },
    });
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 1,
      cube_create_bindings: 1,
      repository_associations: 1,
    });

    const conflict = await create("cube-conflict", {
      retry_key: retryKey,
      name: "Example",
      working_repo_name: "example",
      repository: { kind: "local", value: randomUUID() },
      template: "starter",
    });
    expect(conflict).toEqual({
      status: 409,
      body: {
        protocol_version: "12",
        request_id: "cube-conflict",
        error: {
          code: "INVALID_INPUT",
          message: "The cube creation request conflicts.",
        },
      },
    });
    expect(JSON.stringify(conflict)).not.toContain(repository.value);

    const invalid = await create("cube-invalid", {
      retry_key: randomUUID(),
      name: "Example",
      working_repo_name: "example",
      repository: { kind: "origin", value: "https://token@example.com/private" },
      template: "starter",
      extra: true,
    });
    expect(invalid).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_INPUT", message: "Invalid protocol request." } },
    });
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 1,
      cube_create_bindings: 1,
      repository_associations: 1,
    });
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
        protocol_version: "12",
        request_id: "capacity-request",
        payload: { post_id: randomUUID(), message: "secret-capacity-payload", to: "broadcast" },
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
        protocol_version: "12",
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

  it("capacity-gates own metadata after non-disclosing scope checks", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-metadata-capacity-")));
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
    digester = new CredentialDigester(Buffer.alloc(32, 6));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const clientId = "00000000-0000-4000-8000-000000000035";
    const cubeId = "00000000-0000-4000-8000-000000000036";
    const foreignCubeId = "00000000-0000-4000-8000-000000000037";
    const roleId = "00000000-0000-4000-8000-000000000038";
    const droneId = "00000000-0000-4000-8000-000000000039";
    const sessionId = "00000000-0000-4000-8000-000000000040";
    runtime.maintenance.createClient({ id: clientId, name: "Metadata client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Metadata", directive: "" });
    runtime.maintenance.createCube({ id: foreignCubeId, name: "Foreign", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    runtime.maintenance.createDrone({
      id: droneId,
      cubeId,
      roleId,
      clientId,
      label: "builder-capacity",
    });
    runtime.maintenance.createDroneSession({ id: sessionId, clientId, cubeId, droneId });
    const principal = droneSessionPrincipal({ id: sessionId, clientId, cubeId, droneId });
    const manager = runtime.forPrincipal(clientPrincipal(clientId));
    const before = manager.listDrones(cubeId).find(({ id }) => id === droneId);
    const api = new CoordinationApi(runtime, authority);
    const update = (targetCubeId: string, requestId: string, marker: string) => api.handle({
      method: "PATCH",
      path: `/api/cubes/${targetCubeId}/drones/self/metadata`,
      principal,
      body: {
        protocol_version: "12",
        request_id: requestId,
        payload: { reported_model: marker },
      },
      signal: new AbortController().signal,
    });

    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };
    const databasePressure = await update(cubeId, "metadata-capacity-db", "database-pressure-secret");
    expect(databasePressure).toMatchObject({
      status: 507,
      body: {
        request_id: "metadata-capacity-db",
        error: { code: "CAPACITY_EXCEEDED", message: "Storage capacity is unavailable." },
      },
    });
    expect(JSON.stringify(databasePressure.body)).not.toContain("database-pressure-secret");

    capacity = { databaseBytes: 0, freeDiskBytes: 0 };
    const diskPressure = await update(cubeId, "metadata-capacity-disk", "disk-pressure-secret");
    expect(diskPressure).toMatchObject({
      status: 507,
      body: {
        request_id: "metadata-capacity-disk",
        error: { code: "CAPACITY_EXCEEDED", message: "Storage capacity is unavailable." },
      },
    });
    expect(JSON.stringify(diskPressure.body)).not.toContain("disk-pressure-secret");
    expect(manager.listDrones(cubeId).find(({ id }) => id === droneId)).toEqual(before);

    const foreign = await update(foreignCubeId, "metadata-scope-probe", "foreign-secret");
    const unknown = await update(
      "00000000-0000-4000-8000-000000000099",
      "metadata-scope-probe",
      "unknown-secret",
    );
    expect(foreign).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect(unknown).toEqual(foreign);
    expect(JSON.stringify([foreign.body, unknown.body]))
      .not.toMatch(/foreign-secret|unknown-secret/u);
  });

  it("updates migrated cube context and routes activity through its taxonomy", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-context-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 7));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const api = new CoordinationApi(runtime, authority);
    const managerId = "00000000-0000-4000-8000-000000000081";
    const readerId = "00000000-0000-4000-8000-000000000082";
    const cubeId = "00000000-0000-4000-8000-000000000083";
    const coordinatorRoleId = "00000000-0000-4000-8000-000000000084";
    const reviewerRoleId = "00000000-0000-4000-8000-000000000085";
    const coordinatorDroneId = "00000000-0000-4000-8000-000000000086";
    const reviewerDroneId = "00000000-0000-4000-8000-000000000087";
    runtime.maintenance.createClient({ id: managerId, name: "Manager" });
    runtime.maintenance.createClient({ id: readerId, name: "Reader" });
    runtime.maintenance.createCube({ id: cubeId, name: "Migrated", directive: "old" });
    runtime.maintenance.grantClientCube({ clientId: managerId, cubeId, access: "manage" });
    runtime.maintenance.grantClientCube({ clientId: readerId, cubeId, access: "read" });
    runtime.maintenance.createRole({
      id: coordinatorRoleId, cubeId, name: "Coordinator", isHumanSeat: true, roleClass: "queen",
    });
    runtime.maintenance.createRole({ id: reviewerRoleId, cubeId, name: "Code Reviewer" });
    runtime.maintenance.createDrone({
      id: coordinatorDroneId,
      cubeId,
      roleId: coordinatorRoleId,
      clientId: managerId,
      label: "one-coordinator",
    });
    runtime.maintenance.createDrone({
      id: reviewerDroneId,
      cubeId,
      roleId: reviewerRoleId,
      clientId: managerId,
      label: "one-reviewer",
    });
    const manager = clientPrincipal(managerId);
    const taxonomy = [{
      class: "completion",
      prefixes: ["DONE"],
      lifecycle: "completion",
    }];
    const updated = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "cube-context-update",
         payload: { cube_directive: "é".repeat(4), message_taxonomy: taxonomy },
      },
      signal: new AbortController().signal,
    });
    expect(updated).toMatchObject({
      status: 200,
      body: { request_id: "cube-context-update", payload: { cube: {
         cube_directive: "éééé",
         message_taxonomy: taxonomy,
      }, advisory: "Directive updated (8 bytes). Review it for relevance and compactness." } },
    });
    const malformedTaxonomy = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "cube-taxonomy-invalid",
        payload: {
          message_taxonomy: [{ class: "completion", lifecycle: "finished" }],
        },
      },
      signal: new AbortController().signal,
    });
    expect(malformedTaxonomy).toMatchObject({
      status: 400,
      body: {
        request_id: "cube-taxonomy-invalid",
        error: {
          code: "INVALID_INPUT",
          message: "Invalid message_taxonomy: Message taxonomy lifecycle must be dispatch or completion.",
        },
      },
    });
    const largeDirective = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "cube-context-large",
         payload: { cube_directive: "é".repeat(8_192) },
      },
      signal: new AbortController().signal,
    });
    expect(largeDirective).toMatchObject({
      status: 200,
      body: {
        payload: {
          advisory: expect.stringContaining("Directive is 16384 bytes, at or above the 16384 byte guideline"),
        },
      },
    });
    const denied = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}`,
      principal: clientPrincipal(readerId),
      body: {
        protocol_version: "12",
        request_id: "cube-context-denied",
        payload: { cube_directive: "denied" },
      },
      signal: new AbortController().signal,
    });
    expect(denied).toMatchObject({
      status: 403,
      body: { error: { code: "ACCESS_DENIED", message: "Access denied." } },
    });
    const malformedDenied = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}`,
      principal: clientPrincipal(readerId),
      body: {
        protocol_version: "12",
        request_id: "cube-taxonomy-denied",
        payload: {
          message_taxonomy: [{ class: "completion", lifecycle: "finished" }],
        },
      },
      signal: new AbortController().signal,
    });
    expect(malformedDenied).toMatchObject({
      status: 403,
      body: { error: { code: "ACCESS_DENIED", message: "Access denied." } },
    });

    const routed = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "taxonomy-route",
        payload: { post_id: randomUUID(), message: "DONE: migrated", to: "broadcast" },
      },
      signal: new AbortController().signal,
    });
    expect(routed).toMatchObject({
      status: 201,
      body: { payload: {
        entry: { visibility: "broadcast", recipient_drone_ids: [] },
        routing: { class: "completion", recipients: [] },
      } },
    });
    const explicitlyRouted = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "taxonomy-explicit-route",
        payload: { post_id: randomUUID(), message: "manual completion", class: "completion", to: ["code-reviewer"] },
      },
      signal: new AbortController().signal,
    });
    expect(explicitlyRouted).toMatchObject({
      status: 201,
      body: { payload: {
        entry: { visibility: "direct", recipient_drone_ids: [reviewerDroneId] },
      } },
    });

    const patched = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/taxonomy-patch`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "taxonomy-replace",
        payload: {
          action: "replace",
          class_def: { class: "completion", prefixes: ["FINISHED"], lifecycle: "completion" },
        },
      },
      signal: new AbortController().signal,
    });
    expect(patched).toMatchObject({
      status: 200,
      body: { payload: { cube: { message_taxonomy: [{
        class: "completion", prefixes: ["FINISHED"], lifecycle: "completion",
      }] } } },
    });
    const broadcast = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/logs`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "taxonomy-broadcast",
        payload: { post_id: randomUUID(), message: "DONE: all seats", to: "broadcast" },
      },
      signal: new AbortController().signal,
    });
    expect(broadcast).toMatchObject({
      status: 201,
      body: { payload: { entry: { visibility: "broadcast", recipient_drone_ids: [] } } },
    });
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
          protocol_version: "12",
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
    const body = { protocol_version: "12", request_id: "role-create-request", payload };

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
        protocol_version: "12",
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
        protocol_version: "12",
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
    expect(updated.body).not.toHaveProperty("payload.advisory");
    const detailedUpdated = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "role-detailed-update",
        payload: { detailed_description: "é".repeat(4) },
      },
      signal: new AbortController().signal,
    });
    expect(detailedUpdated).toMatchObject({
      status: 200,
      body: {
        payload: {
          advisory: "Playbook updated (8 bytes). Review it for relevance and compactness.",
        },
      },
    });
    const patched = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "role-section-request",
        payload: { action: "replace", heading: "Release workflow", body: "Review exact SHA." },
      },
      signal: new AbortController().signal,
    });
    expect(patched).toMatchObject({
      status: 409,
      body: {
        request_id: "role-section-request",
        error: {
          code: "ROLE_SECTION_CONFLICT",
          message: "The target role section does not exist.",
        },
      },
    });
    const inserted = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
      principal: manager,
      body: {
        protocol_version: "12",
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
      }, advisory: "Playbook updated (45 bytes). Review it for relevance and compactness." } },
    });
    const replaced = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "role-section-replace",
        payload: { action: "replace", heading: "Release workflow", body: "é".repeat(8_192) },
      },
      signal: new AbortController().signal,
    });
    expect(replaced).toMatchObject({
      status: 200,
      body: {
        payload: {
          advisory: expect.stringContaining("Playbook is 16412 bytes, at or above the 16384 byte guideline"),
        },
      },
    });
    const afterInsert = runtime.forPrincipal(manager).listRoles(cubeId)
      .find((role) => role.id === createdRoleId)!.detailed_description;
    for (const [requestId, patchPayload, message] of [
      [
        "role-section-target-missing",
        { action: "delete", heading: "Missing" },
        "The target role section does not exist.",
      ],
      [
        "role-section-target-exists",
        { action: "insert", heading: "Release workflow", body: "Duplicate." },
        "The target role section already exists.",
      ],
      [
        "role-section-insertion-point-missing",
        { action: "insert", heading: "Review gate", body: "Review.", after: "Missing" },
        "The role section insertion point does not exist.",
      ],
    ] as const) {
      const conflict = await api.handle({
        method: "POST",
        path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
        principal: manager,
        body: {
          protocol_version: "12",
          request_id: requestId,
          payload: patchPayload,
        },
        signal: new AbortController().signal,
      });
      expect(conflict).toMatchObject({
        status: 409,
        body: {
          request_id: requestId,
          error: { code: "ROLE_SECTION_CONFLICT", message },
        },
      });
      expect(runtime.forPrincipal(manager).listRoles(cubeId)
        .find((role) => role.id === createdRoleId)!.detailed_description).toBe(afterInsert);
    }
    const deleted = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "role-section-delete",
        payload: { action: "delete", heading: "Release workflow" },
      },
      signal: new AbortController().signal,
    });
    expect(deleted).toMatchObject({
      status: 200,
      body: {
        payload: {
          advisory: "Playbook updated (9 bytes). Review it for relevance and compactness.",
        },
      },
    });
    const invalidHeading = await api.handle({
      method: "POST",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}/section-patch`,
      principal: manager,
      body: {
        protocol_version: "12",
        request_id: "role-section-invalid-heading",
        payload: { action: "delete", heading: "**Markdown**" },
      },
      signal: new AbortController().signal,
    });
    expect(invalidHeading).toMatchObject({
      status: 400,
      body: {
        request_id: "role-section-invalid-heading",
        error: { code: "INVALID_INPUT" },
      },
    });
    expect(runtime.forPrincipal(manager).listRoles(cubeId)
      .find((role) => role.id === createdRoleId)!.detailed_description).toBe("éééé\n");

    for (const [principal, status, code] of [
      [clientPrincipal(readerId), 403, "ACCESS_DENIED"],
      [
        droneSessionPrincipal({ id: sessionId, clientId: managerId, cubeId, droneId }),
        403,
        "ACCESS_DENIED",
      ],
    ] as const) {
      const denied = await api.handle({
        method: "POST",
        path: `/api/cubes/${cubeId}/roles`,
        principal,
        body: { ...body, request_id: "role-denied-request", payload: { name: "Denied" } },
        signal: new AbortController().signal,
      });
      expect(denied).toMatchObject({ status, body: { error: { code } } });
      const updateDenied = await api.handle({
        method: "PATCH",
        path: `/api/cubes/${cubeId}/roles/${createdRoleId}`,
        principal,
        body: { ...body, request_id: "role-update-denied", payload: { name: "Denied" } },
        signal: new AbortController().signal,
      });
      expect(updateDenied).toMatchObject({ status, body: { error: { code } } });
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
    const classified = await api.handle({
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
    expect(classified).toMatchObject({
      status: 201,
      body: { request_id: "role-invalid-request", payload: { role: { role_class: "queen" } } },
    });
    const invalidClass = await api.handle({
      method: "PATCH",
      path: `/api/cubes/${cubeId}/roles/${createdRoleId}`,
      principal: manager,
      body: { ...body, request_id: "role-class-invalid", payload: { role_class: "admin" } },
      signal: new AbortController().signal,
    });
    expect(invalidClass).toMatchObject({
      status: 400,
      body: { request_id: "role-class-invalid", error: { code: "INVALID_INPUT" } },
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
      .toEqual(["Queen", "Release Quality", "Security Auditor"]);
  });

  it("deletes an unused role after eviction while preserving the evicted drone's activity attribution", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-role-delete-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 31));
    const api = new CoordinationApi(runtime, new CredentialAuthority(runtime.credentials, digester));
    const managerId = "00000000-0000-4000-8000-000000000201";
    const cubeId = "00000000-0000-4000-8000-000000000202";
    const droneId = "00000000-0000-4000-8000-000000000203";
    const sessionId = "00000000-0000-4000-8000-000000000204";
    runtime.maintenance.createClient({ id: managerId, name: "Manager" });
    runtime.maintenance.createCube({ id: cubeId, name: "Role deletion", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: managerId, cubeId, access: "manage" });
    const manager = runtime.forPrincipal(clientPrincipal(managerId));
    const fallback = manager.createRole(cubeId, { name: "Builder", isDefault: true });
    const obsolete = manager.createRole(cubeId, { name: "Obsolete" });
    runtime.maintenance.createDrone({
      id: droneId, cubeId, roleId: obsolete.id, clientId: managerId, label: "obsolete-one",
    });
    runtime.maintenance.createDroneSession({ id: sessionId, clientId: managerId, cubeId, droneId });
    const entry = runtime.forPrincipal(droneSessionPrincipal({
      id: sessionId, clientId: managerId, cubeId, droneId,
    })).appendLog(cubeId, { visibility: "broadcast", message: "historical attribution" });
    const request = (requestId: string) => ({
      method: "DELETE" as const,
      path: `/api/cubes/${cubeId}/roles/${obsolete.id}`,
      principal: clientPrincipal(managerId),
      body: { protocol_version: "12", request_id: requestId, payload: {} },
      signal: new AbortController().signal,
    });

    expect(await api.handle(request("role-delete-in-use"))).toMatchObject({
      status: 409,
      body: {
        request_id: "role-delete-in-use",
        error: {
          code: "ROLE_IN_USE",
          message: "Reassign or evict every drone assigned to this role before deleting it.",
        },
      },
    });
    manager.evictDrone(cubeId, droneId);

    expect(await api.handle(request("role-delete-success"))).toMatchObject({
      status: 200,
      body: {
        request_id: "role-delete-success",
        payload: { role_id: obsolete.id, deleted: true },
      },
    });
    expect(manager.listRoles(cubeId).map((role) => role.id)).not.toContain(obsolete.id);
    expect(manager.listDrones(cubeId)).toEqual([]);
    expect(manager.readLogEntry(cubeId, entry.id)).toMatchObject({
      drone_id: droneId,
      drone_label: "obsolete-one",
      role_name: fallback.name,
      message: "historical attribution",
    });
  });

  it("refuses deletion of required roles without taxonomy-based role retention", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-role-delete-guards-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 32));
    const api = new CoordinationApi(runtime, new CredentialAuthority(runtime.credentials, digester));
    const managerId = "00000000-0000-4000-8000-000000000211";
    const readerId = "00000000-0000-4000-8000-000000000212";
    const cubeId = "00000000-0000-4000-8000-000000000213";
    runtime.maintenance.createClient({ id: managerId, name: "Manager" });
    runtime.maintenance.createClient({ id: readerId, name: "Reader" });
    runtime.maintenance.createCube({ id: cubeId, name: "Role guards", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: managerId, cubeId, access: "manage" });
    runtime.maintenance.grantClientCube({ clientId: readerId, cubeId, access: "read" });
    const manager = runtime.forPrincipal(clientPrincipal(managerId));
    const defaultRole = manager.createRole(cubeId, { name: "Builder", isDefault: true });
    const mandatoryRole = manager.createRole(cubeId, { name: "Coordinator", isMandatory: true });
    const humanRole = manager.createRole(cubeId, { name: "Human", isHumanSeat: true });
    const routedRole = manager.createRole(cubeId, { name: "Code Reviewer" });
    const deletion = (roleId: string, requestId: string, principal: Principal = clientPrincipal(managerId)) =>
      api.handle({
        method: "DELETE",
        path: `/api/cubes/${cubeId}/roles/${roleId}`,
        principal,
        body: { protocol_version: "12", request_id: requestId, payload: {} },
        signal: new AbortController().signal,
      });

    for (const [roleId, requestId, code] of [
      [defaultRole.id, "role-delete-default", "DEFAULT_ROLE_REQUIRED"],
      [mandatoryRole.id, "role-delete-mandatory", "ROLE_REQUIRED"],
      [humanRole.id, "role-delete-human", "ROLE_REQUIRED"],
    ] as const) {
      expect(await deletion(roleId, requestId)).toMatchObject({
        status: 409,
        body: { request_id: requestId, error: { code } },
      });
    }
    expect(await deletion(randomUUID(), "role-delete-missing")).toMatchObject({
      status: 404,
      body: { request_id: "role-delete-missing", error: { code: "NOT_FOUND" } },
    });
    expect(await deletion(routedRole.id, "role-delete-reader", clientPrincipal(readerId)))
      .toMatchObject({
        status: 403,
        body: { request_id: "role-delete-reader", error: { code: "ACCESS_DENIED" } },
      });
    expect(await deletion(routedRole.id, "role-delete-routed")).toMatchObject({
      status: 200,
      body: { request_id: "role-delete-routed", payload: { role_id: routedRole.id, deleted: true } },
    });
    expect(manager.listRoles(cubeId).map((role) => role.id)).toEqual(expect.arrayContaining([
      defaultRole.id, mandatoryRole.id, humanRole.id,
    ]));
    expect(manager.listRoles(cubeId).map((role) => role.id)).not.toContain(routedRole.id);
  });

  it("reads one named role rationale section with typed missing-role and missing-section refusals", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-role-rationale-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 33));
    const api = new CoordinationApi(runtime, new CredentialAuthority(runtime.credentials, digester));
    const managerId = "00000000-0000-4000-8000-000000000221";
    const readerId = "00000000-0000-4000-8000-000000000222";
    const foreignId = "00000000-0000-4000-8000-000000000223";
    const cubeId = "00000000-0000-4000-8000-000000000224";
    runtime.maintenance.createClient({ id: managerId, name: "Manager" });
    runtime.maintenance.createClient({ id: readerId, name: "Reader" });
    runtime.maintenance.createClient({ id: foreignId, name: "Foreign" });
    runtime.maintenance.createCube({ id: cubeId, name: "Role rationale", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: managerId, cubeId, access: "manage" });
    runtime.maintenance.grantClientCube({ clientId: readerId, cubeId, access: "read" });
    const role = runtime.forPrincipal(clientPrincipal(managerId)).createRole(cubeId, {
      name: "Builder",
      detailedDescription: "Build changes.\n\nWorkflow rationale:\nKeep the patch narrow.\n\nLimits:\nNo release.\n",
    });
    const request = (requestId: string, payload: Record<string, unknown>, principal: Principal) =>
      api.handle({
        method: "POST",
        path: `/api/cubes/${cubeId}/role-rationale`,
        principal,
        body: { protocol_version: "12", request_id: requestId, payload },
        signal: new AbortController().signal,
      });

    expect(await request("role-rationale-read", {
      role: "builder", section: "workflow rationale",
    }, clientPrincipal(readerId))).toMatchObject({
      status: 200,
      body: {
        request_id: "role-rationale-read",
        payload: {
          role_id: role.id,
          role_name: "Builder",
          section: {
            heading: "Workflow rationale",
            body: "Workflow rationale:\nKeep the patch narrow.\n\n",
          },
        },
      },
    });
    expect(await request("role-rationale-missing-role", {
      role: "Missing", section: "Workflow rationale",
    }, clientPrincipal(readerId))).toMatchObject({
      status: 404,
      body: { request_id: "role-rationale-missing-role", error: { code: "ROLE_NOT_FOUND" } },
    });
    expect(await request("role-rationale-missing-section", {
      role: role.id, section: "Missing",
    }, clientPrincipal(readerId))).toMatchObject({
      status: 404,
      body: {
        request_id: "role-rationale-missing-section",
        error: { code: "ROLE_SECTION_NOT_FOUND" },
      },
    });
    runtime.forPrincipal(clientPrincipal(managerId)).createRole(cubeId, {
      name: "builder",
      detailedDescription: "Workflow rationale:\nAmbiguous role.\n",
    });
    expect(await request("role-rationale-ambiguous", {
      role: "BUILDER", section: "Workflow rationale",
    }, clientPrincipal(readerId))).toMatchObject({
      status: 400,
      body: { request_id: "role-rationale-ambiguous", error: { code: "INVALID_INPUT" } },
    });
    expect(await request("role-rationale-id-exact", {
      role: role.id, section: "Workflow rationale",
    }, clientPrincipal(readerId))).toMatchObject({
      status: 200,
      body: { request_id: "role-rationale-id-exact", payload: { role_id: role.id } },
    });
    const database = new DatabaseSync(join(directory, "borg.db"));
    database.prepare("UPDATE roles SET detailed_description = ? WHERE id = ?").run(
      `Oversized rationale:\n${"x".repeat(51_200)}`,
      role.id,
    );
    database.close();
    expect(await request("role-rationale-oversized", {
      role: role.id, section: "Oversized rationale",
    }, clientPrincipal(readerId))).toMatchObject({
      status: 400,
      body: { request_id: "role-rationale-oversized", error: { code: "INVALID_INPUT" } },
    });
    expect(await request("role-rationale-foreign", {
      role: role.id, section: "Workflow rationale",
    }, clientPrincipal(foreignId))).toMatchObject({
      status: 404,
      body: { request_id: "role-rationale-foreign", error: { code: "NOT_FOUND" } },
    });
    expect(await request("role-rationale-invalid", {
      role: role.id, section: "**Markdown**",
    }, clientPrincipal(readerId))).toMatchObject({
      status: 400,
      body: { request_id: "role-rationale-invalid", error: { code: "INVALID_INPUT" } },
    });
  });

  it("distinguishes known non-managers from undisclosed cubes across administration routes", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-manage-access-")));
    directories.push(directory);
    runtime = await openStore({
      path: join(directory, "borg.db"),
      clock: () => new Date("2026-07-19T18:00:00.000Z"),
    });
    digester = new CredentialDigester(Buffer.alloc(32, 25));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const api = new CoordinationApi(runtime, authority);
    const managerId = "00000000-0000-4000-8000-0000000000f1";
    const readerId = "00000000-0000-4000-8000-0000000000f2";
    const writerId = "00000000-0000-4000-8000-0000000000f3";
    const ungrantedId = "00000000-0000-4000-8000-0000000000f4";
    const foreignManagerId = "00000000-0000-4000-8000-0000000000f5";
    const cubeId = "00000000-0000-4000-8000-0000000000f6";
    const foreignCubeId = "00000000-0000-4000-8000-0000000000f7";
    const unknownCubeId = "00000000-0000-4000-8000-0000000000f8";
    const roleId = "00000000-0000-4000-8000-0000000000f9";
    const droneId = "00000000-0000-4000-8000-0000000000fa";
    const sessionId = "00000000-0000-4000-8000-0000000000fb";
    for (const [id, name] of [
      [managerId, "Manager"],
      [readerId, "Reader"],
      [writerId, "Writer"],
      [ungrantedId, "Ungranted"],
      [foreignManagerId, "Foreign manager"],
    ] as const) {
      runtime.maintenance.createClient({ id, name });
    }
    runtime.maintenance.createCube({ id: cubeId, name: "Managed cube", directive: "original" });
    runtime.maintenance.createCube({ id: foreignCubeId, name: "Foreign cube", directive: "foreign" });
    runtime.maintenance.grantClientCube({ clientId: managerId, cubeId, access: "manage" });
    runtime.maintenance.grantClientCube({ clientId: readerId, cubeId, access: "read" });
    runtime.maintenance.grantClientCube({ clientId: writerId, cubeId, access: "write" });
    runtime.maintenance.grantClientCube({
      clientId: foreignManagerId, cubeId: foreignCubeId, access: "manage",
    });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    runtime.maintenance.createDrone({
      id: droneId, cubeId, roleId, clientId: managerId, label: "builder-one",
    });
    runtime.maintenance.createDroneSession({
      id: sessionId,
      clientId: managerId,
      cubeId,
      droneId,
    });
    const manager = clientPrincipal(managerId);
    const snapshot = () => JSON.stringify({
      cube: runtime!.forPrincipal(manager).getCube(cubeId),
      roles: runtime!.forPrincipal(manager).listRoles(cubeId),
      decisions: runtime!.forPrincipal(manager).listDecisions(cubeId),
    });
    const operations = [
      {
        name: "cube update",
        method: "PATCH",
        path: (targetCubeId: string) => `/api/cubes/${targetCubeId}`,
        payload: { cube_directive: "updated" },
        successStatus: 200,
      },
      {
        name: "taxonomy patch",
        method: "POST",
        path: (targetCubeId: string) => `/api/cubes/${targetCubeId}/taxonomy-patch`,
        payload: {
          action: "add",
          class_def: { class: "completion", prefixes: ["DONE"] },
        },
        successStatus: 200,
      },
      {
        name: "role create",
        method: "POST",
        path: (targetCubeId: string) => `/api/cubes/${targetCubeId}/roles`,
        payload: { name: "Reviewer" },
        successStatus: 201,
      },
      {
        name: "role update",
        method: "PATCH",
        path: (targetCubeId: string) => `/api/cubes/${targetCubeId}/roles/${roleId}`,
        payload: { short_description: "Updated builder" },
        successStatus: 200,
      },
      {
        name: "role section patch",
        method: "POST",
        path: (targetCubeId: string) => `/api/cubes/${targetCubeId}/roles/${roleId}/section-patch`,
        payload: { action: "insert", heading: "Workflow", body: "Build and verify." },
        successStatus: 200,
      },
      {
        name: "decision record",
        method: "POST",
        path: (targetCubeId: string) => `/api/cubes/${targetCubeId}/decisions`,
        payload: { topic: "release", decision: "Ship reviewed artifacts." },
        successStatus: 201,
      },
    ] as const;
    const request = (
      operation: typeof operations[number],
      principal: Principal,
      targetCubeId = cubeId,
    ) => api.handle({
      method: operation.method,
      path: operation.path(targetCubeId),
      principal,
      body: {
        protocol_version: "12",
        request_id: `manage-${operation.name.replaceAll(" ", "-")}`,
        payload: operation.payload,
      },
      signal: new AbortController().signal,
    });
    const drone = droneSessionPrincipal({ id: sessionId, clientId: managerId, cubeId, droneId });

    for (const operation of operations) {
      const before = snapshot();
      for (const principal of [clientPrincipal(readerId), clientPrincipal(writerId)]) {
        const denied = await request(operation, principal);
        expect(denied, operation.name).toMatchObject({
          status: 403,
          body: { error: { code: "ACCESS_DENIED", message: "Access denied." } },
        });
        expect(snapshot(), operation.name).toBe(before);
      }
      for (const principal of [clientPrincipal(ungrantedId), clientPrincipal(foreignManagerId)]) {
        const hidden = await request(operation, principal);
        expect(hidden, operation.name).toMatchObject({
          status: 404,
          body: { error: { code: "NOT_FOUND" } },
        });
        expect(snapshot(), operation.name).toBe(before);
      }
      const droneDenied = await request(operation, drone);
      expect(droneDenied, operation.name).toMatchObject({
        status: 403,
        body: { error: { code: "ACCESS_DENIED", message: "Access denied." } },
      });
      expect(snapshot(), operation.name).toBe(before);
      const foreignDrone = await request(operation, drone, foreignCubeId);
      expect(foreignDrone, operation.name).toMatchObject({
        status: 404,
        body: { error: { code: "NOT_FOUND" } },
      });
      expect(snapshot(), operation.name).toBe(before);
      const unknown = await request(operation, manager, unknownCubeId);
      expect(unknown, operation.name).toMatchObject({
        status: 404,
        body: { error: { code: "NOT_FOUND" } },
      });
      expect(snapshot(), operation.name).toBe(before);

      const succeeded = await request(operation, manager);
      expect(succeeded.status, operation.name).toBe(operation.successStatus);
      expect(snapshot(), operation.name).not.toBe(before);
    }
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
        protocol_version: "12",
        request_id: "debug-append-request",
        payload: { post_id: randomUUID(), message, to: [droneId] },
      },
      signal,
    });
    const entryId = (appended.body as any).payload.entry.id as string;
    await api.handle({
      method: "PUT",
      path: `/api/cubes/${cubeId}/logs`,
      principal,
      body: {
        protocol_version: "12",
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
        protocol_version: "12",
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
        protocol_version: "12",
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

async function createNotificationPressureFixture(
  entryCount: number,
  name: string,
  debugLogger = disabledDebugLogger,
  direct = false,
  clock?: () => Date,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `borg-api-notification-${name}-`)));
  directories.push(directory);
  runtime = await openStore({ path: join(directory, "borg.db"), ...(clock === undefined ? {} : { clock }) });
  digester = new CredentialDigester(Buffer.alloc(32, 36));
  const authority = new CredentialAuthority(runtime.credentials, digester);
  const clientId = "00000000-0000-4000-8000-000000000401";
  const cubeId = "00000000-0000-4000-8000-000000000402";
  const roleId = "00000000-0000-4000-8000-000000000403";
  const authorDroneId = "00000000-0000-4000-8000-000000000404";
  const peerDroneId = "00000000-0000-4000-8000-000000000405";
  const outsiderDroneId = "00000000-0000-4000-8000-000000000406";
  runtime.maintenance.createClient({ id: clientId, name: "Notification pressure" });
  runtime.maintenance.createCube({ id: cubeId, name: "Notification pressure", directive: "" });
  runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
  runtime.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
  const droneRecords = [
    [authorDroneId, "00000000-0000-4000-8000-000000000407", "author"],
    [peerDroneId, "00000000-0000-4000-8000-000000000408", "peer"],
    [outsiderDroneId, "00000000-0000-4000-8000-000000000409", "outsider"],
  ] as const;
  for (const [droneId, sessionId, label] of droneRecords) {
    runtime.maintenance.createDrone({ id: droneId, cubeId, roleId, clientId, label });
    runtime.maintenance.createDroneSession({ id: sessionId, clientId, cubeId, droneId });
  }
  const authorPrincipal = droneSessionPrincipal({
    id: droneRecords[0][1], clientId, cubeId, droneId: authorDroneId,
  });
  const peerPrincipal = droneSessionPrincipal({
    id: droneRecords[1][1], clientId, cubeId, droneId: peerDroneId,
  });
  const outsiderPrincipal = droneSessionPrincipal({
    id: droneRecords[2][1], clientId, cubeId, droneId: outsiderDroneId,
  });
  const authorStore = runtime.forPrincipal(authorPrincipal);
  const peerStore = runtime.forPrincipal(peerPrincipal);
  const cursorEntry = authorStore.appendLog(cubeId, { visibility: "broadcast", message: "cursor seed" });
  const entries = Array.from({ length: entryCount }, (_, index) => authorStore.appendLog(
    cubeId,
    direct
      ? {
          visibility: "direct",
          recipientDroneIds: [authorDroneId],
          message: `notification-${index}`,
        }
      : { visibility: "broadcast", message: `notification-${index}` },
  ));
  const lastEntry = entries.at(-1) ?? cursorEntry;
  return {
    api: new CoordinationApi(runtime, authority, debugLogger),
    cubeId,
    cursor: Buffer.from(JSON.stringify({
      id: cursorEntry.id,
      created_at: cursorEntry.created_at,
    })).toString("base64url"),
    lastEntryCursor: Buffer.from(JSON.stringify({
      id: lastEntry.id,
      created_at: lastEntry.created_at,
    })).toString("base64url"),
    entries,
    authorStore,
    peerStore,
    authorPrincipal,
    outsiderPrincipal,
  };
}

describe("decision removal API", () => {
  it("removes by topic or id and returns the retained audit record", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-remove-decision-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 27));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-0000000000f6";
    const clientId = "00000000-0000-4000-8000-0000000000f7";
    runtime.maintenance.createClient({ id: clientId, name: "Decision manager" });
    runtime.maintenance.createCube({ id: cubeId, name: "Decision removal", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const principal = clientPrincipal(clientId);
    const store = runtime.forPrincipal(principal);
    const api = new CoordinationApi(runtime, authority);
    const byTopic = store.recordDecision(cubeId, { topic: "topic-api-removal", decision: "remove by topic" });
    const byId = store.recordDecision(cubeId, { topic: "id-api-removal", decision: "remove by id" });
    const request = (payload: Record<string, string>) => api.handle({
      method: "DELETE",
      path: `/api/cubes/${cubeId}/decisions`,
      principal,
      body: { protocol_version: "12", request_id: "remove-decision", payload },
      signal: new AbortController().signal,
    });

    await expect(request({ topic: byTopic.topic })).resolves.toMatchObject({
      status: 200,
      body: { payload: { decision: { id: byTopic.id, status: "removed" } } },
    });
    await expect(request({ decision_id: byId.id })).resolves.toMatchObject({
      status: 200,
      body: { payload: { decision: { id: byId.id, status: "removed" } } },
    });
    await expect(request({ decision_id: byId.id })).resolves.toMatchObject({
      status: 404,
      body: { error: { code: "NOT_FOUND" } },
    });
  });
});

describe("cross-cube drone management", () => {
  it("lets a non-member parent client with a manage grant evict a target cube drone", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-cross-cube-evict-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 25));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const managerClientId = "00000000-0000-4000-8000-0000000000f1";
    const targetClientId = "00000000-0000-4000-8000-0000000000f2";
    const managerCubeId = "00000000-0000-4000-8000-0000000000f3";
    const targetCubeId = "00000000-0000-4000-8000-0000000000f4";
    const targetRoleId = "00000000-0000-4000-8000-0000000000f5";
    const targetDroneId = "00000000-0000-4000-8000-0000000000f6";
    const targetSessionId = "00000000-0000-4000-8000-0000000000f7";
    runtime.maintenance.createClient({ id: managerClientId, name: "External manager" });
    runtime.maintenance.createClient({ id: targetClientId, name: "Target client" });
    runtime.maintenance.createCube({ id: managerCubeId, name: "Manager cube", directive: "" });
    runtime.maintenance.createCube({ id: targetCubeId, name: "Target cube", directive: "" });
    runtime.maintenance.createRole({ id: targetRoleId, cubeId: targetCubeId, name: "Worker" });
    runtime.maintenance.grantClientCube({
      clientId: managerClientId,
      cubeId: managerCubeId,
      access: "manage",
    });
    runtime.maintenance.grantClientCube({
      clientId: managerClientId,
      cubeId: targetCubeId,
      access: "manage",
    });
    runtime.maintenance.grantClientCube({
      clientId: targetClientId,
      cubeId: targetCubeId,
      access: "write",
    });
    runtime.maintenance.createDrone({
      id: targetDroneId,
      cubeId: targetCubeId,
      roleId: targetRoleId,
      clientId: targetClientId,
      label: "target-worker",
    });
    runtime.maintenance.createDroneSession({
      id: targetSessionId,
      clientId: targetClientId,
      cubeId: targetCubeId,
      droneId: targetDroneId,
    });
    const api = new CoordinationApi(runtime, authority);

    expect(runtime.forPrincipal(clientPrincipal(managerClientId)).listDrones(targetCubeId))
      .toEqual([expect.objectContaining({ id: targetDroneId })]);
    const response = await api.handle({
      method: "DELETE",
      path: `/api/cubes/${targetCubeId}/drones/${targetDroneId}`,
      principal: clientPrincipal(managerClientId),
      body: {
        protocol_version: "12",
        request_id: "cross-cube-evict",
        payload: {},
      },
      signal: new AbortController().signal,
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        request_id: "cross-cube-evict",
        payload: { drone_id: targetDroneId, evicted: true },
      },
    });
    expect(runtime.maintenance.inspectManagedDrone(targetDroneId)).toEqual({
      role_id: targetRoleId,
      evicted: true,
      session_revoked: true,
    });
  });
});

describe("drones since parameter validation", () => {
  it("returns 400 INVALID_INPUT for a malformed since value", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-since-malformed-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 20));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-0000000000a1";
    const clientId = "00000000-0000-4000-8000-0000000000a2";
    runtime.maintenance.createClient({ id: clientId, name: "Since client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Since cube", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const principal = clientPrincipal(clientId);
    const api = new CoordinationApi(runtime, authority);
    const response = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal,
      since: "not-a-uuid-or-timestamp",
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });

  it("returns 400 INVALID_INPUT for a partial UUID-like value", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-since-partial-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 21));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-0000000000b1";
    const clientId = "00000000-0000-4000-8000-0000000000b2";
    runtime.maintenance.createClient({ id: clientId, name: "Partial client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Partial cube", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const principal = clientPrincipal(clientId);
    const api = new CoordinationApi(runtime, authority);
    const response = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal,
      since: "deadbeef-dead-beef-dead-beefdeadbeef",
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });

  it("returns 400 INVALID_INPUT for a malformed timestamp", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-since-timestamp-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 22));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-0000000000c1";
    const clientId = "00000000-0000-4000-8000-0000000000c2";
    runtime.maintenance.createClient({ id: clientId, name: "Timestamp client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Timestamp cube", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const principal = clientPrincipal(clientId);
    const api = new CoordinationApi(runtime, authority);
    const response = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal,
      since: "2026-01-01T00:00:00.000Z-extra-garbage",
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });

  it("accepts a valid canonical timestamp as since", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-since-valid-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 23));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-0000000000d1";
    const clientId = "00000000-0000-4000-8000-0000000000d2";
    const roleId = "00000000-0000-4000-8000-0000000000d3";
    const droneId = "00000000-0000-4000-8000-0000000000d4";
    runtime.maintenance.createClient({ id: clientId, name: "Valid client" });
    runtime.maintenance.createCube({ id: cubeId, name: "Valid cube", directive: "" });
    runtime.maintenance.createRole({ id: roleId, cubeId, name: "Worker" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    runtime.maintenance.createDrone({ id: droneId, cubeId, roleId, clientId, label: "worker-one" });
    const principal = clientPrincipal(clientId);
    const api = new CoordinationApi(runtime, authority);
    const response = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal,
      since: "2026-07-19T10:00:00.000Z",
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(200);
    const payload = (response.body as { payload: { drones: Array<{ id: string; seen_since: boolean; wake_state: string }> } }).payload;
    expect(payload.drones).toEqual([expect.objectContaining({ id: droneId, seen_since: false, wake_state: "idle" })]);
    expect(Object.keys(payload.drones[0]!).sort()).toEqual([
      "agent_kind", "created_at", "cube_id", "hostname", "id", "label", "last_log_post_at",
      "last_seen", "posture", "reported_model", "role_id", "runtime_metadata_reported",
      "seen_since", "wake_state", "working_repo_name", "working_repo_origin",
    ]);
  });

  it("accepts a valid UUID as since and returns 404 when not found", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-api-since-uuid-")));
    directories.push(directory);
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(Buffer.alloc(32, 24));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const cubeId = "00000000-0000-4000-8000-0000000000e1";
    const clientId = "00000000-0000-4000-8000-0000000000e2";
    runtime.maintenance.createClient({ id: clientId, name: "UUID client" });
    runtime.maintenance.createCube({ id: cubeId, name: "UUID cube", directive: "" });
    runtime.maintenance.grantClientCube({ clientId, cubeId, access: "manage" });
    const principal = clientPrincipal(clientId);
    const api = new CoordinationApi(runtime, authority);
    const nonexistent = "00000000-0000-4000-8000-0000000000ff";
    const response = await api.handle({
      method: "GET",
      path: `/api/cubes/${cubeId}/drones`,
      principal,
      since: nonexistent,
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});
