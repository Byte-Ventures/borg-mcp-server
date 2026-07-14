import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clientPrincipal,
  droneSessionPrincipal,
  operatorPrincipal,
} from "../src/principal.js";
import { ScopedStoreError, type StoreRuntime, openStore } from "../src/store.js";

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
});
