import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clientPrincipal,
  droneSessionPrincipal,
  operatorPrincipal,
} from "../src/principal.js";
import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import {
  AccessDeniedError,
  CubeDeletedError,
  CursorExpiredError,
  DefaultRoleRequiredError,
  RoleConflictError,
  RoleSectionConflictError,
  PostIdConflictError,
  ScopedStoreError,
  StorageCapacityError,
  type ActivityStreamRecord,
  type StoreRuntime,
  openStore,
} from "../src/store.js";
import { PLATFORM_QUEEN_DETAILED_DESCRIPTION } from "../src/platform-queen.js";
import { operatorErrors } from "../src/operator-error.js";

const ids = {
  clientA: "00000000-0000-4000-8000-000000000001",
  clientB: "00000000-0000-4000-8000-000000000002",
  cubeA: "00000000-0000-4000-8000-000000000003",
  cubeB: "00000000-0000-4000-8000-000000000004",
  roleA: "00000000-0000-4000-8000-000000000005",
  droneA: "00000000-0000-4000-8000-000000000006",
  sessionA: "00000000-0000-4000-8000-000000000007",
  longLivedSession: "00000000-0000-4000-8000-000000000008",
} as const;

let directory: string;
let runtime: StoreRuntime;
let storeNow: Date;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "borg-server-scope-")));
  storeNow = new Date("2026-07-14T12:00:00.000Z");
  runtime = await openStore({
    path: join(directory, "borg.db"),
    clock: () => storeNow,
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
  });
  runtime.maintenance.createDroneSession({
    id: ids.longLivedSession,
    clientId: ids.clientA,
    cubeId: ids.cubeA,
    droneId: ids.droneA,
  });
});

afterEach(async () => {
  runtime.close();
  await rm(directory, { recursive: true, force: true });
});

describe("reliable log append", () => {
  it("deduplicates exact author-scoped retries and rejects tuple conflicts", () => {
    const author = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const postId = "00000000-0000-4000-8000-000000000099";
    const events: ActivityStreamRecord[] = [];
    const unsubscribe = author.subscribeActivity(ids.cubeA, (entry) => events.push(entry));

    const created = author.appendLog(ids.cubeA, { visibility: "broadcast", postId, message: "stable", routingKey: "work" });
    const retried = author.appendLog(ids.cubeA, { visibility: "broadcast", postId, message: "stable", routingKey: "work" });
    expect(retried).toMatchObject({ id: created.id, deduplicated: true });
    expect(events).toHaveLength(1);
    expect(() => author.appendLog(ids.cubeA, { visibility: "broadcast", postId, message: "changed", routingKey: "work" }))
      .toThrow(PostIdConflictError);
    expect(events).toHaveLength(1);

    runtime.maintenance.grantClientCube({ clientId: ids.clientB, cubeId: ids.cubeA, access: "write" });
    const independent = runtime.forPrincipal(clientPrincipal(ids.clientB)).appendLog(ids.cubeA, { visibility: "broadcast",
      postId,
      message: "stable",
      routingKey: "work",
    });
    expect(independent).toMatchObject({ deduplicated: false });
    expect(independent.id).not.toBe(created.id);
    unsubscribe();
  });

  it("keeps replay and conflict authority after retention pruning and at capacity", async () => {
    runtime.close();
    let capacity = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    runtime = await openStore({
      path: join(directory, "reliable.db"),
      storageLimits: {
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 1,
        maxActivityEntriesPerCube: 10,
      },
      capacityProbe: () => capacity,
    });
    runtime.maintenance.createClient({ id: ids.clientA, name: "Client A" });
    runtime.maintenance.createCube({ id: ids.cubeA, name: "Cube A", directive: "" });
    runtime.maintenance.grantClientCube({ clientId: ids.clientA, cubeId: ids.cubeA, access: "manage" });
    const author = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const postId = "00000000-0000-4000-8000-000000000099";
    const created = author.appendLog(ids.cubeA, { visibility: "broadcast", postId, message: "stable" });
    for (let index = 0; index < 10; index += 1) {
      author.appendLog(ids.cubeA, { visibility: "broadcast", message: `filler-${index}` });
    }
    expect(author.readLog(ids.cubeA, null, 20).entries.some((entry) => entry.id === created.id)).toBe(false);

    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };
    expect(author.appendLog(ids.cubeA, { visibility: "broadcast", postId, message: "stable" }))
      .toMatchObject({ id: created.id, deduplicated: true });
    expect(() => author.appendLog(ids.cubeA, { visibility: "broadcast", postId, message: "changed" }))
      .toThrow(PostIdConflictError);
  });
});

