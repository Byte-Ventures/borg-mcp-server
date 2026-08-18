import { randomUUID } from "node:crypto";
import {
  renameSync,
  symlinkSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapServer } from "../src/bootstrap.js";
import { openReadonlyDashboardSnapshotSource } from "../src/dashboard-source.js";
import { operatorErrors } from "../src/operator-error.js";
import { droneSessionPrincipal } from "../src/principal.js";
import { openStore, type StoreRuntime } from "../src/store.js";

const ids = {
  client: "00000000-0000-4000-8000-000000000101",
  cube: "00000000-0000-4000-8000-000000000102",
  role: "00000000-0000-4000-8000-000000000103",
  drone: "00000000-0000-4000-8000-000000000104",
  session: "00000000-0000-4000-8000-000000000105",
} as const;

let directory: string | undefined;
let writer: StoreRuntime | undefined;

afterEach(async () => {
  vi.useRealTimers();
  writer?.close();
  writer = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("read-only dashboard snapshot source", () => {
  it("uses the canonical wake-stale boundary and clears attention on recipient acknowledgement", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-attention-")));
    await bootstrapServer(directory);
    let now = new Date("2026-07-25T11:57:00.001Z");
    writer = await openStore({
      path: join(directory, "borg.db"),
      clock: () => now,
      migrationMode: "require-current",
    });
    seed(writer);
    const drone = writer.forPrincipal(droneSessionPrincipal({
      id: ids.session,
      clientId: ids.client,
      cubeId: ids.cube,
      droneId: ids.drone,
    }));
    const entry = drone.appendLog(ids.cube, {
      message: `${"x".repeat(256)}TAIL_SENTINEL`,
      visibility: "direct",
      recipientDroneIds: [ids.drone],
    });
    now = new Date("2026-07-25T12:00:00.000Z");
    expect(writer.dashboard.read().attention).toMatchObject({
      unacked_directed: 1,
      stale_directed: 0,
    });
    now = new Date("2026-07-25T12:00:00.001Z");
    const stale = writer.dashboard.read();
    expect(stale.attention).toMatchObject({ unacked_directed: 1, stale_directed: 1 });
    expect(stale.recent_activity[0]?.message_head).toHaveLength(256);
    expect(stale.recent_activity[0]?.message_head).not.toContain("TAIL_SENTINEL");
    drone.acknowledge(ids.cube, entry.id, "ack");
    expect(writer.dashboard.read().attention).toMatchObject({ unacked_directed: 0, stale_directed: 0 });
    for (let index = 0; index < 10; index += 1) {
      drone.appendLog(ids.cube, {
        message: `recent-${index}`,
        visibility: "broadcast",
        routingKey: index === 9 ? "checkpoint" : null,
      });
    }
    const recent = writer.dashboard.read().recent_activity;
    expect(recent).toHaveLength(8);
    expect(recent[0]).toMatchObject({ message_head: "recent-9", activity_class: "checkpoint" });
    expect(recent.at(-1)?.message_head).toBe("recent-2");
  });

  it("polls a live WAL database without selecting activity bodies", async () => {
    vi.useFakeTimers();
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-poll-")));
    await bootstrapServer(directory);
    let now = new Date("2026-07-25T12:00:00.000Z");
    writer = await openStore({
      path: join(directory, "borg.db"),
      clock: () => now,
      migrationMode: "require-current",
    });
    seed(writer);
    const validate = vi.fn();
    const source = await openReadonlyDashboardSnapshotSource({
      dataDirectory: directory,
      clock: () => now,
      pollIntervalMs: 100,
      validate,
    });
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    expect(source.read().cubes[0]).toMatchObject({
      posts_15m: 0,
      drones: [{
        id: ids.drone,
        label: "builder-dashboard",
        role: "Builder",
        reported_model: "source-model",
        last_seen: "2026-07-25T12:00:00.000Z",
        sent: 0,
        sent_5s: 0,
        received: 0,
      }],
    });

    now = new Date("2026-07-25T12:01:00.000Z");
    writer.forPrincipal(droneSessionPrincipal({
      id: ids.session,
      clientId: ids.client,
      cubeId: ids.cube,
      droneId: ids.drone,
    })).appendLog(ids.cube, {
      message: "poll-secret-body",
      visibility: "direct",
      recipientDroneIds: [ids.drone],
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(validate).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(source.read().cubes[0]).toMatchObject({
      posts_15m: 1,
      distinct_posting_drones_15m: 1,
      last_post_at: "2026-07-25T12:01:00.000Z",
      drones: [{ sent: 1, sent_5s: 1, received: 1 }],
    });
    expect(source.read().recent_activity[0]).toMatchObject({
      message_head: "poll-secret-body",
      visibility: "direct",
      recipient_count: 1,
    });
    unsubscribe();
    source.close();
    expect(() => source.subscribe(vi.fn())).toThrow("closed");
  });

  it("counts sent_5s from the trailing tick rather than the 15-minute total", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-windowed-")));
    await bootstrapServer(directory);
    let now = new Date("2026-07-25T12:00:00.000Z");
    writer = await openStore({
      path: join(directory, "borg.db"),
      clock: () => now,
      migrationMode: "require-current",
    });
    seed(writer);
    const append = (timestamp: string) => {
      now = new Date(timestamp);
      writer!.forPrincipal(droneSessionPrincipal({
        id: ids.session,
        clientId: ids.client,
        cubeId: ids.cube,
        droneId: ids.drone,
      })).appendLog(ids.cube, {
        message: `windowed-${timestamp}`,
        visibility: "direct",
        recipientDroneIds: [ids.drone],
      });
    };
    append("2026-07-25T11:44:59.000Z");
    append("2026-07-25T11:45:10.000Z");
    append("2026-07-25T11:59:54.000Z");
    append("2026-07-25T11:59:55.000Z");
    now = new Date("2026-07-25T12:00:00.000Z");

    const source = await openReadonlyDashboardSnapshotSource({
      dataDirectory: directory,
      clock: () => now,
    });
    expect(source.read().cubes[0]?.drones[0]).toMatchObject({
      sent: 3,
      sent_5s: 1,
      received: 3,
    });
    source.close();
  });

  it("counts only directed entries in the per-drone directed total", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-directed-")));
    await bootstrapServer(directory);
    writer = await openStore({
      path: join(directory, "borg.db"),
      clock: () => new Date("2026-07-25T12:00:00.000Z"),
      migrationMode: "require-current",
    });
    seed(writer);
    const drone = writer.forPrincipal(droneSessionPrincipal({
      id: ids.session,
      clientId: ids.client,
      cubeId: ids.cube,
      droneId: ids.drone,
    }));
    drone.appendLog(ids.cube, { visibility: "broadcast", message: "broadcast" });
    drone.appendLog(ids.cube, {
      message: "directed",
      visibility: "direct",
      recipientDroneIds: [ids.drone],
    });

    const source = await openReadonlyDashboardSnapshotSource({
      dataDirectory: directory,
      clock: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    expect(source.read().cubes[0]?.drones[0]).toMatchObject({
      sent: 2,
      received: 1,
    });
    source.close();
  });

  it("turns a failed live-runtime validation into a source read failure", async () => {
    vi.useFakeTimers();
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-stop-")));
    await bootstrapServer(directory);
    const source = await openReadonlyDashboardSnapshotSource({
      dataDirectory: directory,
      pollIntervalMs: 100,
      validate: () => { throw operatorErrors.DASHBOARD_SERVER_STOPPED; },
    });
    const listener = vi.fn();
    source.subscribe(listener);
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).toHaveBeenCalledOnce();
    expect(() => source.read()).toThrow(operatorErrors.DASHBOARD_SERVER_STOPPED);
    source.close();
  });

  it("turns a later read failure into a static operator error", async () => {
    vi.useFakeTimers();
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-read-error-")));
    await bootstrapServer(directory);
    const source = await openReadonlyDashboardSnapshotSource({
      dataDirectory: directory,
      pollIntervalMs: 100,
    });
    const listener = vi.fn();
    source.subscribe(listener);
    const mutator = new DatabaseSync(join(directory, "borg.db"));
    mutator.exec("DROP TABLE activity_log");
    mutator.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).toHaveBeenCalledOnce();
    expect(() => source.read()).toThrow(operatorErrors.DASHBOARD_DATA_UNAVAILABLE);
    source.close();
  });

  it("keeps a standalone viewer alive while its polling subscription is active", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-lifetime-")));
    await bootstrapServer(directory);
    const source = await openReadonlyDashboardSnapshotSource({
      dataDirectory: directory,
      pollIntervalMs: 100,
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    const realSetInterval = globalThis.setInterval;
    const interval = vi.spyOn(globalThis, "setInterval").mockImplementationOnce(
      ((handler: Parameters<typeof setInterval>[0], timeout?: number) => {
        timer = realSetInterval(handler, timeout);
        return timer;
      }) as typeof setInterval,
    );
    try {
      const unsubscribe = source.subscribe(vi.fn());
      expect(timer?.hasRef()).toBe(true);
      unsubscribe();
    } finally {
      interval.mockRestore();
      source.close();
    }
  });

  it("fails closed for a missing installation or non-private data directory", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-access-")));
    await expect(openReadonlyDashboardSnapshotSource({
      dataDirectory: join(directory, "missing"),
    })).rejects.toBe(operatorErrors.DASHBOARD_INSTALLATION_MISSING);

    await bootstrapServer(directory);
    await chmod(directory, 0o755);
    await expect(openReadonlyDashboardSnapshotSource({
      dataDirectory: directory,
    })).rejects.toBe(operatorErrors.DASHBOARD_DATA_UNAVAILABLE);
    await chmod(directory, 0o700);

    await chmod(join(directory, "borg.db"), 0o640);
    await expect(openReadonlyDashboardSnapshotSource({
      dataDirectory: directory,
    })).rejects.toBe(operatorErrors.DASHBOARD_DATA_UNAVAILABLE);
    await chmod(join(directory, "borg.db"), 0o600);
  });

  it("requires the viewer identity to own the directory and database", async () => {
    if (process.geteuid === undefined) return;
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-owner-")));
    await bootstrapServer(directory);
    const differentUserId = process.geteuid() + 1;
    const getEffectiveUserId = vi.spyOn(process, "geteuid").mockReturnValue(
      differentUserId,
    );
    try {
      await expect(openReadonlyDashboardSnapshotSource({
        dataDirectory: directory,
      })).rejects.toBe(operatorErrors.DASHBOARD_DATA_UNAVAILABLE);
    } finally {
      getEffectiveUserId.mockRestore();
    }
  });

  it("rejects a private installation beneath an untrusted writable ancestor", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-ancestor-")));
    const writableParent = join(directory, "writable-parent");
    const installation = join(writableParent, "server");
    await mkdir(writableParent, { mode: 0o777 });
    await chmod(writableParent, 0o777);
    await mkdir(installation, { mode: 0o700 });
    await bootstrapServer(installation);

    await expect(openReadonlyDashboardSnapshotSource({
      dataDirectory: installation,
    })).rejects.toBe(operatorErrors.DASHBOARD_DATA_UNAVAILABLE);
  });

  it("cannot be redirected by a directory substitution after pinning", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-swap-")));
    const installation = join(directory, "server");
    const heldInstallation = join(directory, "server-held");
    const replacement = join(directory, "replacement");
    await mkdir(installation, { mode: 0o700 });
    await mkdir(replacement, { mode: 0o700 });
    await bootstrapServer(installation);
    await bootstrapServer(replacement);
    insertCube(join(installation, "borg.db"), "Original cube");
    insertCube(join(replacement, "borg.db"), "RACE_TARGET");

    const realChdir = process.chdir.bind(process);
    const chdir = vi.spyOn(process, "chdir").mockImplementationOnce((path) => {
      realChdir(path);
      renameSync(installation, heldInstallation);
      symlinkSync(replacement, installation, "dir");
    });
    let source: Awaited<ReturnType<typeof openReadonlyDashboardSnapshotSource>> | undefined;
    try {
      source = await openReadonlyDashboardSnapshotSource({
        dataDirectory: installation,
      });
      expect(source.read().cubes.map((cube) => cube.name)).toEqual(["Original cube"]);
      expect(JSON.stringify(source.read())).not.toContain("RACE_TARGET");
      expect(chdir).toHaveBeenCalledTimes(2);
      expect(chdir).toHaveBeenNthCalledWith(1, installation);
    } finally {
      source?.close();
      const directoryWasSubstituted = chdir.mock.calls.length > 0;
      chdir.mockRestore();
      if (directoryWasSubstituted) {
        await rm(installation, { force: true });
        await rename(heldInstallation, installation);
      }
    }
  });

  it("restores cwd when a substitution is rejected before the open", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-restore-")));
    const installation = join(directory, "server");
    const heldInstallation = join(directory, "server-held");
    const replacement = join(directory, "replacement");
    await mkdir(installation, { mode: 0o700 });
    await mkdir(replacement, { mode: 0o700 });
    await bootstrapServer(installation);
    await bootstrapServer(replacement);

    const originalWorkingDirectory = process.cwd();
    const realChdir = process.chdir.bind(process);
    const chdir = vi.spyOn(process, "chdir").mockImplementationOnce((path) => {
      renameSync(installation, heldInstallation);
      symlinkSync(replacement, installation, "dir");
      realChdir(path);
    });
    try {
      await expect(openReadonlyDashboardSnapshotSource({
        dataDirectory: installation,
      })).rejects.toBe(operatorErrors.DASHBOARD_DATA_UNAVAILABLE);
      expect(chdir).toHaveBeenCalledTimes(2);
      expect(process.cwd()).toBe(originalWorkingDirectory);
    } finally {
      chdir.mockRestore();
      await rm(installation, { force: true });
      await rename(heldInstallation, installation);
    }
  });
});

