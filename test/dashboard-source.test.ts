import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
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
    expect(source.read().cubes[0]).toMatchObject({ posts_15m: 0 });

    now = new Date("2026-07-25T12:01:00.000Z");
    writer.forPrincipal(droneSessionPrincipal({
      id: ids.session,
      clientId: ids.client,
      cubeId: ids.cube,
      droneId: ids.drone,
    })).appendLog(ids.cube, { message: "poll-secret-body" });
    await vi.advanceTimersByTimeAsync(100);

    expect(validate).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(source.read().cubes[0]).toMatchObject({
      posts_15m: 1,
      distinct_posting_drones_15m: 1,
      last_post_at: "2026-07-25T12:01:00.000Z",
    });
    expect(JSON.stringify(source.read())).not.toContain("poll-secret-body");
    unsubscribe();
    source.close();
    expect(() => source.subscribe(vi.fn())).toThrow("closed");
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
}
