import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";

import {
  createDashboardRenderer as createRenderer,
  dashboardColorEnabled,
  EMBEDDED_DASHBOARD_FOOTER,
  EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER,
  rankDashboardSnapshot,
  renderPlainDashboard,
  sanitizeTerminalText,
  selectDashboardGlyphMode,
  STANDALONE_DASHBOARD_FOOTER,
  startForegroundDashboard,
  type DashboardDataSnapshot,
  type DashboardFooter,
  type DashboardRenderOptions,
  type DashboardRenderer,
  type DashboardServerIdentity,
  type DashboardSnapshotSource,
  type DashboardTerminal,
} from "../src/dashboard.js";
import { droneSessionPrincipal } from "../src/principal.js";
import { openStore, type StoreRuntime } from "../src/store.js";

function createDashboardRenderer(
  options: Omit<DashboardRenderOptions, "footer">,
): DashboardRenderer {
  return createRenderer({ ...options, footer: EMBEDDED_DASHBOARD_FOOTER });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

const server: DashboardServerIdentity = Object.freeze({
  name: "borgmcp-server",
  version: "0.14.1",
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
          drones: [{ id: ids.droneA, label: "builder-alpha", role: "Builder", last_seen: "2026-07-25T11:51:00.000Z", sent: 1, sent_5s: 0, received: 0 }],
        },
        {
          id: ids.cubeB,
          name: "Beta",
          posts_15m: 1,
          distinct_posting_drones_15m: 1,
          drones_total: 1,
          drones_seen_15m: 1,
          last_post_at: "2026-07-25T11:56:00.000Z",
          drones: [{ id: ids.droneB, label: "builder-beta", role: "Builder", last_seen: "2026-07-25T11:56:00.000Z", sent: 1, sent_5s: 0, received: 0 }],
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
    expect(frame).toContain("DRONE ACTIVITY");
    expect(frame).toContain("cube-01");
    expect(frame).toContain("collecting");
    expect(frame).toContain("up 3h");
    expect(frame).not.toContain("CUBE DETAIL");
    expect(renderer(eight, 80, 24)).toBe(frame);

    const crowded = renderer(rankDashboardSnapshot(snapshotData(47), server), 80, 24);
    expect(crowded).toContain("page 1/");
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
    expect(ascii).toContain("DRONE ACTIVITY");
    expect(ascii).toContain("collecting -");

    const tiny = createDashboardRenderer({ glyphMode: "box", color: true })(
      snapshot,
      39,
      9,
    );
    expect(tiny).toContain("borgmcp-server online");
    expect(tiny).toContain("Ctrl-C or close terminal stops server.");
    expect(tiny).toContain("Data saved. Read-only view.");
    expect(tiny).not.toContain("\u001b[");
    expect(tiny).not.toContain("┌");
    expect(tiny.split("\n")).toHaveLength(7);
    expect(tiny.split("\n").every((line) => [...line].length <= 39)).toBe(true);

    const narrow = createDashboardRenderer({ glyphMode: "box", color: true })(snapshot, 20, 9);
    expect(narrow).toContain("Saved. Read-only.");
    expect(narrow.split("\n").every((line) => [...line].length <= 20)).toBe(true);
    for (let width = 20; width <= 60; width += 1) {
      const rendered = createDashboardRenderer({ glyphMode: "box", color: true })(snapshot, width, 9);
      expect(rendered.split("\n").every((line) => [...line].length <= width)).toBe(true);
    }

    const tinyViewer = createRenderer({
      glyphMode: "box",
      color: true,
      footer: STANDALONE_DASHBOARD_FOOTER,
    })(snapshot, 39, 9);
    expect(tinyViewer).toContain("Ctrl-C closes this viewer.");
    expect(tinyViewer).toContain("Server stays up. View is read-only.");
    expect(tinyViewer).not.toContain("stops this server");
    expect(tinyViewer.split("\n")).toHaveLength(7);
    expect(tinyViewer.split("\n").every((line) => [...line].length <= 39)).toBe(true);

    const oneShotViewer = renderPlainDashboard(snapshot, 39, 9);
    expect(oneShotViewer).toContain("borgmcp-server online");
    expect(oneShotViewer).not.toContain("Ctrl-C");
    expect(oneShotViewer).not.toContain("read-only");
  });

  it("keeps the plain fallback boundary at exactly 40 columns by 10 rows", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(1), server);
    const renderer = createDashboardRenderer({ glyphMode: "ascii", color: false });
    for (const [columns, rows] of [[39, 24], [100, 8], [20, 4]] as const) {
      const frame = renderer(snapshot, columns, rows);
      expect(frame).not.toContain("DRONE ACTIVITY");
    }

    const inkFrame = renderer(snapshot, 40, 10);
    expect(inkFrame).toContain("-".repeat(40));
    expect(inkFrame.split("\n").every((line) => stringWidth(line) === 40)).toBe(true);
    expect(inkFrame.split("\n")).toHaveLength(10);
  });

  it("keeps the live foreground fallback outside Ink while crossing the boundary", async () => {
    const harness = terminalHarness();
    harness.setDimensions(39, 24);
    const source = sourceHarness(snapshotData(1));
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer: createDashboardRenderer({ glyphMode: "ascii", color: false }),
    });

    expect(harness.output.at(-1)).toContain("borgmcp-server online");
    expect(harness.output.join("")).not.toContain("DRONE ACTIVITY");

    harness.setDimensions(40, 10);
    const beforeInk = harness.output.length;
    harness.resize();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const transition = harness.output.slice(beforeInk).join("");
    const clearIndex = transition.indexOf("\u001b[2J\u001b[H");
    const inkIndex = transition.indexOf("\u001b[?2026h");
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(inkIndex).toBeGreaterThan(clearIndex);

    harness.setDimensions(39, 24);
    harness.resize();
    expect(harness.output.at(-1)).toContain("borgmcp-server online");
    expect(harness.output.at(-1)).not.toContain("DRONE ACTIVITY");
    dashboard.close();
  });

  it("replaces isometric art with a flat bounded activity panel", () => {
    const frame = createDashboardRenderer({ glyphMode: "box", color: false })(
      rankDashboardSnapshot(snapshotData(1), server),
      80,
      24,
    );
    const detail = frame.split("\n").slice(2, -3);
    expect(detail[0]).toContain("DRONE ACTIVITY");
    expect(detail.every((line) => [...line].length === 80)).toBe(true);
    expect(frame).not.toContain("/......");
  });

  it("keeps pulse phases out of the flat activity panel", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(1), server);
    const pulseCubeIds = new Set([snapshot.cubes[0]!.id]);
    for (const glyphMode of ["ascii", "box"] as const) {
      const renderer = createDashboardRenderer({ glyphMode, color: false });
      for (let pulsePhase = 0; pulsePhase <= 4; pulsePhase += 1) {
        const frame = renderer(snapshot, 80, 24, {
          autoFollow: true,
          focusedCubeId: null,
          pulseCubeIds,
          pulsePhase,
        });
        expect(frame).toContain("DRONE ACTIVITY");
        expect(frame).not.toContain("/......");
      }
    }
  });

  it("uses a distinct fixed-width activity marker in cube list rows", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(3), server);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      80,
      12,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set([snapshot.cubes[1]!.id]),
        pulsePhase: 4,
      },
    );
    expect(frame.split("\n").find((line) => line.includes("cube-02"))).toContain("O");
  });

  it("keeps the explicit embedded footer and accepts a sanitized caller footer", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(1), server);
    const defaultFrame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      80,
      24,
    );
    expect(defaultFrame).toContain(EMBEDDED_DASHBOARD_FOOTER);
    for (const sentence of EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER.split(". ")) {
      expect(defaultFrame).toContain(sentence);
    }

    const viewerFrame = createRenderer({
      glyphMode: "ascii",
      color: false,
      footer: "^C close viewer\u001b]0;unsafe\u0007  |  read-only" as DashboardFooter,
    })(snapshot, 80, 24);
    expect(viewerFrame).toContain(STANDALONE_DASHBOARD_FOOTER);
    expect(viewerFrame).not.toContain("stop server");
    expect(viewerFrame).not.toContain("\u001b");
    expect(viewerFrame).not.toContain("unsafe");

    const interactiveFrame = createDashboardRenderer({
      glyphMode: "ascii",
      color: false,
      navigation: true,
    })(rankDashboardSnapshot(snapshotData(2), server), 80, 24);
    expect(interactiveFrame).toContain("< > switch  |  a auto");
  });

  it("renders explicit modes, useful navigation, and singular dashboard labels", () => {
    const renderer = createDashboardRenderer({
      glyphMode: "ascii",
      color: false,
      navigation: true,
    });
    const oneCube = rankDashboardSnapshot(snapshotData(1), server);
    const auto = renderer(oneCube, 80, 24);
    const pinned = renderer(oneCube, 80, 24, {
      autoFollow: false,
      focusedCubeId: oneCube.cubes[0]!.id,
      pulseCubeIds: new Set(),
      pulsePhase: 0,
    });
    const empty = renderer(rankDashboardSnapshot(snapshotData(0), server), 80, 24);

    expect(auto).toContain("1 cube");
    expect(auto).toContain("DRONE ACTIVITY");
    expect(auto).toContain("1 poster");
    expect(auto).toContain("collecting");
    expect(auto).not.toContain("< > switch");
    expect(pinned).toContain("DRONE ACTIVITY");
    expect(empty).not.toContain("< > switch");
  });

  it("keeps volume, pulse, and rank in separate global channels", () => {
    const data = snapshotData(2);
    const ranked = rankDashboardSnapshot({
      ...data,
      cubes: [
        { ...data.cubes[0]!, name: "quiet", posts_15m: 9 },
        { ...data.cubes[1]!, name: "busy", posts_15m: 47 },
      ],
    }, server, new Map([
      [data.cubes[0]!.id, 1],
      [data.cubes[1]!.id, 2],
    ]));
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      ranked,
      80,
      24,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set([ranked.cubes[0]!.id]),
        pulsePhase: 4,
      },
    );
    const quiet = frame.split("\n").find((line) => line.includes("quiet"))!;
    const busy = frame.split("\n").filter((line) => line.includes("busy")).at(-1)!;
    expect(quiet.startsWith("*"), quiet).toBe(true);
    expect(busy.startsWith("#"), busy).toBe(true);
    expect(busy).toContain("O");
    expect(busy).toContain("^1");
  });

  it("normalizes activity graphs per focused cube rather than per drone", () => {
    const data = snapshotData(1);
    const original = data.cubes[0]!;
    const quiet = original.drones[0]!;
    const busy = { ...quiet, id: "10000000-0000-4000-8000-000000000099", label: "busy" };
    const snapshot = rankDashboardSnapshot({
      ...data,
      cubes: [{ ...original, drones: [quiet, busy], drones_total: 2 }],
    }, server);
    const timestamp = snapshot.captured_at;
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      100,
      24,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        activity: new Map([
          [`${snapshot.cubes[0]!.id}:${quiet.id}`, [{ capturedAt: timestamp, sentRate: 1 }]],
          [`${snapshot.cubes[0]!.id}:${busy.id}`, [{ capturedAt: timestamp, sentRate: 10 }]],
        ]),
        observation: [{ capturedAt: timestamp, sentRate: 1 }],
      },
    );
    const lines = frame.split("\n");
    const quietIndex = lines.findIndex((line) => line.includes("builder-01"));
    const busyIndex = lines.findIndex((line) => line.includes("busy"));
    const quietGraph = lines[quietIndex + 2]!;
    const busyGraph = lines[busyIndex + 2]!;
    expect(quietGraph).toContain(":");
    expect(quietGraph).not.toContain("#");
    expect(busyGraph).toContain("#");
  });

  it("uses liveness color on the whole row and stays semantic in mono", () => {
    const data = snapshotData(1);
    const cube = data.cubes[0]!;
    const capturedAt = Date.parse(data.captured_at);
    const age = (minutes: number) => new Date(capturedAt - minutes * 60_000).toISOString();
    const drones = [
      { ...cube.drones[0]!, id: "live", label: "live", last_seen: age(0.5) },
      { ...cube.drones[0]!, id: "recent", label: "recent", last_seen: age(10) },
      { ...cube.drones[0]!, id: "idle", label: "idle", last_seen: age(30) },
      { ...cube.drones[0]!, id: "stale", label: "stale", last_seen: age(120) },
    ];
    const snapshot = rankDashboardSnapshot({
      ...data,
      cubes: [{ ...cube, drones, drones_total: drones.length }],
    }, server);
    const render = (color: boolean) => createDashboardRenderer({ glyphMode: "ascii", color })(snapshot, 100, 36);
    const colorFrame = render(true);
    const lines = colorFrame.split("\n");
    expect(lines.find((line) => line.includes("live"))).toContain("\u001b[32;1m");
    expect(lines.find((line) => line.includes("recent"))).toContain("\u001b[33m");
    expect(lines.find((line) => line.includes("idle"))).not.toContain("\u001b[");
    expect(lines.find((line) => line.includes("stale"))).toContain("\u001b[2m");
    expect(stripAnsi(colorFrame).match(/[^\u0000-\u007F]/gu)).toEqual(null);
    expect(render(false)).not.toContain("\u001b[");
  });

  it("keeps the read-only footer intact when optional controls do not fit", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(2), server);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false, navigation: true })(
      snapshot,
      48,
      16,
    );
    const footer = frame.split("\n").at(-1)!;
    expect(footer).toContain("^C");
    expect(footer).toContain("read-only");
    expect(footer).not.toContain("...");
  });

  it("keeps representative terminal widths and a thousand-cube snapshot bounded", () => {
    const renderer = createDashboardRenderer({ glyphMode: "ascii", color: false });
    const snapshot = rankDashboardSnapshot(snapshotData(1_000), server);
    for (const columns of [60, 80, 120, 160]) {
      const frame = renderer(snapshot, columns, 24);
      const lines = frame.split("\n");
      expect(lines.length).toBeLessThanOrEqual(24);
      expect(lines.every((line) => [...line].length <= columns)).toBe(true);
      expect(frame).toContain("page 1/");
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
      version: "0.14.1\u001b[2J",
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

  it("renders sanitized wide drone labels with sent, received, last-active, and right-edge activity", () => {
    const data = snapshotData(1);
    const cube = data.cubes[0]!;
    const snapshot = rankDashboardSnapshot({
      ...data,
      cubes: [{ ...cube, drones: [{
        ...cube.drones[0]!,
        label: "\u001b]52;c;clipboard\u0007東京🚀\u001b[31m-red",
        role: "Builder\nrole",
        sent: 12,
        received: 8,
      }] }],
    }, server);
    const key = `${cube.id}:${cube.drones[0]!.id}`;
    const frame = createDashboardRenderer({ glyphMode: "box", color: false })(snapshot, 100, 16, {
      autoFollow: true,
      focusedCubeId: null,
      pulseCubeIds: new Set(),
      pulsePhase: 0,
      activity: new Map([[key, [
        { capturedAt: "2026-07-25T11:59:50.000Z", sentRate: 1 },
        { capturedAt: "2026-07-25T12:00:00.000Z", sentRate: 4 },
      ]]]),
      activityWindowMs: 15 * 60_000,
    });
    expect(frame).toContain("東京🚀-red");
    expect(frame).toContain("SENT 12  RECV 8");
    expect(frame).toContain("LAST 1m");
    expect(frame).toContain("██");
    expect(frame).not.toContain("\u001b");
    expect(frame).not.toContain("clipboard");
    expect(frame.split("\n").every((line) => stringWidth(line) <= 100)).toBe(true);
  });

  it("leaves empty launch activity blank while reporting zero observed coverage", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(1), server);
    const drone = snapshot.cubes[0]!.drones[0]!;
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      100,
      16,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        activity: new Map(),
        observation: [],
        activityWindowMs: 15 * 60_000,
      },
    );
    expect(frame).toContain("collecting - 0% of 15m observed");
    const lines = frame.split("\n");
    const identity = lines.findIndex((line) => line.includes(drone.label));
    expect(lines[identity + 1]!.slice(1, -1)).toMatch(/^\s+$/u);
    expect(lines[identity + 2]!.slice(1, -1)).toMatch(/^\s+$/u);
  });

  it("keeps poll buckets in their timestamp positions across the four coverage compositions", () => {
    const data = snapshotData(1);
    const snapshot = rankDashboardSnapshot(data, server);
    const cube = snapshot.cubes[0]!;
    const drone = cube.drones[0]!;
    const key = `${cube.id}:${drone.id}`;
    const end = Date.parse(snapshot.captured_at);
    const start = end - (15 * 60_000);
    const renderer = createDashboardRenderer({ glyphMode: "ascii", color: false });
    const sample = (timestamp: number, sentRate = 1) => ({
      capturedAt: new Date(timestamp).toISOString(),
      sentRate,
    });
    const graphFor = (samples: readonly { capturedAt: string; sentRate: number }[]) => {
      const frame = renderer(snapshot, 100, 16, {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        activity: new Map([[key, samples]]),
        observation: samples,
        activityWindowMs: 15 * 60_000,
      });
      const lines = frame.split("\n");
      const identity = lines.findIndex((line) => line.includes(drone.label));
      return { frame, graph: lines[identity + 2]!.slice(1, -1) };
    };

    const clustered = [
      ...Array.from({ length: 90 }, (_, index) => sample(start + (index * 100), 1)),
      ...Array.from({ length: 90 }, (_, index) => sample(end - 9_000 + (index * 100), 4)),
    ];
    const clusteredFrame = graphFor(clustered);
    expect(clusteredFrame.frame).toContain("collecting");
    expect(clusteredFrame.graph).toMatch(/[.:+*#]\s{40,}[.:+*#]/u);

    const uniformMinute = Array.from(
      { length: 180 },
      (_, index) => sample(end - 60_000 + Math.floor(index * 60_000 / 180), 1 + (index % 4)),
    );
    const uniformGraph = graphFor(uniformMinute).graph;
    expect(uniformGraph.search(/[.:+*#]/u)).toBeGreaterThan(85);

    const endpoints = graphFor([sample(start, 1), sample(end, 4)]).graph;
    expect(endpoints[0]).toMatch(/[.:+*#]/u);
    expect(endpoints.at(-1)).toMatch(/[.:+*#]/u);
    expect(endpoints.slice(1, -1)).toMatch(/^\s+$/u);

    const full = Array.from(
      { length: 180 },
      (_, index) => sample(start + (index * 5_000), 1 + (index % 4)),
    );
    expect(graphFor(full).frame).not.toContain("collecting");
  });

  it("uses the global observation timeline instead of reducing per-drone histories", () => {
    const data = snapshotData(1);
    const original = data.cubes[0]!;
    const joined = {
      ...original.drones[0]!,
      id: "20000000-0000-4000-8000-000000000002",
      label: "late-joiner",
    };
    const snapshot = rankDashboardSnapshot({
      ...data,
      cubes: [{ ...original, drones: [original.drones[0]!, joined] }],
    }, server);
    const cube = snapshot.cubes[0]!;
    const end = Date.parse(snapshot.captured_at);
    const start = end - (15 * 60_000);
    const sample = (timestamp: number) => ({
      capturedAt: new Date(timestamp).toISOString(),
      sentRate: 1,
    });
    const full = Array.from({ length: 180 }, (_, index) => sample(start + (index * 5_000)));
    const late = Array.from({ length: 24 }, (_, index) => sample(end - (120_000 - (index * 5_000))));
    const sparse = Array.from({ length: 18 }, (_, index) =>
      sample(start + Math.floor(index * (15 * 60_000) / 18)));
    const tenDrones = Array.from({ length: 10 }, (_, index) => ({
      ...original.drones[0]!,
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      label: `drone-${index + 1}`,
    }));
    const sparseSnapshot = rankDashboardSnapshot({
      ...data,
      cubes: [{ ...original, drones: tenDrones }],
    }, server);
    const sparseCube = sparseSnapshot.cubes[0]!;
    const sparseFrame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      sparseSnapshot,
      120,
      36,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        activity: new Map(tenDrones.map((drone) => [
          `${sparseCube.id}:${drone.id}`,
          sparse,
        ])),
        observation: sparse,
        activityWindowMs: 15 * 60_000,
      },
    );
    expect(sparseFrame).toContain("collecting");

    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      120,
      36,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        activity: new Map([
          [`${cube.id}:${cube.drones[0]!.id}`, full],
          [`${cube.id}:${joined.id}`, late],
        ]),
        observation: full,
        activityWindowMs: 15 * 60_000,
      },
    );
    expect(frame).not.toContain("collecting");
    const lines = frame.split("\n");
    const lateLine = lines.findIndex((line) => line.includes("late-joiner"));
    expect(lines[lateLine + 1]!.slice(1, -1)).toMatch(/^\s{70,}[.:+*#]+$/u);
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
  it("collapses event refreshes into one poll bucket at record time", async () => {
    vi.useFakeTimers();
    const harness = terminalHarness();
    const initial = snapshotData(1);
    const source = sourceHarness(initial);
    const renderer = vi.fn(createDashboardRenderer({ glyphMode: "ascii", color: false }));
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer,
    });
    const cube = initial.cubes[0]!;
    const drone = cube.drones[0]!;

    for (let index = 1; index <= 5; index += 1) {
      source.set({
        ...initial,
        captured_at: new Date(Date.parse(initial.captured_at) + (index * 500)).toISOString(),
        cubes: [{
          ...cube,
          drones: [{ ...drone, sent: 6 - index, sent_5s: index }],
        }],
      });
      source.emit();
      await vi.advanceTimersByTimeAsync(250);
    }

    const view = renderer.mock.lastCall?.[3];
    expect(view?.observation).toHaveLength(1);
    const samples = view?.activity?.get(`${cube.id}:${drone.id}`);
    expect(samples).toHaveLength(1);
    expect(samples?.[0]).toMatchObject({
      capturedAt: "2026-07-25T12:00:02.500Z",
      sentRate: 5,
    });
    dashboard.close();
  });

  it("pulses when a newer post replaces an expired post at the same rolling count", async () => {
    vi.useFakeTimers();
    const harness = terminalHarness();
    const initial = snapshotData(1);
    const source = sourceHarness(initial);
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer: createDashboardRenderer({ glyphMode: "ascii", color: false }),
      pulseFrameMs: 100,
    });

    source.set({
      ...initial,
      captured_at: "2026-07-25T12:01:00.000Z",
      cubes: initial.cubes.map((cube) => ({
        ...cube,
        last_post_at: "2026-07-25T12:00:30.000Z",
      })),
    });
    source.emit();
    await vi.advanceTimersByTimeAsync(250);

    expect(source.readCount()).toBe(2);
    expect(harness.output.at(-1)).toContain("DRONE ACTIVITY");
    dashboard.close();
  });

  it("renders a visible pulse for activity on a non-focused rank-2 cube", async () => {
    vi.useFakeTimers();
    const harness = terminalHarness();
    const initial = snapshotData(2);
    const source = sourceHarness(initial);
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer: createDashboardRenderer({ glyphMode: "ascii", color: false }),
      pulseFrameMs: 100,
    });
    const before = harness.output.at(-1)!;

    source.set({
      ...initial,
      cubes: initial.cubes.map((cube, index) => index === 1
        ? {
            ...cube,
            posts_15m: cube.posts_15m + 1,
            last_post_at: "2026-07-25T12:00:30.000Z",
          }
        : cube),
    });
    source.emit();
    await vi.advanceTimersByTimeAsync(250);

    const pulse = harness.output.at(-1)!;
    expect(pulse).not.toBe(before);
    expect(pulse).toContain("DRONE ACTIVITY");
    expect(pulse.split("\n").find((line) => line.includes("cube-02"))).toMatch(
      /^[.:+*#]\s+2 .*O\s*$/u,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.output.at(-1)!.split("\n").find((line) => line.includes("cube-02"))).toMatch(
      /^[.:+*#]\s+2 .*o\s*$/u,
    );
    dashboard.close();
  });

  it("pulses on snapshot deltas and supports pinned navigation with explicit auto return", async () => {
    vi.useFakeTimers();
    const harness = terminalHarness();
    harness.setDimensions(80, 12);
    const source = sourceHarness(snapshotData(3));
    const renderer = vi.fn(createDashboardRenderer({
      glyphMode: "ascii",
      color: false,
      navigation: true,
    }));
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer,
      pulseFrameMs: 100,
    });

    expect(harness.output.at(-1)).toContain("cube-01 . (auto) . DRONE ACTIVITY");
    harness.input(">");
    expect(harness.output.at(-1)).toContain("cube-02 . (pinned) . DRONE ACTIVITY");
    harness.input("<");
    expect(harness.output.at(-1)).toContain("cube-01 . (pinned) . DRONE ACTIVITY");
    harness.input("a");
    expect(harness.output.at(-1)).toContain("cube-01 . (auto) . DRONE ACTIVITY");
    harness.input("<");
    expect(harness.output.at(-1)).toContain("cube-03 . (pinned) . DRONE ACTIVITY");
    harness.input("a");
    expect(harness.output.at(-1)).toContain("cube-01 . (auto) . DRONE ACTIVITY");

    harness.input("w");
    expect(harness.output.at(-1)).toContain("of 60m");
    harness.input("w");
    expect(harness.output.at(-1)).toContain("of 5m");
    harness.input(" ");
    expect(harness.output.at(-1)).toContain("SPACE 2/2");
    harness.input(" ");

    const changed = snapshotData(3);
    source.set({
      ...changed,
      cubes: changed.cubes.map((cube, index) => ({
        ...cube,
        posts_15m: index === 0 ? cube.posts_15m + 1 : cube.posts_15m,
      })),
    });
    source.emit();
    await vi.advanceTimersByTimeAsync(250);
    expect(source.readCount()).toBe(2);
    const pulseStart = harness.output.at(-1);
    expect(pulseStart).toContain("DRONE ACTIVITY");
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.output.at(-1)).not.toBe(pulseStart);
    expect(source.readCount()).toBe(2);

    harness.input("\u0003");
    expect(harness.interruptCount()).toBe(1);
    harness.input("\u001a");
    expect(harness.suspendCount()).toBe(1);
    expect(harness.inputListenerCount()).toBe(1);
    dashboard.close();
    expect(harness.inputListenerCount()).toBe(0);
  });

  it("skips writes for pulse ticks whose composed frame is unchanged", async () => {
    vi.useFakeTimers();
    const harness = terminalHarness();
    const initial = snapshotData(1_000);
    const source = sourceHarness(initial);
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer: createDashboardRenderer({ glyphMode: "ascii", color: false }),
      pulseFrameMs: 100,
    });
    const lastCube = initial.cubes.at(-1)!;
    const writesBeforeHiddenPulse = harness.output.length;

    source.set({
      ...initial,
      cubes: initial.cubes.map((cube) => cube.id === lastCube.id
        ? { ...cube, last_post_at: "2026-07-25T12:00:30.000Z" }
        : cube),
    });
    source.emit();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(100);

    expect(source.readCount()).toBe(2);
    expect(harness.output).toHaveLength(writesBeforeHiddenPulse);
    dashboard.close();
  });

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
    expect(renderer).toHaveBeenLastCalledWith(
      expect.anything(),
      120,
      40,
      expect.objectContaining({ autoFollow: true }),
    );

    dashboard.close();
    dashboard.close();
    expect(harness.output.filter(
      (value) => value === "\u001b[?25h\u001b[?1049l\u001b[?25h",
    ))
      .toHaveLength(1);
    expect(source.listenerCount()).toBe(0);
    expect(harness.resizeListenerCount()).toBe(0);
  });

  it("remounts the Ink dashboard after suspend and resume", async () => {
    const harness = terminalHarness();
    const source = sourceHarness(snapshotData(1));
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer: createDashboardRenderer({ glyphMode: "ascii", color: false }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeResume = harness.output.length;

    harness.input("\u001a");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.output.slice(beforeResume).join("")).toContain("DRONE ACTIVITY");
    dashboard.close();
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
      drones: [{
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        label: `builder-${String(index + 1).padStart(2, "0")}`,
        role: "Builder",
        last_seen: new Date(Date.parse("2026-07-25T12:00:00.000Z") - ((index + 1) * 60_000)).toISOString(),
        sent: index + 1,
        sent_5s: index + 1,
        received: index + 1,
      }],
    })),
  };
}