function seed(runtime: StoreRuntime): void {
  runtime.maintenance.createClient({ id: ids.client, name: "Dashboard client" });
  runtime.maintenance.createCube({
    id: ids.cube,
    name: "Polling cube",
    directive: "Coordinate.",
  });
  runtime.maintenance.grantClientCube({
    clientId: ids.client,
    cubeId: ids.cube,
    access: "manage",
  });
  runtime.maintenance.createRole({
    id: ids.role,
    cubeId: ids.cube,
    name: "Builder",
  });
  runtime.maintenance.createDrone({
    id: ids.drone,
    cubeId: ids.cube,
    roleId: ids.role,
    clientId: ids.client,
    label: "builder-dashboard",
  });
  runtime.maintenance.createDroneSession({
    id: ids.session,
    clientId: ids.client,
    cubeId: ids.cube,
    droneId: ids.drone,
  });
  runtime.forPrincipal(droneSessionPrincipal({
    id: ids.session,
    clientId: ids.client,
    cubeId: ids.cube,
    droneId: ids.drone,
  })).updateOwnRuntimeMetadata(ids.cube, { reported_model: "source-model" });
}

function insertCube(databasePath: string, name: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const now = "2026-07-25T12:00:00.000Z";
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at)
      VALUES (?, ?, '', ?, ?)
    `).run(randomUUID(), name, now, now);
  } finally {
    database.close();
  }
}
