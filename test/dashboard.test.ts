import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDashboardRenderer,
  dashboardColorEnabled,
  EMBEDDED_DASHBOARD_FOOTER,
  rankDashboardSnapshot,
  sanitizeTerminalText,
  selectDashboardGlyphMode,
  STANDALONE_DASHBOARD_FOOTER,
  startForegroundDashboard,
  type DashboardDataSnapshot,
  type DashboardFooter,
  type DashboardServerIdentity,
  type DashboardSnapshotSource,
  type DashboardTerminal,
} from "../src/dashboard.js";
import { droneSessionPrincipal } from "../src/principal.js";
import { openStore, type StoreRuntime } from "../src/store.js";

const server: DashboardServerIdentity = Object.freeze({
  name: "borgmcp-server",
  version: "0.2.0",
  endpoint: "https://127.0.0.1:7091",
  state: "online",
  started_at: "2026-07-25T09:00:00.000Z",
});

const ids = {
  client: "00000000-0000-4000-8000-000000000001",
  cubeA: "00000000-0000-4000-8000-000000000002",
  cubeB: "00000000-0000-4000-8000-000000000003",
  roleA: "00000000-0000-4000-8000-000000000004",
  roleB: "00000000-0000-4000-8000-000000000005",
  droneA: "00000000-0000-4000-8000-000000000006",
  droneB: "00000000-0000-4000-8000-000000000007",
  sessionA: "00000000-0000-4000-8000-000000000008",
  sessionB: "00000000-0000-4000-8000-000000000009",
} as const;

