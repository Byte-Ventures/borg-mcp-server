import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const inkProbe = {
  mounts: 0,
  rerenders: 0,
};

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    render: (node: Parameters<typeof actual.render>[0], options: Parameters<typeof actual.render>[1]) => {
      inkProbe.mounts += 1;
      const instance = actual.render(node, options);
      return {
        ...instance,
        rerender: (nextNode: Parameters<typeof instance.rerender>[0]) => {
          inkProbe.rerenders += 1;
          return instance.rerender(nextNode);
        },
      };
    },
  };
});

const {
  createDashboardRenderer,
  startForegroundDashboard,
} = await import("../src/dashboard.js");

const snapshot = {
  captured_at: "2026-07-25T12:00:00.000Z",
  attention: { unacked_directed: 0, stale_directed: 0, oldest_unacked: null },
  recent_activity: [],
  cubes: [{
    id: "00000000-0000-4000-8000-000000000001",
    name: "cube",
    posts_15m: 1,
    distinct_posting_drones_15m: 1,
    drones_total: 1,
    drones_seen_15m: 1,
    last_post_at: null,
    attention: { unacked_directed: 0, stale_directed: 0, oldest_unacked: null },
    drones: [{
      id: "10000000-0000-4000-8000-000000000001",
      label: "builder",
      role: "Builder",
      last_seen: "2026-07-25T12:00:00.000Z",
      sent: 1,
      sent_5s: 1,
      received: 1,
      attention: { unacked_directed: 0, stale_directed: 0, oldest_unacked: null },
    }],
  }],
} as const;

const server = {
  name: "borgmcp-server",
  version: "0.14.2",
  endpoint: "https://127.0.0.1:7091",
  bind_mode: "loopback",
  state: "online",
  started_at: "2026-07-25T09:00:00.000Z",
} as const;

afterEach(() => {
  vi.useRealTimers();
  inkProbe.mounts = 0;
  inkProbe.rerenders = 0;
});

it("does not retain redundant live Ink renders for a stable roster and snapshot", async () => {
  vi.useFakeTimers();
  const source = {
    read: () => snapshot,
    subscribe: () => () => undefined,
  };
  const terminal = {
    write: () => undefined,
    dimensions: () => ({ columns: 80, rows: 24 }),
    onResize: () => () => undefined,
  };
  const dashboard = startForegroundDashboard({
    source,
    server,
    terminal,
    renderer: createDashboardRenderer({
      glyphMode: "ascii",
      color: false,
      footer: "^C stop server  |  read-only",
      motionMode: "off",
    }),
    idleRefreshMs: 100,
  });
  try {
    await vi.advanceTimersByTimeAsync(100 * 20);

    expect(inkProbe.mounts).toBe(1);
    // A stable semantic frame must not enqueue another live reconciler tree.
    expect(inkProbe.rerenders).toBe(0);
  } finally {
    dashboard.close();
  }
});

it("bounds live Ink paints for an active production-shaped roster", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const source = {
    read: () => {
      reads += 1;
      const capturedAt = new Date(
        Date.parse(snapshot.captured_at) + reads * 5_000,
      ).toISOString();
      return {
        ...snapshot,
        captured_at: capturedAt,
        cubes: [{
          ...snapshot.cubes[0]!,
          posts_15m: reads,
          last_post_at: capturedAt,
          drones: [{
            ...snapshot.cubes[0]!.drones[0]!,
            last_seen: capturedAt,
            sent: reads,
            sent_5s: reads,
            received: reads,
          }],
        }],
      };
    },
    subscribe: () => () => undefined,
  };
  const terminal = {
    write: () => undefined,
    dimensions: () => ({ columns: 80, rows: 24 }),
    onResize: () => () => undefined,
  };
  const dashboard = startForegroundDashboard({
    source,
    server,
    terminal,
    renderer: createDashboardRenderer({
      glyphMode: "ascii",
      color: false,
      footer: "^C stop server  |  read-only",
    }),
    idleRefreshMs: 100,
    pulseFrameMs: 25,
  });
  try {
    const initialRerenders = inkProbe.rerenders;
    await vi.advanceTimersByTimeAsync(100 * 8);

    expect(reads).toBe(9);
    expect(inkProbe.rerenders - initialRerenders).toBeLessThanOrEqual(8);
  } finally {
    dashboard.close();
  }
});

it("bounds retained heap for an active production-shaped roster", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--expose-gc", "test/dashboard-memory-probe.mjs"],
    { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
  );
  const line = stdout.split("\n").find((value) => value.startsWith("{"));
  expect(line).toBeDefined();
  const result = JSON.parse(line!);
  expect(result.reads).toBeGreaterThanOrEqual(150);
  expect(result.delta).toBeLessThan(8 * 1024 * 1024);
});
