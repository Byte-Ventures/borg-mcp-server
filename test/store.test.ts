import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clientPrincipal,
  droneSessionPrincipal,
  operatorPrincipal,
} from "../src/principal.js";
import { CredentialAuthority, CredentialDigester } from "../src/credentials.js";
import {
  CursorExpiredError,
  ScopedStoreError,
  StorageCapacityError,
  type StoreRuntime,
  openStore,
} from "../src/store.js";

const ids = {
  clientA: "00000000-0000-4000-8000-000000000001",
  clientB: "00000000-0000-4000-8000-000000000002",
  cubeA: "00000000-0000-4000-8000-000000000003",
  cubeB: "00000000-0000-4000-8000-000000000004",
  roleA: "00000000-0000-4000-8000-000000000005",
  droneA: "00000000-0000-4000-8000-000000000006",
  sessionA: "00000000-0000-4000-8000-000000000007",
  expiredSession: "00000000-0000-4000-8000-000000000008",
} as const;

let directory: string;
let runtime: StoreRuntime;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "borg-server-scope-")));
  runtime = await openStore({
    path: join(directory, "borg.db"),
    clock: () => new Date("2026-07-14T12:00:00.000Z"),
  });
  runtime.maintenance.createClient({ id: ids.clientA, name: "Client A" });
  runtime.maintenance.createClient({ id: ids.clientB, name: "Client B" });
  runtime.maintenance.createCube({ id: ids.cubeA, name: "Cube A", directive: "A" });
  runtime.maintenance.createCube({ id: ids.cubeB, name: "Cube B", directive: "B" });
  runtime.maintenance.grantClientCube({
    clientId: ids.clientA,
    cubeId: ids.cubeA,
    access: "manage",
  });
  runtime.maintenance.grantClientCube({
    clientId: ids.clientA,
    cubeId: ids.cubeB,
    access: "read",
  });
  runtime.maintenance.grantClientCube({
    clientId: ids.clientB,
    cubeId: ids.cubeB,
    access: "manage",
  });
  runtime.maintenance.createRole({
    id: ids.roleA,
    cubeId: ids.cubeA,
    name: "Queen",
  });
  runtime.maintenance.createDrone({
    id: ids.droneA,
    cubeId: ids.cubeA,
    roleId: ids.roleA,
    clientId: ids.clientA,
    label: "one-of-one-queen",
  });
  runtime.maintenance.createDroneSession({
    id: ids.sessionA,
    clientId: ids.clientA,
    cubeId: ids.cubeA,
    droneId: ids.droneA,
    expiresAt: "2026-07-14T13:00:00.000Z",
  });
  runtime.maintenance.createDroneSession({
    id: ids.expiredSession,
    clientId: ids.clientA,
    cubeId: ids.cubeA,
    droneId: ids.droneA,
    expiresAt: "2026-07-14T11:00:00.000Z",
  });
});

afterEach(async () => {
  runtime.close();
  await rm(directory, { recursive: true, force: true });
});