function sourceHarness(initial: DashboardDataSnapshot): DashboardSnapshotSource & {
  readonly emit: () => void;
  readonly listenerCount: () => number;
  readonly readCount: () => number;
  readonly set: (snapshot: DashboardDataSnapshot) => void;
} {
  const listeners = new Set<() => void>();
  let snapshot = initial;
  let reads = 0;
  return {
    read: () => {
      reads += 1;
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
    readCount: () => reads,
    set: (value) => { snapshot = value; },
  };
}

function terminalHarness(): {
  readonly terminal: DashboardTerminal;
  readonly output: string[];
  readonly resize: () => void;
  readonly input: (value: string) => void;
  readonly setDimensions: (columns: number, rows: number) => void;
  readonly inputListenerCount: () => number;
  readonly interruptCount: () => number;
  readonly suspendCount: () => number;
  readonly resizeListenerCount: () => number;
} {
  const output: string[] = [];
  const resizeListeners = new Set<() => void>();
  const inputListeners = new Set<(value: Uint8Array) => void>();
  let dimensions = { columns: 80, rows: 24 };
  let interrupts = 0;
  let suspends = 0;
  return {
    terminal: {
      write: (value) => { output.push(value); },
      dimensions: () => dimensions,
      onResize: (listener) => {
        resizeListeners.add(listener);
        return () => resizeListeners.delete(listener);
      },
      onInput: (listener) => {
        inputListeners.add(listener);
        return () => inputListeners.delete(listener);
      },
      requestInterrupt: () => { interrupts += 1; },
      requestSuspend: (resume) => {
        suspends += 1;
        resume();
      },
    },
    output,
    resize: () => {
      for (const listener of resizeListeners) listener();
    },
    input: (value) => {
      for (const listener of [...inputListeners]) listener(Buffer.from(value));
    },
    setDimensions: (columns, rows) => { dimensions = { columns, rows }; },
    inputListenerCount: () => inputListeners.size,
    interruptCount: () => interrupts,
    suspendCount: () => suspends,
    resizeListenerCount: () => resizeListeners.size,
  };
}