describe("Principal to ScopedStore isolation", () => {
  it("reports the UUID requirement for selector-based cube grants", () => {
    expect(() => runtime.maintenance.grantClientCubeBySelector({
      selector: ids.clientA,
      cubeId: "Cube A",
      access: "manage",
    })).toThrow(operatorErrors.CUBE_ID_INVALID);
  });
  it("keeps delegated Queen follow-up milestone-based and operator-controlled", () => {
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "Use START NOW, RESUME NOW, REVIEW NOW, or HOLD",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "ACK and claim are receipt only",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "Follow work through substantive milestones, not elapsed-time deadlines",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "send at most one direct status request",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "report silence or liveness evidence to the human",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "never authorizes an ownership change",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "explicit human operator approval for the exact work item and recipient",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "Do not interrupt slow local work merely to satisfy a cadence",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).toContain(
      "BLOCKED immediately",
    );
    expect(PLATFORM_QUEEN_DETAILED_DESCRIPTION).not.toMatch(
      /(?:within|further|every) (?:2|5|10) minutes|activation reminder|probe liveness|eligible and authorized reassignment/i,
    );
  });

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
    expect(() => drone.updateDirective(ids.cubeA, "role escalation")).toThrow(AccessDeniedError);

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

  it("rejects read-only writes while old session timestamps no longer affect authorization", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    expect(() => client.appendActivity(ids.cubeB, "read grant is not write")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );

    const longLived = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.longLivedSession,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    expect(longLived.listCubes()).toEqual([expect.objectContaining({ id: ids.cubeA })]);
    expect(longLived.appendActivity(ids.cubeA, "still authorized")).toMatchObject({
      cubeId: ids.cubeA,
    });
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

  it("hard-deletes a managed cube while retaining only access-scoped deletion tombstones", () => {
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const outsiderId = "00000000-0000-4000-8000-000000000009";
    runtime.maintenance.createClient({ id: outsiderId, name: "Outsider" });
    expect(() => manager.deleteCube(ids.cubeB)).toThrow(AccessDeniedError);
    expect(() => runtime.forPrincipal(clientPrincipal(ids.clientB)).deleteCube(ids.cubeA))
      .toThrow(ScopedStoreError);
    expect(() => runtime.forPrincipal(clientPrincipal(outsiderId)).deleteCube(ids.cubeA))
      .toThrow(ScopedStoreError);
    const document = manager.putDocument(ids.cubeA, {
      title: "Deleted evidence",
      contentType: "text/plain",
      content: "retained only while the cube exists",
    });
    const entry = manager.appendLog(ids.cubeA, { visibility: "broadcast",
      message: "deleted activity",
      documents: [document.id],
    });
    manager.acknowledge(ids.cubeA, entry.id, "ack");
    manager.recordDecision(ids.cubeA, { topic: "deleted-topic", decision: "deleted decision" });
    let deletionSignals = 0;
    const unsubscribe = manager.subscribeActivity(
      ids.cubeA,
      () => undefined,
      () => { deletionSignals += 1; },
    );

    manager.deleteCube(ids.cubeA);

    expect(deletionSignals).toBe(1);
    expect(manager.listCubes().map((cube) => cube.id)).toEqual([ids.cubeB]);
    expect(() => manager.getCube(ids.cubeA)).toThrow(CubeDeletedError);
    expect(() => runtime.forPrincipal(operatorPrincipal(outsiderId)).getCube(ids.cubeA))
      .toThrow(CubeDeletedError);
    expect(runtime.forPrincipal(clientPrincipal(outsiderId)).getCube(ids.cubeA)).toBeNull();
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 1,
      roles: 0,
      grants: 2,
      drones: 0,
      drone_sessions: 0,
      drone_session_credentials: 0,
    });
    const database = new DatabaseSync(join(directory, "borg.db"), { readOnly: true });
    for (const table of [
      "client_cube_grants", "roles", "drones", "drone_sessions",
      "activity_log", "activity_acks", "activity_log_documents", "documents", "decisions", "expired_activity_cursors",
      "cube_create_bindings", "repository_associations",
    ]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
        .toEqual({ count: table === "client_cube_grants" ? 2 : 0 });
    }
    expect(database.prepare("SELECT id FROM deleted_cubes").all()).toEqual([{ id: ids.cubeA }]);
    expect(database.prepare(
      "SELECT cube_id, client_id FROM deleted_cube_client_grants",
    ).all()).toEqual([{ cube_id: ids.cubeA, client_id: ids.clientA }]);
    expect(database.prepare(
      "SELECT name FROM pragma_table_info('deleted_cube_session_credentials') ORDER BY cid",
    ).all()).toEqual([
      { name: "cube_id" },
      { name: "client_id" },
      { name: "lookup_digest" },
      { name: "verifier_digest" },
      { name: "terminal_cause" },
    ]);
    database.close();
    unsubscribe();
  });

  it("promotes active and revoked sessions to CUBE_DELETED after the database reopens", async () => {
    const roleB = "00000000-0000-4000-8000-000000000009";
    const outsiderId = "00000000-0000-4000-8000-00000000000a";
    runtime.maintenance.createClient({ id: outsiderId, name: "Never authorized" });
    runtime.maintenance.createRole({ id: roleB, cubeId: ids.cubeB, name: "Worker" });
    const key = Buffer.alloc(32, 19);
    let digester = new CredentialDigester(key);
    let authority = new CredentialAuthority(runtime.credentials, digester);
    const revokedCredential = generateSecret();
    const revoked = authority.attachSeat(runtime.forPrincipal(clientPrincipal(ids.clientB)), {
      cubeId: ids.cubeB,
      roleId: roleB,
      sessionCredential: revokedCredential,
    });
    runtime.maintenance.revokeDroneSession(revoked.sessionId);
    expect(authority.authenticateStatus(`Bearer ${revokedCredential}`)).toBe("revoked");
    const sessionCredential = generateSecret();
    authority.attachSeat(runtime.forPrincipal(clientPrincipal(ids.clientB)), {
      cubeId: ids.cubeB,
      roleId: roleB,
      sessionCredential,
    });
    runtime.maintenance.grantClientCube({
      clientId: ids.clientA,
      cubeId: ids.cubeB,
      access: "manage",
    });
    runtime.maintenance.removeClientCubeGrant(ids.clientB, ids.cubeB);
    expect(runtime.forPrincipal(clientPrincipal(ids.clientB)).getCube(ids.cubeB)).toBeNull();
    expect(runtime.forPrincipal(clientPrincipal(outsiderId)).getCube(ids.cubeB)).toBeNull();

    runtime.forPrincipal(clientPrincipal(ids.clientA)).deleteCube(ids.cubeB);
    expect(authority.authenticateStatus(`Bearer ${sessionCredential}`)).toBe("cube-deleted");
    expect(authority.authenticateStatus(`Bearer ${revokedCredential}`)).toBe("cube-deleted");
    expect(() => runtime.forPrincipal(clientPrincipal(ids.clientB)).getCube(ids.cubeB))
      .toThrow(CubeDeletedError);
    expect(runtime.forPrincipal(clientPrincipal(outsiderId)).getCube(ids.cubeB)).toBeNull();

    runtime.close();
    digester.destroy();
    runtime = await openStore({ path: join(directory, "borg.db") });
    digester = new CredentialDigester(key);
    authority = new CredentialAuthority(runtime.credentials, digester);
    expect(authority.authenticateStatus(`Bearer ${sessionCredential}`)).toBe("cube-deleted");
    expect(authority.authenticateStatus(`Bearer ${revokedCredential}`)).toBe("cube-deleted");
    expect(() => runtime.forPrincipal(clientPrincipal(ids.clientB)).getCube(ids.cubeB))
      .toThrow(CubeDeletedError);
    expect(runtime.forPrincipal(clientPrincipal(outsiderId)).getCube(ids.cubeB)).toBeNull();
    digester.destroy();
  });

  it("does not expose a parent client's sibling cube tombstone to its drone", async () => {
    const parent = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    runtime.maintenance.grantClientCube({
      clientId: ids.clientA,
      cubeId: ids.cubeB,
      access: "manage",
    });
    expect(drone.getCube(ids.cubeB)).toBeNull();
    expect(() => drone.deleteCube(ids.cubeB)).toThrow(ScopedStoreError);

    parent.deleteCube(ids.cubeB);
    expect(() => parent.getCube(ids.cubeB)).toThrow(CubeDeletedError);
    expect(drone.getCube(ids.cubeB)).toBeNull();
    expect(() => drone.deleteCube(ids.cubeB)).toThrow(ScopedStoreError);

    runtime.close();
    runtime = await openStore({ path: join(directory, "borg.db") });
    const reopenedParent = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const reopenedDrone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    expect(() => reopenedParent.getCube(ids.cubeB)).toThrow(CubeDeletedError);
    expect(reopenedDrone.getCube(ids.cubeB)).toBeNull();
    expect(() => reopenedDrone.deleteCube(ids.cubeB)).toThrow(ScopedStoreError);
  });

  it("executes authorized writes atomically and persists migrated cube context", async () => {
    const path = join(directory, "borg.db");
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));

    client.updateDirective(ids.cubeA, "updated by manager");
    expect(client.getCube(ids.cubeA)?.directive).toBe("updated by manager");
    expect(client.updateCube(ids.cubeA, {
      directive: "migrated directive",
      messageTaxonomy: [{
        class: "status",
        prefixes: ["DONE"],
        lifecycle: "completion",
      }],
    })).toMatchObject({
      directive: "migrated directive",
      messageTaxonomy: [{ class: "status", prefixes: ["DONE"], lifecycle: "completion" }],
    });

    const entry = client.appendActivity(ids.cubeA, "client append");
    expect(entry.actorKind).toBe("client");
    expect(entry.droneId).toBeNull();
    runtime.close();
    runtime = await openStore({ path, clock: () => new Date("2026-07-14T12:30:00.000Z") });
    expect(runtime.forPrincipal(clientPrincipal(ids.clientA)).getCube(ids.cubeA)).toMatchObject({
      directive: "migrated directive",
      messageTaxonomy: [{ class: "status", prefixes: ["DONE"], lifecycle: "completion" }],
    });
  });

  it("creates complete worker roles and promotes one default atomically", async () => {
    const path = join(directory, "borg.db");
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const reviewer = client.createRole(ids.cubeA, {
      name: "Code Reviewer",
      shortDescription: "Reviews completed branches",
      detailedDescription: "Review findings:\nBlock regressions.",
      isDefault: true,
      isMandatory: true,
      isHumanSeat: true,
      canBroadcast: true,
      receivesAllDirect: true,
      roleClass: "queen",
    });
    expect(reviewer).toMatchObject({
      cube_id: ids.cubeA,
      name: "Code Reviewer",
      short_description: "Reviews completed branches",
      detailed_description: "Review findings:\nBlock regressions.",
      is_default: true,
      is_mandatory: true,
      is_human_seat: true,
      can_broadcast: true,
      receives_all_direct: true,
      role_class: "queen",
    });

    const builder = client.createRole(ids.cubeA, { name: "Builder", isDefault: true });
    const roles = client.listRoles(ids.cubeA);
    expect(roles.find((role) => role.id === reviewer.id)?.is_default).toBe(false);
    expect(roles.find((role) => role.id === builder.id)?.is_default).toBe(true);
    expect(roles.filter((role) => role.is_default)).toHaveLength(1);

    runtime.close();
    runtime = await openStore({ path, clock: () => new Date("2026-07-14T12:30:00.000Z") });
    expect(runtime.forPrincipal(clientPrincipal(ids.clientA)).listRoles(ids.cubeA))
      .toContainEqual(expect.objectContaining({ id: reviewer.id, detailed_description: reviewer.detailed_description }));
  });

  it("requires manage authority for role creation without a cube oracle", () => {
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const foreignManager = runtime.forPrincipal(clientPrincipal(ids.clientB));
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const before = manager.listRoles(ids.cubeA);

    expect(() => manager.createRole(ids.cubeB, { name: "Read only" })).toThrow(AccessDeniedError);
    expect(() => foreignManager.createRole(ids.cubeA, { name: "Foreign" })).toThrow(ScopedStoreError);
    expect(() => drone.createRole(ids.cubeA, { name: "Queen escalation" })).toThrow(AccessDeniedError);
    expect(() => manager.createRole(randomUUID(), { name: "Missing" })).toThrow(ScopedStoreError);
    expect(manager.listRoles(ids.cubeA)).toEqual(before);
  });

  it("rejects duplicate and oversized roles without changing the current default", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const defaultRole = client.createRole(ids.cubeA, { name: "Default", isDefault: true });

    expect(() => client.createRole(ids.cubeA, { name: "Queen", isDefault: true }))
      .toThrow(RoleConflictError);
    expect(() => client.createRole(ids.cubeA, {
      name: "Oversized",
      detailedDescription: "x".repeat(51_201),
    })).toThrow(RangeError);
    expect(() => client.createRole(ids.cubeA, {
      name: "Oversized bytes",
      detailedDescription: "é".repeat(25_601),
    })).toThrow(RangeError);
    const roles = client.listRoles(ids.cubeA);
    expect(roles.find((role) => role.id === defaultRole.id)?.is_default).toBe(true);
    expect(roles.filter((role) => role.is_default)).toHaveLength(1);
    expect(roles.some((role) => role.name === "Oversized")).toBe(false);
  });

  it("updates role fields and promotes a new default atomically", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const builder = client.createRole(ids.cubeA, { name: "Builder", isDefault: true });
    const reviewer = client.createRole(ids.cubeA, {
      name: "Reviewer",
      detailedDescription: "Workflow:\n- review\n",
    });

    const updated = client.updateRole(ids.cubeA, reviewer.id, {
      name: "Code Reviewer",
      shortDescription: "Reviews completed branches",
      detailedDescription: "Workflow:\n- verify exact SHA\n",
      isDefault: true,
      isMandatory: true,
      isHumanSeat: true,
      canBroadcast: true,
      receivesAllDirect: true,
      roleClass: "queen",
    });

    expect(updated).toMatchObject({
      id: reviewer.id,
      name: "Code Reviewer",
      short_description: "Reviews completed branches",
      detailed_description: "Workflow:\n- verify exact SHA\n",
      is_default: true,
      is_mandatory: true,
      is_human_seat: true,
      can_broadcast: true,
      receives_all_direct: true,
      role_class: "queen",
      created_at: reviewer.created_at,
    });
    expect(client.listRoles(ids.cubeA).find((role) => role.id === builder.id)?.is_default).toBe(false);
  });

  it("rejects unauthorized, duplicate, empty, and oversized role updates without mutation", () => {
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const foreignManager = runtime.forPrincipal(clientPrincipal(ids.clientB));
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const first = manager.createRole(ids.cubeA, { name: "First", isDefault: true });
    const second = manager.createRole(ids.cubeA, { name: "Second" });

    expect(() => manager.updateRole(ids.cubeA, first.id, { isDefault: false }))
      .toThrow(DefaultRoleRequiredError);
    expect(() => manager.updateRole(ids.cubeA, second.id, { name: first.name, isDefault: true }))
      .toThrow(RoleConflictError);
    expect(() => manager.updateRole(ids.cubeA, second.id, {})).toThrow(TypeError);
    expect(() => manager.updateRole(ids.cubeA, second.id, {
      detailedDescription: "x".repeat(51_201),
    })).toThrow(RangeError);
    expect(() => foreignManager.updateRole(ids.cubeA, second.id, { name: "Foreign" }))
      .toThrow(ScopedStoreError);
    expect(() => drone.updateRole(ids.cubeA, second.id, { name: "Escalated" }))
      .toThrow(AccessDeniedError);
    expect(() => manager.updateRole(ids.cubeB, second.id, { name: "Wrong cube" }))
      .toThrow(AccessDeniedError);
    expect(manager.listRoles(ids.cubeA).find((role) => role.id === first.id)?.is_default).toBe(true);
    expect(manager.listRoles(ids.cubeA).find((role) => role.id === second.id)?.name).toBe("Second");
  });

  it("patches one role section transactionally and preserves all other role fields", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const role = client.createRole(ids.cubeA, {
      name: "Builder",
      shortDescription: "Builds changes",
      detailedDescription: "Preamble.\n\nWorkflow:\n- old\n\nConventions:\n- TDD.\n",
      canBroadcast: true,
    });

    const replaced = client.patchRoleSection(ids.cubeA, role.id, {
      action: "replace", heading: "Workflow", body: "- new",
    });
    expect(replaced).toMatchObject({
      short_description: role.short_description,
      detailed_description: "Preamble.\n\nWorkflow:\n- new\nConventions:\n- TDD.\n",
      can_broadcast: true,
      created_at: role.created_at,
    });
    const inserted = client.patchRoleSection(ids.cubeA, role.id, {
      action: "insert", heading: "Review", body: "- exact SHA", after: "Workflow",
    });
    expect(inserted.detailed_description).toContain("Workflow:\n- new\nReview:\n- exact SHA\nConventions:");
    expect(client.patchRoleSection(ids.cubeA, role.id, {
      action: "delete", heading: "Review",
    }).detailed_description).toBe(replaced.detailed_description);
    const afterSuccess = client.listRoles(ids.cubeA)
      .find((candidate) => candidate.id === role.id)!.detailed_description;
    for (const [operation, reason, message] of [
      [
        { action: "delete", heading: "Missing" },
        "target_missing",
        "The target role section does not exist.",
      ],
      [
        { action: "insert", heading: "Workflow", body: "duplicate" },
        "target_exists",
        "The target role section already exists.",
      ],
      [
        { action: "insert", heading: "Review", body: "new", after: "Missing" },
        "insertion_point_missing",
        "The role section insertion point does not exist.",
      ],
    ] as const) {
      expect(() => client.patchRoleSection(ids.cubeA, role.id, operation))
        .toThrowError(expect.objectContaining({
          name: "RoleSectionConflictError",
          code: "ROLE_SECTION_CONFLICT",
          reason,
          message,
        } satisfies Partial<RoleSectionConflictError>));
      expect(client.listRoles(ids.cubeA)
        .find((candidate) => candidate.id === role.id)!.detailed_description).toBe(afterSuccess);
    }
  });

  it("exposes named stores without a raw database or generic admin escape hatch", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "close",
      "credentials",
      "dashboard",
      "diagnostics",
      "forPrincipal",
      "liveness",
      "maintenance",
    ]);
    expect(Object.keys(runtime.dashboard).sort()).toEqual(["read", "subscribe"]);
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

  it("replaces one fixture log id without changing entry data or authority counts", () => {
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const entry = manager.appendLog(ids.cubeA, { visibility: "broadcast", message: "replace fixture id" });
    const collision = manager.appendLog(ids.cubeA, { visibility: "broadcast", message: "existing fixture id" });
    const replacementId = "00000000-0000-4000-8000-000000000099";
    const before = runtime.maintenance.observeAuthorityState();

    runtime.maintenance.replaceLogEntryId(ids.cubeA, entry.id, replacementId);

    expect(runtime.maintenance.observeAuthorityState()).toEqual(before);
    expect(() => manager.readLogEntry(ids.cubeA, entry.id)).toThrow(ScopedStoreError);
    expect(manager.readLogEntry(ids.cubeA, replacementId)).toMatchObject({
      id: replacementId,
      message: "replace fixture id",
      created_at: entry.created_at,
    });
    expect(() => runtime.maintenance.replaceLogEntryId(
      ids.cubeA,
      replacementId,
      collision.id,
    )).toThrow(ScopedStoreError);
    expect(() => runtime.maintenance.replaceLogEntryId(
      ids.cubeA,
      randomUUID(),
      randomUUID(),
    )).toThrow(ScopedStoreError);
  });

  it("publishes idempotent ack and claim notifications to their intended audience", () => {
    const peerDroneId = "00000000-0000-4000-8000-000000000021";
    const peerSessionId = "00000000-0000-4000-8000-000000000022";
    runtime.maintenance.createDrone({
      id: peerDroneId,
      cubeId: ids.cubeA,
      roleId: ids.roleA,
      clientId: ids.clientA,
      label: "two-of-two-queen",
    });
    runtime.maintenance.createDroneSession({
      id: peerSessionId,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: peerDroneId,
    });
    const author = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const peer = runtime.forPrincipal(droneSessionPrincipal({
      id: peerSessionId,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: peerDroneId,
    }));
    const authorEvents: ActivityStreamRecord[] = [];
    const peerEvents: ActivityStreamRecord[] = [];
    const stopAuthor = author.subscribeActivity(ids.cubeA, (entry) => authorEvents.push(entry));
    const stopPeer = peer.subscribeActivity(ids.cubeA, (entry) => peerEvents.push(entry));
    const entry = author.appendLog(ids.cubeA, { visibility: "broadcast", message: "dispatch work" });
    authorEvents.length = 0;
    peerEvents.length = 0;

    peer.acknowledge(ids.cubeA, entry.id, "ack");
    peer.acknowledge(ids.cubeA, entry.id, "ack");
    expect(authorEvents).toEqual([expect.objectContaining({
      kind: "ack",
      author_drone_id: ids.droneA,
      recipient_drone_ids: [ids.droneA],
      entry_preview: "dispatch work",
    })]);
    expect(peerEvents).toEqual([]);

    authorEvents.length = 0;
    peer.acknowledge(ids.cubeA, entry.id, "claim");
    expect(authorEvents).toEqual([expect.objectContaining({
      kind: "claim",
      claimant_drone_id: peerDroneId,
      claimant_role: "Queen",
      recipient_drone_ids: [ids.droneA],
    })]);
    expect(peerEvents).toEqual([]);
    stopAuthor();
    stopPeer();
  });

  it("reads acknowledgement status without changing acknowledgements, claims, or log cursors", () => {
    const peerDroneId = "00000000-0000-4000-8000-000000000021";
    const peerSessionId = "00000000-0000-4000-8000-000000000022";
    runtime.maintenance.createDrone({
      id: peerDroneId,
      cubeId: ids.cubeA,
      roleId: ids.roleA,
      clientId: ids.clientA,
      label: "two-of-two-queen",
    });
    runtime.maintenance.createDroneSession({
      id: peerSessionId,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: peerDroneId,
    });
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const recipient = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const claimant = runtime.forPrincipal(droneSessionPrincipal({
      id: peerSessionId,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: peerDroneId,
    }));
    const direct = manager.appendLog(ids.cubeA, {
      message: "direct status",
      visibility: "direct",
      recipientDroneIds: [ids.droneA, peerDroneId],
    });
    const beforeMissing = runtime.maintenance.observeAuthorityState();

    expect(manager.readAckStatus(ids.cubeA, direct.id)).toEqual({
      entry_id: direct.id,
      visibility: "direct",
      recipients: [
        {
          drone_id: ids.droneA,
          drone_label: "one-of-one-queen",
          drone_role: "Queen",
          acknowledged_at: null,
        },
        {
          drone_id: peerDroneId,
          drone_label: "two-of-two-queen",
          drone_role: "Queen",
          acknowledged_at: null,
        },
      ],
      claims: [],
    });
    expect(runtime.maintenance.observeAuthorityState()).toEqual(beforeMissing);

    storeNow = new Date("2026-07-14T12:00:01.000Z");
    recipient.acknowledge(ids.cubeA, direct.id, "ack");
    storeNow = new Date("2026-07-14T12:00:02.000Z");
    claimant.acknowledge(ids.cubeA, direct.id, "claim");
    const beforeDistinct = runtime.maintenance.observeAuthorityState();
    const unreadBefore = manager.readLog(ids.cubeA, null, 10);
    expect(manager.readAckStatus(ids.cubeA, direct.id)).toEqual({
      entry_id: direct.id,
      visibility: "direct",
      recipients: [
        expect.objectContaining({
          drone_id: ids.droneA,
          acknowledged_at: "2026-07-14T12:00:01.000Z",
        }),
        expect.objectContaining({ drone_id: peerDroneId, acknowledged_at: null }),
      ],
      claims: [{
        drone_id: peerDroneId,
        drone_label: "two-of-two-queen",
        drone_role: "Queen",
        claimed_at: "2026-07-14T12:00:02.000Z",
      }],
    });
    expect(runtime.maintenance.observeAuthorityState()).toEqual(beforeDistinct);
    expect(manager.readLog(ids.cubeA, null, 10)).toEqual(unreadBefore);

    const broadcast = manager.appendLog(ids.cubeA, { visibility: "broadcast", message: "broadcast status" });
    expect(manager.readAckStatus(ids.cubeA, broadcast.id)).toEqual({
      entry_id: broadcast.id,
      visibility: "broadcast",
      recipients: [],
      claims: [],
    });

    runtime.maintenance.grantClientCube({ clientId: ids.clientB, cubeId: ids.cubeA, access: "read" });
    const observer = runtime.forPrincipal(clientPrincipal(ids.clientB));
    expect(observer.readAckStatus(ids.cubeA, broadcast.id).visibility).toBe("broadcast");
    expect(() => observer.readAckStatus(ids.cubeA, direct.id)).toThrow(ScopedStoreError);
    expect(() => manager.readAckStatus(ids.cubeA, randomUUID())).toThrow(ScopedStoreError);
    expect(() => manager.readAckStatus(ids.cubeB, direct.id)).toThrow(ScopedStoreError);
  });

  it("tracks sender posts separately from roster anchor liveness", () => {
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const anchor = drone.appendLog(ids.cubeA, { visibility: "broadcast", message: "dispatch received" });
    expect(drone.listDronesSince(ids.cubeA, anchor.id).drones).toContainEqual(
      expect.objectContaining({ id: ids.droneA, seen_since: false }),
    );
    const response = drone.appendLog(ids.cubeA, { visibility: "broadcast", message: "response posted" });
    expect(drone.listDronesSince(ids.cubeA, anchor.id)).toMatchObject({
      since: anchor.created_at,
      drones: [expect.objectContaining({
        id: ids.droneA,
        last_seen: response.created_at,
        last_log_post_at: response.created_at,
        seen_since: true,
      })],
    });
    expect(() => drone.listDronesSince(ids.cubeA, randomUUID())).toThrow(ScopedStoreError);
  });

  it("never wakes an idle seat solely because time has elapsed", async () => {
    const path = join(directory, "borg.db");
    runtime.close();
    runtime = await openStore({ path, clock: () => new Date("2026-07-14T12:20:00.000Z") });
    const peerDroneId = "00000000-0000-4000-8000-000000000031";
    const peerSessionId = "00000000-0000-4000-8000-000000000032";
    runtime.maintenance.createDrone({
      id: peerDroneId,
      cubeId: ids.cubeA,
      roleId: ids.roleA,
      clientId: ids.clientA,
      label: "two-of-two-queen",
    });
    runtime.maintenance.createDroneSession({
      id: peerSessionId,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: peerDroneId,
    });
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const peer = runtime.forPrincipal(droneSessionPrincipal({
      id: peerSessionId,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: peerDroneId,
    }));
    const events: ActivityStreamRecord[] = [];
    const peerEvents: ActivityStreamRecord[] = [];
    const stop = drone.subscribeActivity(ids.cubeA, (entry) => events.push(entry));
    const stopPeer = peer.subscribeActivity(ids.cubeA, (entry) => peerEvents.push(entry));
    const before = drone.readLog(ids.cubeA, null, 10);
    expect(runtime.liveness.scan()).toEqual([]);
    expect(events).toEqual([]);
    expect(peerEvents).toEqual([]);
    expect(drone.readLog(ids.cubeA, null, 10)).toEqual(before);
    expect(runtime.liveness.scan()).toEqual([]);
    stop();
    stopPeer();
    runtime.close();
    runtime = await openStore({ path, clock: () => new Date("2026-07-14T12:40:00.000Z") });
    expect(runtime.liveness.scan()).toEqual([]);
  });

  it("never wakes revoked or evicted sessions", () => {
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));

    expect(runtime.liveness.scan()).toEqual([]);
    runtime.maintenance.revokeDroneSession(ids.sessionA);
    expect(runtime.liveness.scan()).toEqual([]);
    manager.evictDrone(ids.cubeA, ids.droneA);
    expect(runtime.liveness.scan()).toEqual([]);
  });

  it("does not create synthetic work for a large idle fleet", async () => {
    for (let index = 0; index < 29; index += 1) {
      const droneId = `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
      const sessionId = `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`;
      runtime.maintenance.createDrone({
        id: droneId,
        cubeId: ids.cubeA,
        roleId: ids.roleA,
        clientId: ids.clientA,
        label: `builder-${index + 2}`,
      });
      runtime.maintenance.createDroneSession({
        id: sessionId,
        clientId: ids.clientA,
        cubeId: ids.cubeA,
        droneId,
      });
    }
    const path = join(directory, "borg.db");
    runtime.close();
    runtime = await openStore({ path, clock: () => new Date("2026-07-14T12:20:00.000Z") });

    expect(runtime.liveness.scan()).toEqual([]);
    expect(runtime.liveness.scan()).toEqual([]);
  });

  it("paginates monotonic tuple cursors and keeps claims outside the log cursor", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const alpha = client.appendLog(ids.cubeA, { visibility: "broadcast", message: "alpha" });
    const beta = client.appendLog(ids.cubeA, { visibility: "broadcast", message: "beta" });
    const gamma = client.appendLog(ids.cubeA, { visibility: "broadcast", message: "gamma" });

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
      appended.push(client.appendLog(ids.cubeA, { visibility: "broadcast", message: `entry-${index.toString().padStart(2, "0")}` }));
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
    expect(() => client.readAckStatus(ids.cubeA, first.id)).toThrow(ScopedStoreError);
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
    const retained = client.appendLog(ids.cubeA, { visibility: "broadcast", message: "retained" });

    capacity = { databaseBytes: 0, freeDiskBytes: 0 };
    expect(() => client.appendLog(ids.cubeA, { visibility: "broadcast", message: "disk-pressure-secret" })).toThrowError(
      expect.objectContaining({
        name: "StorageCapacityError",
        code: "CAPACITY_EXCEEDED",
        message: "Storage capacity is unavailable.",
      }),
    );
    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };
    expect(() => client.appendLog(ids.cubeA, { visibility: "broadcast", message: "database-pressure-secret" }))
      .toThrow(StorageCapacityError);
    expect(client.readLog(ids.cubeA, null, 10).entries).toEqual([retained]);
  });

  it("capacity-gates document removal without changing audit state", async () => {
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
    const document = client.putDocument(ids.cubeA, {
      title: "Removal capacity evidence",
      contentType: "text/plain",
      content: "immutable",
    });
    const inspectAudit = () => {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return database.prepare(`
          SELECT state, removed_by_kind, removed_by_id, removed_by_drone_id,
                 removed_by_label, removed_by_role, removed_at
          FROM documents WHERE id = ?
        `).get(document.id);
      } finally {
        database.close();
      }
    };
    const unchanged = {
      state: "active",
      removed_by_kind: null,
      removed_by_id: null,
      removed_by_drone_id: null,
      removed_by_label: null,
      removed_by_role: null,
      removed_at: null,
    };

    for (const pressure of [
      { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 },
      { databaseBytes: 0, freeDiskBytes: 0 },
    ]) {
      capacity = pressure;
      expect(() => client.removeDocument(ids.cubeA, document.id)).toThrowError(
        expect.objectContaining({ name: "StorageCapacityError", code: "CAPACITY_EXCEEDED" }),
      );
      expect(client.getDocument(ids.cubeA, document.id)).toMatchObject({
        state: "active",
        removed_by: null,
        removed_at: null,
      });
      expect(inspectAudit()).toEqual(unchanged);
    }

    capacity = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    const removed = client.removeDocument(ids.cubeA, document.id);
    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 0 };
    expect(client.removeDocument(ids.cubeA, document.id)).toEqual(removed);
    expect(inspectAudit()).toMatchObject({ state: "removed" });
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
    const baseline = client.appendLog(ids.cubeA, { visibility: "broadcast", message: "baseline" });
    const beforeDrones = client.listDrones(ids.cubeA);
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const mutableRole = client.createRole(ids.cubeA, {
      name: "Mutable role",
      detailedDescription: "Workflow:\n- retained\n",
    });
    const digester = new CredentialDigester(Buffer.alloc(32, 9));
    const authority = new CredentialAuthority(runtime.credentials, digester);
    const invitation = authority.createBootstrapInvitation(60_000);
    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };

    const denied: Array<() => unknown> = [
      () => client.updateDirective(ids.cubeA, "blocked directive"),
      () => client.appendLog(ids.cubeA, { visibility: "broadcast", message: "blocked log" }),
      () => client.acknowledge(ids.cubeA, baseline.id, "claim"),
      () => client.recordDecision(ids.cubeA, { topic: "blocked", decision: "blocked" }),
      () => client.createRole(ids.cubeA, { name: "Blocked role" }),
      () => client.updateRole(ids.cubeA, mutableRole.id, { detailedDescription: "blocked update" }),
      () => client.patchRoleSection(ids.cubeA, mutableRole.id, {
        action: "replace", heading: "Workflow", body: "blocked section",
      }),
      () => client.attachSeat({
        cubeId: ids.cubeA,
        roleId: ids.roleA,
        droneId: "00000000-0000-4000-8000-000000000032",
        sessionId: "00000000-0000-4000-8000-000000000033",
        credentialId: "00000000-0000-4000-8000-000000000034",
        credentialDigest: { lookup: Buffer.alloc(16), verifier: Buffer.alloc(32) },
      }),
      () => drone.updateOwnRuntimeMetadata(ids.cubeA, { reported_model: "blocked-model" }),
      () => authority.exchangeInvitation({
        invitation,
        retryKey: randomUUID(),
        clientCredential: generateSecret(),
        clientName: "blocked enrollment",
      }),
    ];
    for (const mutation of denied) expect(mutation).toThrow(StorageCapacityError);

    expect(client.getCube(ids.cubeA)?.directive).toBe("A");
    expect(client.readLog(ids.cubeA, null, 10)).toMatchObject({ entries: [baseline], claims: [] });
    expect(client.listDecisions(ids.cubeA)).toEqual([]);
    expect(client.listDrones(ids.cubeA)).toEqual(beforeDrones);
    expect(client.listRoles(ids.cubeA).find((role) => role.id === mutableRole.id)?.detailed_description)
      .toBe("Workflow:\n- retained\n");
    capacity = { databaseBytes: 0, freeDiskBytes: 2_000_000 };
    expect(authority.exchangeInvitation({
      invitation,
      retryKey: randomUUID(),
      clientCredential: generateSecret(),
      clientName: "allowed enrollment",
    })).not.toBeNull();
    digester.destroy();
  });

  it("capacity-gates own metadata after scope checks without mutating report state", async () => {
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
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const before = manager.listDrones(ids.cubeA).find(({ id }) => id === ids.droneA);

    capacity = { databaseBytes: 1_000_000, freeDiskBytes: 2_000_000 };
    expect(() => drone.updateOwnRuntimeMetadata(
      ids.cubeA,
      { reported_model: "database-pressure-secret" },
    )).toThrow(StorageCapacityError);
    capacity = { databaseBytes: 0, freeDiskBytes: 0 };
    expect(() => drone.updateOwnRuntimeMetadata(
      ids.cubeA,
      { reported_model: "disk-pressure-secret" },
    )).toThrow(StorageCapacityError);

    const crossCube = () => drone.updateOwnRuntimeMetadata(
      ids.cubeB,
      { reported_model: "foreign-probe" },
    );
    const unknownCube = () => drone.updateOwnRuntimeMetadata(
      "00000000-0000-4000-8000-000000000099",
      { reported_model: "unknown-probe" },
    );
    expect(crossCube).toThrow(ScopedStoreError);
    expect(unknownCube).toThrow(ScopedStoreError);
    try {
      crossCube();
    } catch (crossError) {
      try {
        unknownCube();
      } catch (unknownError) {
        expect({ name: (crossError as Error).name, message: (crossError as Error).message })
          .toEqual({ name: (unknownError as Error).name, message: (unknownError as Error).message });
      }
    }
    expect(manager.listDrones(ids.cubeA).find(({ id }) => id === ids.droneA)).toEqual(before);
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
      expect(() => client.appendLog(ids.cubeA, { visibility: "broadcast", message: "blocked" })).toThrowError(
        expect.objectContaining({ code: "CAPACITY_EXCEEDED", message: "Storage capacity is unavailable." }),
      );
    }
    shouldThrow = true;
    expect(() => client.appendLog(ids.cubeA, { visibility: "broadcast", message: "blocked" })).toThrowError(
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
    expect(() => client.appendLog(ids.cubeA, { visibility: "broadcast", message: "x" })).toThrow(StorageCapacityError);
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
    const entry = client.appendLog(ids.cubeA, { visibility: "broadcast", message: "retained" });
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
    })).toThrow(AccessDeniedError);
  });

  it("enforces the active decision text budget without partial writes", async () => {
    const path = join(directory, "borg.db");
    runtime.close();
    runtime = await openStore({
      path,
      storageLimits: {
        maxActivityEntriesPerCube: 10_000,
        maxActiveDecisionBytesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 1,
      },
      capacityProbe: () => ({ databaseBytes: 0, freeDiskBytes: 1_000_000 }),
    });
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const first = client.recordDecision(ids.cubeA, { topic: "a", decision: "12345678" });
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    const snapshot = () => database.prepare(`
      SELECT id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
      FROM decisions ORDER BY id
    `).all();
    try {
      const before = snapshot();
      expect(() => client.recordDecision(ids.cubeA, { topic: "b", decision: "x" }))
        .toThrowError(expect.objectContaining({
          name: "StorageCapacityError",
          code: "CAPACITY_EXCEEDED",
          message: expect.stringContaining("10 bytes maximum, 9 bytes currently active"),
        }));
      expect(() => client.recordDecision(ids.cubeA, { topic: "b", decision: "x" }))
        .toThrow(/remove outdated entries with borg_remove-decision/);
      expect(snapshot()).toEqual(before);
      expect(client.listDecisions(ids.cubeA)).toEqual([first]);
    } finally {
      database.close();
    }
  });

  it("allows same-topic replacement at and over the decision budget", async () => {
    const path = join(directory, "borg.db");
    runtime.close();
    runtime = await openStore({
      path,
      storageLimits: {
        maxActivityEntriesPerCube: 10_000,
        maxActiveDecisionBytesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 1,
      },
      capacityProbe: () => ({ databaseBytes: 0, freeDiskBytes: 1_000_000 }),
    });
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const atBudget = client.recordDecision(ids.cubeA, { topic: "a", decision: "123456789" });
    const equal = client.recordDecision(ids.cubeA, { topic: "a", decision: "123456789" });
    expect(equal.supersedes).toBe(atBudget.id);
    const smaller = client.recordDecision(ids.cubeA, { topic: "a", decision: "x" });
    const secondTopic = client.recordDecision(ids.cubeA, { topic: "b", decision: "1234567" });
    expect(smaller.supersedes).toBe(equal.id);
    expect(secondTopic.supersedes).toBeNull();

    runtime.close();
    runtime = await openStore({
      path,
      storageLimits: {
        maxActivityEntriesPerCube: 10_000,
        maxActiveDecisionBytesPerCube: 5,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 1,
      },
      capacityProbe: () => ({ databaseBytes: 0, freeDiskBytes: 1_000_000 }),
    });
    const overBudgetClient = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    const before = database.prepare(`
      SELECT id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
      FROM decisions ORDER BY id
    `).all();
    try {
      expect(() => overBudgetClient.recordDecision(ids.cubeA, {
        topic: "a",
        decision: "1234567890",
      })).toThrowError(expect.objectContaining({
        name: "StorageCapacityError",
        code: "CAPACITY_EXCEEDED",
      }));
      expect(database.prepare(`
        SELECT id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
        FROM decisions ORDER BY id
      `).all()).toEqual(before);
      const replacement = overBudgetClient.recordDecision(ids.cubeA, { topic: "a", decision: "x" });
      expect(replacement.supersedes).toBe(smaller.id);
      expect(overBudgetClient.listDecisions(ids.cubeA)).toEqual([replacement, secondTopic]);
    } finally {
      database.close();
    }
  });

  it("removes active decisions without deleting their audit records", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const firstByTopic = client.recordDecision(ids.cubeA, {
      topic: "topic-removal",
      decision: "superseded decision",
    });
    const supersededByTopic = client.recordDecision(ids.cubeA, {
      topic: firstByTopic.topic,
      decision: "first removed decision",
    });
    const firstRemoved = client.removeDecision(ids.cubeA, { topic: supersededByTopic.topic });
    const database = new DatabaseSync(join(directory, "borg.db"), {
      enableForeignKeyConstraints: true,
    });
    database.prepare("UPDATE decisions SET id = ? WHERE id = ?").run(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      firstRemoved.id,
    );
    database.close();
    const byTopic = client.recordDecision(ids.cubeA, { topic: firstByTopic.topic, decision: "remove me" });
    expect(byTopic.supersedes).toBeNull();
    const removedByTopic = client.removeDecision(ids.cubeA, { topic: byTopic.topic });
    expect(removedByTopic).toMatchObject({ id: byTopic.id, status: "removed" });
    expect(client.listDecisions(ids.cubeA)).toEqual([]);

    const byId = client.recordDecision(ids.cubeA, { topic: "id-removal", decision: "remove me too" });
    const removedById = client.removeDecision(ids.cubeA, { decisionId: byId.id });
    expect(removedById).toMatchObject({ id: byId.id, status: "removed" });
    expect(() => client.removeDecision(ids.cubeA, { decisionId: byId.id })).toThrow(ScopedStoreError);
  });

  it("derives roster wake state from directed acknowledgements and retries bounded wake pings", async () => {
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const delivered: ActivityStreamRecord[] = [];
    const unsubscribe = drone.subscribeActivity(ids.cubeA, (entry) => delivered.push(entry));
    expect(runtime.forPrincipal(clientPrincipal(ids.clientA)).listDrones(ids.cubeA)[0]!.wake_state)
      .toBe("idle");
    const entry = manager.appendLog(ids.cubeA, {
      message: "wake me",
      visibility: "direct",
      recipientDroneIds: [ids.droneA],
    });
    expect(runtime.forPrincipal(clientPrincipal(ids.clientA)).listDrones(ids.cubeA)[0]!.wake_state)
      .toBe("pending");

    storeNow = new Date("2026-07-14T12:01:01.000Z");
    runtime.liveness.scan();
    storeNow = new Date("2026-07-14T12:01:02.000Z");
    runtime.liveness.scan();
    expect(delivered.filter((value) => value.id === entry.id)).toHaveLength(2);
    const wakeEvents = delivered.filter((value) => value.id === entry.id && "wake_nonce" in value);
    expect(wakeEvents).toHaveLength(1);
    expect(wakeEvents[0]!.wake_nonce).toEqual(expect.any(String));
    expect(runtime.forPrincipal(clientPrincipal(ids.clientA)).listDrones(ids.cubeA)[0]!.wake_state)
      .toBe("pending");
    runtime.close();
    runtime = await openStore({ path: join(directory, "borg.db"), clock: () => storeNow });
    const resumedDrone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const resumedEvents: ActivityStreamRecord[] = [];
    const stopResumed = resumedDrone.subscribeActivity(ids.cubeA, (value) => resumedEvents.push(value));
    storeNow = new Date("2026-07-14T12:02:02.000Z");
    runtime.liveness.scan();
    expect(resumedEvents.filter((value) => "wake_nonce" in value)).toHaveLength(1);
    expect(resumedEvents.find((value) => "wake_nonce" in value)!.wake_nonce)
      .not.toBe(wakeEvents[0]!.wake_nonce);
    const database = new DatabaseSync(join(directory, "borg.db"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_log").get()).toMatchObject({ count: 1 });
    database.close();
    storeNow = new Date("2026-07-14T12:03:02.000Z");
    expect(runtime.liveness.scan()).toEqual([]);
    expect(runtime.forPrincipal(clientPrincipal(ids.clientA)).listDrones(ids.cubeA)[0]!.wake_state)
      .toBe("stale");

    resumedDrone.acknowledge(ids.cubeA, entry.id, "ack");
    expect(runtime.forPrincipal(clientPrincipal(ids.clientA)).listDrones(ids.cubeA)[0]!.wake_state)
      .toBe("awake");
    unsubscribe();
    stopResumed();
  });

  it("redacts database failures from liveness scans", () => {
    const database = new DatabaseSync(join(directory, "borg.db"));
    database.exec("DROP TABLE activity_log_recipients");
    database.close();
    let failure: unknown;

    try {
      runtime.liveness.scan();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(operatorErrors.LIVENESS_SCAN_FAILED);
    expect((failure as Error).message).not.toContain("activity_log_recipients");
  });

  it("keeps overlapping wake subscriptions registered until the last one closes", () => {
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const first: ActivityStreamRecord[] = [];
    const second: ActivityStreamRecord[] = [];
    const stopFirst = drone.subscribeActivity(ids.cubeA, (entry) => first.push(entry));
    const stopSecond = drone.subscribeActivity(ids.cubeA, (entry) => second.push(entry));
    stopFirst();
    const entry = manager.appendLog(ids.cubeA, {
      message: "overlapping wake listener",
      visibility: "direct",
      recipientDroneIds: [ids.droneA],
    });
    expect(first).toEqual([]);
    expect(second.map((value) => value.id)).toEqual([entry.id]);
    storeNow = new Date("2026-07-14T12:01:01.000Z");
    runtime.liveness.scan();
    expect(second.filter((value) => "wake_nonce" in value)).toHaveLength(1);
    stopSecond();
  });

  it("keeps wake bookkeeping bounded across many directed entries without log writes", () => {
    const manager = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const drone = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const delivered: ActivityStreamRecord[] = [];
    const stop = drone.subscribeActivity(ids.cubeA, (entry) => delivered.push(entry));
    for (let index = 0; index < 32; index += 1) {
      manager.appendLog(ids.cubeA, {
        message: `many-entry-${index}`,
        visibility: "direct",
        recipientDroneIds: [ids.droneA],
      });
    }
    const database = new DatabaseSync(join(directory, "borg.db"));
    const logCount = database.prepare("SELECT COUNT(*) AS count FROM activity_log").get();
    storeNow = new Date("2026-07-14T12:01:01.000Z");
    runtime.liveness.scan();
    expect(delivered.filter((entry) => "wake_nonce" in entry)).toHaveLength(32);
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_log").get()).toEqual(logCount);
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_wake_attempts").get())
      .toEqual({ count: 32 });
    database.close();
    stop();
  });
});

describe("directed-entry acknowledgement authorization", () => {
  const recipientDroneId = "00000000-0000-4000-8000-000000000031";
  const recipientSessionId = "00000000-0000-4000-8000-000000000032";
  const outsiderDroneId = "00000000-0000-4000-8000-000000000033";
  const outsiderSessionId = "00000000-0000-4000-8000-000000000034";

  function seats() {
    runtime.maintenance.grantClientCube({
      clientId: ids.clientB,
      cubeId: ids.cubeA,
      access: "write",
    });
    runtime.maintenance.createDrone({
      id: recipientDroneId,
      cubeId: ids.cubeA,
      roleId: ids.roleA,
      clientId: ids.clientA,
      label: "two-of-three-queen",
    });
    runtime.maintenance.createDroneSession({
      id: recipientSessionId,
      clientId: ids.clientA,
      cubeId: ids.cubeA,
      droneId: recipientDroneId,
    });
    runtime.maintenance.createDrone({
      id: outsiderDroneId,
      cubeId: ids.cubeA,
      roleId: ids.roleA,
      clientId: ids.clientB,
      label: "three-of-three-queen",
    });
    runtime.maintenance.createDroneSession({
      id: outsiderSessionId,
      clientId: ids.clientB,
      cubeId: ids.cubeA,
      droneId: outsiderDroneId,
    });
    return {
      author: runtime.forPrincipal(droneSessionPrincipal({
        id: ids.sessionA,
        clientId: ids.clientA,
        cubeId: ids.cubeA,
        droneId: ids.droneA,
      })),
      recipient: runtime.forPrincipal(droneSessionPrincipal({
        id: recipientSessionId,
        clientId: ids.clientA,
        cubeId: ids.cubeA,
        droneId: recipientDroneId,
      })),
      outsider: runtime.forPrincipal(droneSessionPrincipal({
        id: outsiderSessionId,
        clientId: ids.clientB,
        cubeId: ids.cubeA,
        droneId: outsiderDroneId,
      })),
    };
  }

  it("accepts ack and claim from an addressed recipient", () => {
    const { author, recipient } = seats();
    const entry = author.appendLog(ids.cubeA, {
      message: "routed work",
      visibility: "direct",
      recipientDroneIds: [recipientDroneId],
    });
    recipient.acknowledge(ids.cubeA, entry.id, "ack");
    recipient.acknowledge(ids.cubeA, entry.id, "claim");
    const status = runtime.forPrincipal(clientPrincipal(ids.clientA))
      .readAckStatus(ids.cubeA, entry.id);
    expect(status.recipients).toEqual([expect.objectContaining({
      drone_id: recipientDroneId,
      acknowledged_at: expect.any(String),
    })]);
    expect(status.claims).toEqual([expect.objectContaining({ drone_id: recipientDroneId })]);
  });

  it("refuses ack and claim from a write-capable unaddressed drone without persisting", () => {
    const { author, outsider } = seats();
    const entry = author.appendLog(ids.cubeA, {
      message: "routed work",
      visibility: "direct",
      recipientDroneIds: [recipientDroneId],
    });
    const before = runtime.maintenance.observeAuthorityState();
    expect(() => outsider.acknowledge(ids.cubeA, entry.id, "ack")).toThrow(ScopedStoreError);
    expect(() => outsider.acknowledge(ids.cubeA, entry.id, "claim")).toThrow(ScopedStoreError);
    expect(runtime.maintenance.observeAuthorityState()).toEqual(before);
    const status = runtime.forPrincipal(clientPrincipal(ids.clientA))
      .readAckStatus(ids.cubeA, entry.id);
    expect(status.recipients).toEqual([expect.objectContaining({
      drone_id: recipientDroneId,
      acknowledged_at: null,
    })]);
    expect(status.claims).toEqual([]);
  });

  it("refuses the author's own ack when the author is not an addressed recipient", () => {
    const { author } = seats();
    const entry = author.appendLog(ids.cubeA, {
      message: "routed elsewhere",
      visibility: "direct",
      recipientDroneIds: [recipientDroneId],
    });
    expect(() => author.acknowledge(ids.cubeA, entry.id, "ack")).toThrow(ScopedStoreError);
  });

  it("keeps broadcast entries acknowledgeable and claimable by any write-capable drone", () => {
    const { author, outsider } = seats();
    const entry = author.appendLog(ids.cubeA, { visibility: "broadcast", message: "open work" });
    outsider.acknowledge(ids.cubeA, entry.id, "ack");
    outsider.acknowledge(ids.cubeA, entry.id, "claim");
    const status = runtime.forPrincipal(clientPrincipal(ids.clientA))
      .readAckStatus(ids.cubeA, entry.id);
    expect(status.claims).toEqual([expect.objectContaining({ drone_id: outsiderDroneId })]);
  });

  it("keeps client-principal acknowledgement of directed entries unchanged", () => {
    const { author } = seats();
    const entry = author.appendLog(ids.cubeA, {
      message: "administrative",
      visibility: "direct",
      recipientDroneIds: [recipientDroneId],
    });
    runtime.forPrincipal(clientPrincipal(ids.clientA)).acknowledge(ids.cubeA, entry.id, "claim");
  });
});

describe("pruned cursor expiry recognition", () => {
  it("keeps CURSOR_EXPIRED after the expiry ledger row itself is pruned", async () => {
    runtime.close();
    runtime = await openStore({
      path: join(directory, "borg.db"),
      clock: () => storeNow,
      storageLimits: {
        maxActivityEntriesPerCube: 10,
        maxDatabaseBytes: 1_000_000,
        minFreeDiskBytes: 1,
      },
      capacityProbe: () => ({ databaseBytes: 0, freeDiskBytes: 1_000_000 }),
    });
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    const appended = [];
    for (let index = 0; index < 50; index += 1) {
      appended.push(client.appendLog(ids.cubeA, {
        visibility: "broadcast",
        message: `entry-${index.toString().padStart(2, "0")}`,
      }));
    }
    // Entries 0-39 are pruned; the expiry ledger retains only the newest ten pruned rows.
    const inLedger = appended[35]!;
    expect(() => client.readLog(
      ids.cubeA,
      { id: inLedger.id, created_at: inLedger.created_at },
      10,
    )).toThrow(CursorExpiredError);
    const agedOut = appended[0]!;
    expect(() => client.readLog(
      ids.cubeA,
      { id: agedOut.id, created_at: agedOut.created_at },
      10,
    )).toThrow(CursorExpiredError);
    // Unknown cursors inside and above the retained range stay NOT_FOUND.
    const retained = appended[45]!;
    expect(() => client.readLog(
      ids.cubeA,
      { id: randomUUID(), created_at: retained.created_at },
      10,
    )).toThrow(ScopedStoreError);
    expect(() => client.readLog(
      ids.cubeA,
      { id: randomUUID(), created_at: "2026-07-15T00:00:00.000Z" },
      10,
    )).toThrow(ScopedStoreError);
  });

  it("reports an unknown below-range cursor as NOT_FOUND while the cube has never pruned", () => {
    const client = runtime.forPrincipal(clientPrincipal(ids.clientA));
    client.appendLog(ids.cubeA, { visibility: "broadcast", message: "only entry" });
    expect(() => client.readLog(
      ids.cubeA,
      { id: randomUUID(), created_at: "2020-01-01T00:00:00.000Z" },
      10,
    )).toThrow(ScopedStoreError);
  });
});