let runtime: StoreRuntime | undefined;
let directory: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  runtime?.close();
  runtime = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("dashboard snapshot source", () => {
  it("returns bounded aggregate activity and liveness without message bodies", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-source-")));
    let now = new Date("2026-07-25T11:40:00.000Z");
    runtime = await openStore({
      path: join(directory, "borg.db"),
      clock: () => now,
    });
    seedDashboard(runtime);
    const droneA = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.client,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    }));
    const droneB = runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionB,
      clientId: ids.client,
      cubeId: ids.cubeB,
      droneId: ids.droneB,
    }));
    droneA.appendLog(ids.cubeA, { message: "outside-window-secret-body" });
    now = new Date("2026-07-25T11:51:00.000Z");
    droneA.appendLog(ids.cubeA, { message: "inside-window-secret-body-a" });
    now = new Date("2026-07-25T11:56:00.000Z");
    droneB.appendLog(ids.cubeB, { message: "inside-window-secret-body-b" });
    now = new Date("2026-07-25T12:00:00.000Z");

    expect(runtime.dashboard.read()).toEqual({
      captured_at: "2026-07-25T12:00:00.000Z",
      cubes: [
        {
          id: ids.cubeA,
          name: "Alpha",
          posts_15m: 1,
          distinct_posting_drones_15m: 1,
          drones_total: 1,
          drones_seen_15m: 1,
          last_post_at: "2026-07-25T11:51:00.000Z",
        },
        {
          id: ids.cubeB,
          name: "Beta",
          posts_15m: 1,
          distinct_posting_drones_15m: 1,
          drones_total: 1,
          drones_seen_15m: 1,
          last_post_at: "2026-07-25T11:56:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(runtime.dashboard.read())).not.toContain("secret-body");
  });

  it("notifies one server-wide subscriber after a committed post", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-events-")));
    runtime = await openStore({
      path: join(directory, "borg.db"),
      clock: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    seedDashboard(runtime);
    const listener = vi.fn();
    const unsubscribe = runtime.dashboard.subscribe(listener);
    runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.client,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    })).appendLog(ids.cubeA, { message: "committed" });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.client,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    })).appendLog(ids.cubeA, { message: "after unsubscribe" });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("dashboard renderer", () => {
  it("renders one deterministic focus-plus-summary frame and adds a strip only on overflow", () => {
    const renderer = createDashboardRenderer({ glyphMode: "box", color: false });
    const eight = rankDashboardSnapshot(snapshotData(8), server);
    const frame = renderer(eight, 80, 24);
    expect(frame).toContain("██ BORGMCP-SERVER ██");
    expect(frame).toContain("CUBE DETAIL");
    expect(frame).toContain("cube-01");
    expect(frame).toContain("activity = coordination log entries");
    expect(frame).not.toContain("ALL 8");
    expect(renderer(eight, 80, 24)).toBe(frame);

    const crowded = renderer(rankDashboardSnapshot(snapshotData(47), server), 80, 24);
    expect(crowded).toContain("ALL 47");
    expect(crowded.split("\n").length).toBeLessThanOrEqual(24);
  });

  it("uses one layout with a strict ASCII glyph map and an honest tiny fallback", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(3), server);
    const ascii = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      60,
      18,
    );
    expect(ascii).toContain("== BORGMCP-SERVER ==");
    expect(ascii).toContain("+");
    expect(ascii).not.toMatch(/[─│┌┐└┘█▢▤▥▣…]/u);
    for (const line of ascii.split("\n")) expect([...line]).toHaveLength(60);
    expect(ascii.split("\n").map((line) => line.trimEnd()).join("\n")).toMatchInlineSnapshot(`
      "== BORGMCP-SERVER == ONLINE  3 cubes  6/15m  https://127....
      ------------------------------------------------------------
      + CUBE DETAIL ---------------------------------------------+
      |  +------+  cube-01 #1                                    |
      | /#=+.#/| 3 posts/15m  3 posting drones                   |
      |+------+ |4/5 drones seen/15m                             |
      ||+=#.+=|/ last post 1m                                    |
      |+------+  activity = coordination log entries             |
      +----------------------------------------------------------+
      ------------------------------------------------------------
      +   1 cube-01      4/5   seen    3/15m   3 posters     1m
      =   2 cube-02      3/5   seen    2/15m   2 posters     2m
      =   3 cube-03      2/5   seen    1/15m   1 posters     3m
      ^C stop server  |  read-only"
    `);

    const tiny = createDashboardRenderer({ glyphMode: "box", color: true })(
      snapshot,
      39,
      9,
    );
    expect(tiny).toContain("borgmcp-server online");
    expect(tiny).not.toContain("\u001b[");
    expect(tiny).not.toContain("┌");
  });

  it("keeps the embedded footer by default and accepts a sanitized caller footer", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(1), server);
    const defaultFrame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      80,
      24,
    );
    expect(defaultFrame).toContain(EMBEDDED_DASHBOARD_FOOTER);

    const viewerFrame = createDashboardRenderer({
      glyphMode: "ascii",
      color: false,
      footer: "^C close viewer\u001b]0;unsafe\u0007  |  read-only" as DashboardFooter,
    })(snapshot, 80, 24);
    expect(viewerFrame).toContain(STANDALONE_DASHBOARD_FOOTER);
    expect(viewerFrame).not.toContain("stop server");
    expect(viewerFrame).not.toContain("\u001b");
    expect(viewerFrame).not.toContain("unsafe");
  });

  it("keeps representative terminal widths and a thousand-cube snapshot bounded", () => {
    const renderer = createDashboardRenderer({ glyphMode: "ascii", color: false });
    const snapshot = rankDashboardSnapshot(snapshotData(1_000), server);
    for (const columns of [60, 80, 120, 160]) {
      const frame = renderer(snapshot, columns, 24);
      const lines = frame.split("\n");
      expect(lines.length).toBeLessThanOrEqual(24);
      expect(lines.every((line) => [...line].length <= columns)).toBe(true);
      expect(frame).toContain("ALL 1000");
      expect(frame).toMatch(/\+\d+ more/u);
    }
  });

  it("marks rank movement for one snapshot without letting names enter rules", () => {
    const initial = rankDashboardSnapshot(snapshotData(3), server);
    const previous = new Map(initial.cubes.map((cube) => [cube.id, cube.rank]));
    const reorderedData = {
      ...snapshotData(3),
      cubes: snapshotData(3).cubes.map((cube, index) => ({
        ...cube,
        posts_15m: index === 2 ? 99 : cube.posts_15m,
      })),
    };
    const reordered = rankDashboardSnapshot(reorderedData, server, previous);
    expect(reordered.cubes[0]).toMatchObject({ name: "cube-03", rank_change: 2 });
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      reordered,
      80,
      24,
    );
    expect(frame).toContain("^2");
    expect(frame).not.toContain("+-- CUBE cube-03");
    const settledRanks = new Map(reordered.cubes.map((cube) => [cube.id, cube.rank]));
    expect(rankDashboardSnapshot(reorderedData, server, settledRanks).cubes
      .every((cube) => cube.rank_change === 0)).toBe(true);
  });

  it("breaks equal post-count ranks by distinct posting drones", () => {
    const data = snapshotData(2);
    const ranked = rankDashboardSnapshot({
      ...data,
      cubes: [
        { ...data.cubes[0]!, posts_15m: 5, distinct_posting_drones_15m: 1 },
        { ...data.cubes[1]!, posts_15m: 5, distinct_posting_drones_15m: 3 },
      ],
    }, server);
    expect(ranked.cubes.map((cube) => cube.name)).toEqual(["cube-02", "cube-01"]);
  });

  it("strips ANSI, OSC, newlines, and bidi controls from every server-derived field", () => {
    const maliciousServer: DashboardServerIdentity = {
      ...server,
      name: "borg\u001b]52;c;clipboard\u0007\nserver",
      version: "0.2.0\u001b[2J",
      endpoint: "https://safe.invalid/\u202Eevil",
    };
    const data = snapshotData(1);
    const snapshot = rankDashboardSnapshot({
      ...data,
      cubes: [{ ...data.cubes[0]!, name: "cube\u001b[31m-red\u001b[0m\nnext" }],
    }, maliciousServer);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      80,
      24,
    );
    expect(frame).not.toContain("\u001b");
    expect(frame).not.toContain("\u202E");
    expect(frame).not.toContain("clipboard");
    expect(frame).toContain("cube-red next");
    expect(sanitizeTerminalText("a\nb\u001b[2Jc")).toBe("a bc");
  });

  it("treats NO_COLOR and terminal/locale fallback as first-class variants", () => {
    expect(dashboardColorEnabled({ NO_COLOR: "" })).toBe(false);
    expect(dashboardColorEnabled({ TERM: "xterm-256color" })).toBe(true);
    expect(selectDashboardGlyphMode({
      asciiRequested: false,
      environment: { TERM: "dumb", LANG: "en_US.UTF-8" },
    })).toBe("ascii");
    expect(selectDashboardGlyphMode({
      asciiRequested: false,
      environment: { TERM: "xterm", LANG: "C" },
    })).toBe("ascii");
    expect(selectDashboardGlyphMode({
      asciiRequested: false,
      environment: { TERM: "xterm", LANG: "en_US.UTF-8" },
    })).toBe("box");
    expect(selectDashboardGlyphMode({
      asciiRequested: true,
      environment: { TERM: "xterm", LANG: "en_US.UTF-8" },
    })).toBe("ascii");
  });
});