describe("Principal to ScopedStore isolation", () => {
  it("gives the offline operator authority independently of product role labels", () => {
    const operator = runtime.forPrincipal(operatorPrincipal(
      "00000000-0000-4000-8000-000000000009",
    ));

    expect(operator.listCubes().map((cube) => cube.id)).toEqual([ids.cubeA, ids.cubeB]);
    operator.updateDirective(ids.cubeB, "operator maintenance");
    expect(operator.getCube(ids.cubeB)?.directive).toBe("operator maintenance");
  });

  it("limits clients to database grants and returns no unauthorized cube oracle", () => {
    const clientA = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const clientB = runtime.forPrincipal(clientPrincipal(ids.clientB));

    expect(clientA.listCubes().map((cube) => cube.id)).toEqual([ids.cubeA, ids.cubeB]);
    expect(clientB.listCubes().map((cube) => cube.id)).toEqual([ids.cubeB]);
    expect(clientB.getCube(ids.cubeA)).toBeNull();
    expect(() => clientB.appendActivity(ids.cubeA, "cross-cube write")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("keeps a drone session narrower than its client and ignores its Queen role label", () => {
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));

    expect(drone.listCubes().map((cube) => cube.id)).toEqual([ids.cubeA]);
    expect(drone.getCube(ids.cubeB)).toBeNull();
    expect(() => drone.updateDirective(ids.cubeA, "role escalation")).toThrow(ScopedStoreError);

    const entry = drone.appendActivity(ids.cubeA, "session-scoped append");
    expect(entry.droneId).toBe(ids.droneA);
    expect(drone.readActivity(ids.cubeA, 10)).toEqual([entry]);
  });

  it("immediately constrains a live session when its parent grant is downgraded or removed", () => {
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));

    runtime.maintenance.grantClientCube({
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      access: "read",
    });
    expect(drone.listCubes().map((cube) => cube.id)).toEqual([ids.cubeA]);
    expect(() => drone.appendActivity(ids.cubeA, "must inherit read-only")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );

    runtime.maintenance.removeClientCubeGrant(ids.clientA, ids.cubeA);
    expect(drone.listCubes()).toEqual([]);
    expect(drone.getCube(ids.cubeA)).toBeNull();
  });

  it("rejects read-only writes and expired drone sessions", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    expect(() => client.appendActivity(ids.cubeB, "read grant is not write")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );

    const expired = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.expiredSession,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    expect(expired.listCubes()).toEqual([]);
    expect(() => expired.appendActivity(ids.cubeA, "expired")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("applies client and session revocation to already-created scoped stores", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));

    runtime.maintenance.revokeDroneSession(ids.sessionA);
    expect(drone.listCubes()).toEqual([]);

    runtime.maintenance.revokeClient(ids.clientA);
    expect(client.listCubes()).toEqual([]);
  });

  it("executes authorized writes and their scope predicate atomically", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));

    client.updateDirective(ids.cubeA, "updated by manager");
    expect(client.getCube(ids.cubeA)?.directive).toBe("updated by manager");

    const entry = client.appendActivity(ids.cubeA, "client append");
    expect(entry.actorKind).toBe("client");
    expect(entry.droneId).toBeNull();
  });

  it("exposes named stores without a raw database or generic admin escape hatch", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "close",
      "credentials",
      "diagnostics",
      "forPrincipal",
      "maintenance",
    ]);
    expect("database" in runtime).toBe(false);
    expect("admin" in runtime).toBe(false);
    expect("execute" in runtime).toBe(false);
    expect("query" in runtime).toBe(false);
  });

  it("persists scoped data across a server restart", async () => {
    const path = join(directory, "borg.db");
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const entry = client.appendActivity(ids.cubeA, "durable entry");
    runtime.close();

    runtime = await openStore({
      path,
      clock: () => new Date("2026-07-14T12:30:00.000Z"),
    });
    const reopened = runtime.forPrincipal(clientPrincipal(ids.clientA));

    expect(reopened.readActivity(ids.cubeA, 10)).toContainEqual(entry);
  });

  it("paginates monotonic tuple cursors and keeps claims outside the log cursor", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const alpha = client.appendLog(ids.cubeA, { message: "alpha" });
    const beta = client.appendLog(ids.cubeA, { message: "beta" });
    const gamma = client.appendLog(ids.cubeA, { message: "gamma" });

    expect([alpha.created_at, beta.created_at, gamma.created_at]).toEqual([
      "2026-07-14T12:00:00.000Z",
      "2026-07-14T12:00:00.001Z",
      "2026-07-14T12:00:00.002Z",
    ]);
    const first = client.readLog(ids.cubeA, null, 2);
    expect(first.entries.map((entry) => entry.message)).toEqual(["alpha", "beta"]);
    expect(first.cursor).toEqual({ id: beta.id, created_at: beta.created_at });
    expect(first).toMatchObject({ behind_by: 1, has_more: true });

    client.acknowledge(ids.cubeA, beta.id, "claim");
    client.acknowledge(ids.cubeA, beta.id, "claim");
    const after = client.readLog(ids.cubeA, { id: gamma.id, created_at: gamma.created_at }, 10);
    expect(after.entries).toEqual([]);
    expect(after.cursor).toEqual({ id: gamma.id, created_at: gamma.created_at });
    expect(after.claims).toEqual([expect.objectContaining({
      log_entry_id: beta.id,
      claimant_drone_id: ids.clientA,
    })]);
  });

  it("transactionally prunes old log rows, cursors, recipients, and acknowledgements", async () => {
    const path = join(directory, "borg.db");
    runtime.close();
    runtime = await openStore({
      path,
      clock: () => new Date("2026-07-14T12:00:00.000Z"),
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 1,
      },
      capacityProbe: () => ({ databaseBytes: 0, freeDiskBytes: 1_000_000 }),
    });
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const first = client.appendLog(ids.cubeA, {
      message: "entry-00",
      visibility: "direct",
      recipientDroneIds: [ids.droneA],
    });
    client.acknowledge(ids.cubeA, first.id, "claim");
    const appended = [first];
    for (let index = 1; index < 50; index += 1) {
      appended.push(client.appendLog(ids.cubeA, { message: `entry-${index.toString().padStart(2, "0")}` }));
    }

    const retained = client.readLog(ids.cubeA, null, 50);
    expect(retained.entries.map((entry) => entry.message)).toEqual(
      Array.from({ length: 10 }, (_, index) => `entry-${index + 40}`),
    );
    expect(retained.entries.map((entry) => entry.created_at)).toEqual(
      [...retained.entries.map((entry) => entry.created_at)].sort(),
    );
    expect(retained.claims).toEqual([]);
    const recentlyPruned = appended[39]!;
    expect(() => client.readLog(
      ids.cubeA,
      { id: recentlyPruned.id, created_at: recentlyPruned.created_at },
      10,
    )).toThrow(CursorExpiredError);
    expect(() => client.acknowledge(ids.cubeA, first.id, "ack")).toThrow(ScopedStoreError);
    expect(retained.entries.at(-1)?.id).toBe(appended.at(-1)?.id);
  });

  it("fails closed before log mutation when disk or database capacity is exhausted", async () => {
    const path = join(directory, "borg.db");
    runtime.close();
    let capacity = { databaseBytes: 0, freeDiskBytes: 1_000_000 };
    runtime = await openStore({
      path,
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 10_000,
      },
      capacityProbe: () => capacity,
    });
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const retained = client.appendLog(ids.cubeA, { message: "retained" });

    capacity = { databaseBytes: 0, freeDiskBytes: 0 };
    expect(() => client.appendLog(ids.cubeA, { message: "disk-pressure-secret" })).toThrowError(
      expect.objectContaining({
        name: "StorageCapacityError",
        code: "CAPACITY_EXCEEDED",
        message: "Storage capacity is unavailable.",
      }),
    );
    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };
    expect(() => client.appendLog(ids.cubeA, { message: "database-pressure-secret" }))
      .toThrow(StorageCapacityError);
    expect(client.readLog(ids.cubeA, null, 10).entries).toEqual([retained]);
  });

  it("guards every remotely reachable database-growth mutation before state change", async () => {
    const path = join(directory, "borg.db");
    runtime.close();
    let capacity = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    runtime = await openStore({
      path,
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 10_000,
      },
      capacityProbe: () => capacity,
    });
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const baseline = client.appendLog(ids.cubeA, { message: "baseline" });
    const beforeDrones = client.listDrones(ids.cubeA);
    const digester = new CredentialDigester(Buffer.alloc(32, 9));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const invitation = authority.createBootstrapInvitation(60_000);
    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };

    const denied: Array<() => unknown> = [
      () => client.updateDirective(ids.cubeA, "blocked directive"),
      () => client.appendLog(ids.cubeA, { message: "blocked log" }),
      () => client.acknowledge(ids.cubeA, baseline.id, "claim"),
      () => client.recordDecision(ids.cubeA, { topic: "blocked", decision: "blocked" }),
      () => client.attachSeat({
        cubeId: ids.cubeA,
        roleId: ids.roleA,
        retryKey: "00000000-0000-4000-8000-000000000031",
        droneId: "00000000-0000-4000-8000-000000000032",
        sessionId: "00000000-0000-4000-8000-000000000033",
        credentialId: "00000000-0000-4000-8000-000000000034",
        credentialDigest: { lookup: Buffer.alloc(16), verifier: Buffer.alloc(32) },
        expiresAt: "2026-07-15T12:00:00.000Z",
      }),
      () => authority.exchangeInvitation({ invitation, clientName: "blocked enrollment" }),
    ];
    for (const mutation of denied) expect(mutation).toThrow(StorageCapacityError);

    expect(client.getCube(ids.cubeA)?.directive).toBe("A");
    expect(client.readLog(ids.cubeA, null, 10)).toMatchObject({ entries: [baseline], claims: [] });
    expect(client.listDecisions(ids.cubeA)).toEqual([]);
    expect(client.listDrones(ids.cubeA)).toEqual(beforeDrones);
    capacity = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    expect(authority.exchangeInvitation({ invitation, clientName: "allowed enrollment" })).not.toBeNull();
    digester.destroy();
  });

  it("normalizes invalid and throwing capacity probes without mutation", async () => {
    const path = join(directory, "borg.db");
    runtime.close();
    let result: unknown = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    let shouldThrow = false;
    runtime = await openStore({
      path,
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 10_000,
      },
      capacityProbe: () => {
        if (shouldThrow) throw new Error("secret probe detail");
        return result as never;
      },
    });
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    for (result of [null, {}, { databaseBytes: Number.NaN, freeDiskBytes: 2_000_000 }]) {
      expect(() => client.appendLog(ids.cubeA, { message: "blocked" })).toThrowError(
        expect.objectContaining({ code: "CAPACITY_EXCEEDED", message: "Storage capacity is unavailable." }),
      );
    }
    shouldThrow = true;
    expect(() => client.appendLog(ids.cubeA, { message: "blocked" })).toThrowError(
      expect.objectContaining({ code: "CAPACITY_EXCEEDED", message: "Storage capacity is unavailable." }),
    );
    expect(client.readLog(ids.cubeA, null, 10).entries).toEqual([]);
  });

  it("rejects a one-byte write when only the measured 12360-byte SQLite growth remains", async () => {
    const path = join(directory, "borg.db");
    runtime.close();
    runtime = await openStore({
      path,
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 10_000,
      },
      capacityProbe: () => ({ databaseBytes: 0, freeDiskBytes: 22_359 }),
    });
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    expect(() => client.appendLog(ids.cubeA, { message: "x" })).toThrow(StorageCapacityError);
    expect(client.readLog(ids.cubeA, null, 10).entries).toEqual([]);
  });

  it("returns indistinguishable not-found errors for cross-cube log access", () => {
    const clientB = runtime.forPrincipal(clientPrincipal(ids.clientB));

    expect(() => clientB.readLog(ids.cubeA, null, 10)).toThrow(ScopedStoreError);
    expect(() => clientB.acknowledge(
      ids.cubeA,
      "00000000-0000-4000-8000-000000000099",
      "ack",
    )).toThrow(ScopedStoreError);
  });

  it("classifies explicitly expired cursors without weakening cube scope", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const entry = client.appendLog(ids.cubeA, { message: "retained" });
    const cursor = { id: entry.id, created_at: entry.created_at };
    runtime.maintenance.expireActivityCursor(ids.cubeA, cursor);

    expect(() => client.readLog(ids.cubeA, cursor, 10)).toThrow(CursorExpiredError);
    expect(() => runtime.forPrincipal(clientPrincipal(ids.clientB)).readLog(
      ids.cubeA,
      cursor,
      10,
    )).toThrow(ScopedStoreError);
  });

  it("atomically supersedes decisions while drone sessions remain non-managing", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const first = client.recordDecision(ids.cubeA, { topic: "runtime", decision: "first" });
    const second = client.recordDecision(ids.cubeA, {
      topic: "runtime",
      decision: "second",
      rationale: "new evidence",
    });

    expect(second.supersedes).toBe(first.id);
    expect(client.listDecisions(ids.cubeA)).toEqual([second]);
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    expect(() => drone.recordDecision(ids.cubeA, {
      topic: "runtime",
      decision: "role label cannot escalate",
    })).toThrow(ScopedStoreError);
  });
});
