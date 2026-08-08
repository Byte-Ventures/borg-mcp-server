import { afterEach, expect, it, vi } from "vitest";

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
  cubes: [{
    id: "00000000-0000-4000-8000-000000000001",
    name: "cube",
    posts_15m: 1,
    distinct_posting_drones_15m: 1,
    drones_total: 1,
    drones_seen_15m: 1,
    last_post_at: null,
    drones: [{
      id: "10000000-0000-4000-8000-000000000001",
      label: "builder",
      role: "Builder",
      last_seen: "2026-07-25T12:00:00.000Z",
      sent: 1,
      sent_5s: 1,
      received: 1,
    }],
  }],
} as const;

const server = {
  name: "borgmcp-server",
  version: "0.14.2",
  endpoint: "https://127.0.0.1:7091",
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