describe("foreground dashboard lifecycle", () => {
  it("enters once, coalesces activity, reflows on resize, and restores once", async () => {
    vi.useFakeTimers();
    const harness = terminalHarness();
    const source = sourceHarness(snapshotData(2));
    const renderer = vi.fn(createDashboardRenderer({ glyphMode: "ascii", color: false }));
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer,
    });
    expect(harness.output[0]).toBe("\u001b[?1049h\u001b[?25l");
    expect(renderer).toHaveBeenCalledOnce();

    source.emit();
    source.emit();
    await vi.advanceTimersByTimeAsync(249);
    expect(renderer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(renderer).toHaveBeenCalledTimes(2);

    harness.setDimensions(120, 40);
    harness.resize();
    await vi.advanceTimersByTimeAsync(124);
    expect(renderer).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(renderer).toHaveBeenLastCalledWith(expect.anything(), 120, 40);

    dashboard.close();
    dashboard.close();
    expect(harness.output.filter(
      (value) => value === "\u001b[?25h\u001b[?1049l\u001b[?25h",
    ))
      .toHaveLength(1);
    expect(source.listenerCount()).toBe(0);
    expect(harness.resizeListenerCount()).toBe(0);
  });

  it("restores terminal state, emits bounded plain status, and rejects on render failure", async () => {
    vi.useFakeTimers();
    const harness = terminalHarness();
    const source = sourceHarness(snapshotData(1));
    let calls = 0;
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer: (snapshot, columns, rows) => {
        calls += 1;
        if (calls === 2) throw new Error("render failed");
        return createDashboardRenderer({ glyphMode: "ascii", color: false })(
          snapshot,
          columns,
          rows,
        );
      },
    });
    const rejected = expect(dashboard.failure).rejects.toThrow("render failed");
    source.emit();
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(harness.output).toContain("\u001b[?25h\u001b[?1049l\u001b[?25h");
    expect(harness.output.at(-1)).toContain("borgmcp-server online");
    expect(source.listenerCount()).toBe(0);
    expect(harness.resizeListenerCount()).toBe(0);
  });
});

function seedDashboard(store: StoreRuntime): void {
  store.maintenance.createClient({ id: ids.client, name: "Client" });
  for (const [cubeId, roleId, droneId, sessionId, name] of [
    [ids.cubeA, ids.roleA, ids.droneA, ids.sessionA, "Alpha"],
    [ids.cubeB, ids.roleB, ids.droneB, ids.sessionB, "Beta"],
  ] as const) {
    store.maintenance.createCube({ id: cubeId, name, directive: "Coordinate." });
    store.maintenance.grantClientCube({ clientId: ids.client, cubeId, access: "manage" });
    store.maintenance.createRole({ id: roleId, cubeId, name: "Builder" });
    store.maintenance.createDrone({
      id: droneId,
      cubeId,
      roleId,
      clientId: ids.client,
      label: `builder-${name.toLowerCase()}`,
    });
    store.maintenance.createDroneSession({
      id: sessionId,
      clientId: ids.client,
      cubeId,
      droneId,
    });
  }
}

function snapshotData(count: number): DashboardDataSnapshot {
  return {
    captured_at: "2026-07-25T12:00:00.000Z",
    cubes: Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `cube-${String(index + 1).padStart(2, "0")}`,
      posts_15m: Math.max(0, count - index),
      distinct_posting_drones_15m: Math.max(0, Math.min(4, count - index)),
      drones_total: 5,
      drones_seen_15m: Math.max(0, 4 - (index % 3)),
      last_post_at: index % 5 === 4
        ? null
        : new Date(Date.parse("2026-07-25T12:00:00.000Z") - ((index + 1) * 60_000))
            .toISOString(),
    })),
  };
}

function sourceHarness(initial: DashboardDataSnapshot): DashboardSnapshotSource & {
  readonly emit: () => void;
  readonly listenerCount: () => number;
} {
  const listeners = new Set<() => void>();
  return {
    read: () => initial,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function terminalHarness(): {
  readonly terminal: DashboardTerminal;
  readonly output: string[];
  readonly resize: () => void;
  readonly setDimensions: (columns: number, rows: number) => void;
  readonly resizeListenerCount: () => number;
} {
  const output: string[] = [];
  const listeners = new Set<() => void>();
  let dimensions = { columns: 80, rows: 24 };
  return {
    terminal: {
      write: (value) => { output.push(value); },
      dimensions: () => dimensions,
      onResize: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    output,
    resize: () => {
      for (const listener of listeners) listener();
    },
    setDimensions: (columns, rows) => { dimensions = { columns, rows }; },
    resizeListenerCount: () => listeners.size,
  };
}
