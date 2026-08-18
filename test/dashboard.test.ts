import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";

import {
  createDashboardRenderer as createRenderer,
  dashboardColorDepth,
  dashboardColorEnabled,
  EMBEDDED_DASHBOARD_FOOTER,
  EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER,
  rankDashboardSnapshot,
  renderPlainDashboard,
  resolveDashboardMotionMode,
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
import { clientPrincipal, droneSessionPrincipal } from "../src/principal.js";
import { openStore, type StoreRuntime } from "../src/store.js";

function createDashboardRenderer(
  options: Omit<DashboardRenderOptions, "footer">,
): DashboardRenderer {
  return createRenderer({ ...options, footer: EMBEDDED_DASHBOARD_FOOTER });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function asciiScopeGraphRows(frame: string): string[] {
  const lines = frame.split("\n");
  const title = lines.findIndex((line) => line.includes("SENSOR SCOPE"));
  const divider = lines[title]!.indexOf("+", 1);
  const graph: string[] = [];
  for (const line of lines.slice(title + 1)) {
    const scope = line.slice(0, divider + 1);
    if (scope.startsWith("+")) break;
    if (!scope.startsWith("|") || scope.includes("15m")) continue;
    const content = scope.slice(1, -1);
    if (/^[ .]+$/u.test(content)) continue;
    graph.push(content);
  }
  return graph;
}

function boardSegment(line: string): string {
  const dividers = [...line.matchAll(/\|/gu)].map((match) => match.index);
  return dividers.length >= 3 ? line.slice(dividers[1]! + 1, dividers[2]) : line;
}

const server: DashboardServerIdentity = Object.freeze({
  name: "borgmcp-server",
  version: "2.1.0",
  endpoint: "https://127.0.0.1:7091",
  bind_mode: "loopback",
  state: "online",
  started_at: "2026-07-25T09:00:00.000Z",
} satisfies DashboardServerIdentity & {
  readonly bind_mode: "loopback" | "lan";
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
    droneA.appendLog(ids.cubeA, { visibility: "broadcast", message: "outside-window-secret-body" });
    now = new Date("2026-07-25T11:51:00.000Z");
    droneA.appendLog(ids.cubeA, { visibility: "broadcast", message: "inside-window-secret-body-a" });
    now = new Date("2026-07-25T11:56:00.000Z");
    droneB.appendLog(ids.cubeB, { visibility: "broadcast", message: "inside-window-secret-body-b" });
    now = new Date("2026-07-25T12:00:00.000Z");

    expect(runtime.dashboard.read()).toMatchObject({
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
          drones: [{ id: ids.droneA, label: "builder-alpha", role: "Builder", reported_model: "model-alpha", last_seen: "2026-07-25T11:51:00.000Z", sent: 1, sent_5s: 0, received: 0 }],
        },
        {
          id: ids.cubeB,
          name: "Beta",
          posts_15m: 1,
          distinct_posting_drones_15m: 1,
          drones_total: 1,
          drones_seen_15m: 1,
          last_post_at: "2026-07-25T11:56:00.000Z",
          drones: [{ id: ids.droneB, label: "builder-beta", role: "Builder", reported_model: "model-beta", last_seen: "2026-07-25T11:56:00.000Z", sent: 1, sent_5s: 0, received: 0 }],
        },
      ],
    });
    expect(runtime.dashboard.read().recent_activity.map((entry) => entry.message_head)).toEqual([
      "inside-window-secret-body-b",
      "inside-window-secret-body-a",
      "outside-window-secret-body",
    ]);
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
    })).appendLog(ids.cubeA, { visibility: "broadcast", message: "committed" });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.client,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    })).appendLog(ids.cubeA, { visibility: "broadcast", message: "after unsubscribe" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("notifies the embedded dashboard when a drone acknowledges an operator-authored entry", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-operator-ack-")));
    runtime = await openStore({
      path: join(directory, "borg.db"),
      clock: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    seedDashboard(runtime);
    const listener = vi.fn();
    const unsubscribe = runtime.dashboard.subscribe(listener);
    const entry = runtime.forPrincipal(clientPrincipal(ids.client)).appendLog(ids.cubeA, {
      visibility: "direct",
      recipientDroneIds: [ids.droneA],
      message: "operator-authored",
    });
    listener.mockClear();
    runtime.forPrincipal(droneSessionPrincipal({
      id: ids.sessionA,
      clientId: ids.client,
      cubeId: ids.cubeA,
      droneId: ids.droneA,
    })).acknowledge(ids.cubeA, entry.id, "ack");
    expect(listener).toHaveBeenCalledOnce();
    expect(runtime.dashboard.read().attention.unacked_directed).toBe(0);
    unsubscribe();
  });
});

describe("dashboard renderer", () => {
  it("renders one deterministic focus-plus-summary frame and adds a strip only on overflow", () => {
    const renderer = createDashboardRenderer({ glyphMode: "box", color: false });
    const eight = rankDashboardSnapshot(snapshotData(8), server);
    const frame = renderer(eight, 80, 24);
    expect(frame).toContain("██ BORGMCP-SERVER ██");
    expect(frame).toContain("SCOPE");
    expect(frame).toContain("cube-01");
    expect(frame).toContain("cov 0%");
    expect(frame).toContain("up 3h");
    expect(frame).not.toContain("CUBE DETAIL");
    expect(renderer(eight, 80, 24)).toBe(frame);
    const stackedLines = frame.split("\n");
    expect(stackedLines.findIndex((line) => line.includes("SENSOR SCOPE")))
      .toBeLessThan(stackedLines.findIndex((line) => line.includes("DRONES")));

    const stacked120 = createDashboardRenderer({ glyphMode: "ascii", color: false })(eight, 120, 40);
    expect(stacked120.split("\n").findIndex((line) => line.includes("SENSOR SCOPE")))
      .toBeLessThan(stacked120.split("\n").findIndex((line) => line.includes("DRONES")));
    const wide = createDashboardRenderer({ glyphMode: "ascii", color: false })(eight, 200, 50);
    const wideLines = wide.split("\n");
    const wideTitleIndex = wideLines.findIndex((line) => line.includes("SENSOR SCOPE"));
    const wideTitle = wideLines[wideTitleIndex]!;
    expect(wideTitle).toContain("DRONES");
    expect(wideTitle.match(/\+/gu)).toHaveLength(3);
    expect(wideTitle).not.toContain("++");
    const wideBottom = wideLines.slice(wideTitleIndex + 1).find((line) => line.startsWith("+"))!;
    expect(wideBottom.match(/\+/gu)).toHaveLength(3);
    expect(wideLines.slice(wideTitleIndex + 1, wideLines.indexOf(wideBottom))
      .every((line) => (line.match(/\|/gu) ?? []).length === 3)).toBe(true);
    expect(wideLines.some((line) =>
      line.includes("15m") && line.includes("10m") && line.includes("5m") && line.includes("now")))
      .toBe(true);
    const wideBox = renderer(eight, 200, 50).split("\n");
    const boxTitleIndex = wideBox.findIndex((line) => line.includes("SENSOR SCOPE"));
    expect(wideBox[boxTitleIndex]).toContain("┬");
    expect(wideBox[boxTitleIndex]).not.toContain("┐┌");
    expect(wideBox.slice(boxTitleIndex + 1).find((line) => line.startsWith("└"))).toContain("┴");

    const crowded = renderer(rankDashboardSnapshot(snapshotData(47), server), 80, 24);
    expect(crowded).toContain("page 1/");
    expect(crowded.split("\n").length).toBeLessThanOrEqual(24);
  });

  it("keeps graph, baseline, and intermediate axis ticks in the exact 80x24 stacked allocation", () => {
    const data = snapshotData(3);
    const focus = data.cubes[0]!;
    const drones = Array.from({ length: 11 }, (_unused, index) => ({
      ...focus.drones[0]!,
      id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      label: `drone-${index + 1}`,
    }));
    const recent = Array.from({ length: 3 }, (_unused, index) => ({
      id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      cube_name: focus.name,
      actor_kind: "drone-session" as const,
      actor_label: drones[index]!.label,
      actor_role: drones[index]!.role,
      created_at: new Date(Date.parse(data.captured_at) - (index * 60_000)).toISOString(),
      visibility: "broadcast" as const,
      recipient_count: 0,
      activity_class: null,
      message_head: `activity ${index + 1}`,
    }));
    const snapshot = rankDashboardSnapshot({
      ...data,
      recent_activity: recent,
      cubes: [{ ...focus, drones, drones_total: drones.length }, ...data.cubes.slice(1)],
    }, server);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false, motionMode: "off" })(
      snapshot,
      80,
      24,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        activity: new Map(drones.map((drone) => [
          `${focus.id}:${drone.id}`,
          [{ capturedAt: data.captured_at, sentRate: 1 }],
        ])),
        observation: [{ capturedAt: data.captured_at, sentRate: 0 }],
        activityWindowMs: 15 * 60_000,
        motionMode: "off",
      },
    );
    const lines = frame.split("\n");
    const scopeTitle = lines.findIndex((line) => line.includes("SENSOR SCOPE"));
    const boardTitle = lines.findIndex((line) => line.includes("DRONES 11"));
    const scope = lines.slice(scopeTitle + 1, boardTitle);
    const graph = scope.findIndex((line) => /^\|.*[.:+*#].*\|$/u.test(line));
    const baseline = scope.findIndex((line) => /\.\.\|$/u.test(line));
    const axis = scope.findIndex((line) =>
      line.includes("15m") && line.includes("10m") && line.includes("5m") && line.includes("now"));
    expect(graph).toBeGreaterThanOrEqual(0);
    expect(baseline).toBeGreaterThan(graph);
    expect(axis).toBeGreaterThan(baseline);
    expect(frame.match(/^FEED /gmu)).toHaveLength(1);
    expect(frame.match(/^\s{5}\d/gmu)).toHaveLength(2);
  });

  it("uses one layout with a strict ASCII glyph map and an honest tiny fallback", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(3), server);
    const ascii = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      64,
      18,
    );
    expect(ascii).toContain("== BORGMCP-SERVER ==");
    expect(ascii).toContain("+");
    for (const line of ascii.split("\n")) expect([...line]).toHaveLength(64);
    expect(ascii).toContain("SCOPE");
    expect(ascii).toContain("cov 0%");

    for (let width = 20; width <= 100; width += 1) {
      const rendered = createDashboardRenderer({ glyphMode: "ascii", color: true })(
        snapshot,
        width,
        18,
      );
      expect(rendered).not.toMatch(/[^\x00-\x7F]/u);
    }

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
    expect(tiny.split("\n")).toHaveLength(9);
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
    expect(tinyViewer.split("\n")).toHaveLength(9);
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
      expect(frame).not.toContain("SCOPE");
    }

    const inkFrame = renderer(snapshot, 40, 10);
    expect(inkFrame).toContain("-".repeat(40));
    expect(inkFrame.split("\n").every((line) => stringWidth(line) === 40)).toBe(true);
    expect(inkFrame.split("\n")).toHaveLength(10);
  });

  it("preserves status, drone name, and age at the exact 40x10 Sensor Grid boundary", () => {
    const data = snapshotData(2);
    const attention = {
      unacked_directed: 1,
      stale_directed: 1,
      oldest_unacked: {
        created_at: "2026-07-25T11:55:00.000Z",
        cube_name: "cube-01",
        recipient_label: "builder-01",
      },
    } as const;
    const snapshot = rankDashboardSnapshot({
      ...data,
      attention,
      recent_activity: [{
        id: "40000000-0000-4000-8000-000000000040",
        cube_name: "cube-01",
        actor_kind: "operator",
        actor_label: null,
        actor_role: null,
        created_at: data.captured_at,
        visibility: "broadcast",
        recipient_count: 0,
        activity_class: null,
        message_head: "new activity",
      }],
      cubes: data.cubes.map((cube) => ({
        ...cube,
        attention,
        drones: cube.drones.map((drone) => ({ ...drone, attention })),
      })),
    }, server);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false, motionMode: "off" })(
      snapshot,
      40,
      10,
    );
    expect(frame).toContain("ATTN STALE 1");
    expect(frame).toContain("SCOPE cube-01");
    expect(frame).toMatch(/RECENT !1 builder-01.*1m/u);
    expect(frame).toContain("1m");
    expect(frame).toContain("Server data and identity remain saved.");
    expect(frame).toContain("^C stop server  |  read-only");
    expect(frame).not.toContain("Endpoint:");
    expect(frame).not.toContain("FEED");
    expect(frame.split("\n").some((line) => /^[.:+*#]\s+\d/u.test(line))).toBe(false);
  });

  it("keeps stale attention targets visible when compacting and styles their marker independently", () => {
    const data = snapshotData(1);
    const cube = data.cubes[0]!;
    const staleAttention = {
      unacked_directed: 2,
      stale_directed: 2,
      oldest_unacked: {
        created_at: "2026-07-25T11:20:00.000Z",
        cube_name: cube.name,
        recipient_label: "attention-target",
      },
    } as const;
    const drones = Array.from({ length: 6 }, (_unused, index) => ({
      ...cube.drones[0]!,
      id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      label: index === 5 ? "attention-target" : `live-${index + 1}`,
      last_seen: index === 5 ? "2026-07-25T11:20:00.000Z" : "2026-07-25T11:59:50.000Z",
      attention: index === 5 ? staleAttention : cube.drones[0]!.attention,
    }));
    const snapshot = rankDashboardSnapshot({
      ...data,
      attention: staleAttention,
      cubes: [{ ...cube, drones, drones_total: drones.length, attention: staleAttention }],
    }, server);
    const mono = createDashboardRenderer({ glyphMode: "ascii", color: false, motionMode: "off" })(
      snapshot,
      40,
      10,
    );
    expect(mono).toMatch(/QUIET !2 attention-target\s+40m/u);
    expect(mono.indexOf("attention-target")).toBeLessThan(mono.indexOf("live-1"));
    expect(mono).not.toContain("\u001b[");

    const color = createDashboardRenderer({ glyphMode: "box", color: true, motionMode: "off" })(
      snapshot,
      120,
      30,
    );
    const target = color.split("\n").find((line) =>
      line.includes("attention-target") && line.includes("QUIET"))!;
    expect(target).toContain("QUIET");
    expect(target).toContain("\u001b[7m\u001b[33m!2\u001b[0m");
  });

  it("keeps the live foreground fallback outside Ink while crossing the boundary", async () => {
    const harness = terminalHarness();
    harness.setDimensions(39, 24);
    const source = sourceHarness(snapshotData(1));
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer: createDashboardRenderer({ glyphMode: "box", color: true, colorDepth: "ansi256" }),
    });

    expect(harness.output.at(-1)).toContain("borgmcp-server online");
    expect(harness.output.join("")).not.toContain("SCOPE");

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
    const beforePlain = harness.output.length;
    harness.resize();
    const plainTransition = harness.output.slice(beforePlain).join("");
    expect(plainTransition).toContain("\u001b[0m\u001b[2J\u001b[H");
    expect(harness.output.at(-1)).toContain("borgmcp-server online");
    expect(harness.output.at(-1)).not.toContain("SCOPE");
    dashboard.close();
  });

  it("replaces isometric art with a flat bounded activity panel", () => {
    const frame = createDashboardRenderer({ glyphMode: "box", color: false })(
      rankDashboardSnapshot(snapshotData(1), server),
      80,
      24,
    );
    const detail = frame.split("\n").slice(3, -3);
    expect(detail.some((line) => line.includes("SCOPE"))).toBe(true);
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
        expect(frame).toContain("SCOPE");
        expect(frame).not.toContain("/......");
      }
    }
  });

  it("uses a distinct fixed-width activity marker in cube list rows", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(3), server);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      80,
      14,
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
    expect(auto).toContain("SCOPE");
    expect(auto).toContain("1 poster");
    expect(auto).toContain("cov 0%");
    expect(auto).not.toContain("< > switch");
    expect(pinned).toContain("SCOPE");
    expect(empty).not.toContain("< > switch");
  });

  it("names the effective endpoint and bind mode", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(1), server);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      200,
      24,
    );
    const fallback = renderPlainDashboard(snapshot, 200, 20);

    for (const output of [frame, fallback]) {
      expect(output).toContain("Endpoint: https://127.0.0.1:7091");
      expect(output).toContain("Bind mode: loopback");
    }
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

  it("renders one aggregate scope whose shared bucket grows when two drones post", () => {
    const data = snapshotData(1);
    const original = data.cubes[0]!;
    const quiet = original.drones[0]!;
    const busy = { ...quiet, id: "10000000-0000-4000-8000-000000000099", label: "busy" };
    const snapshot = rankDashboardSnapshot({
      ...data,
      cubes: [{ ...original, drones: [quiet, busy], drones_total: 2 }],
    }, server);
    const shared = snapshot.captured_at;
    const render = (includeBusy: boolean, width = 120) => createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      width,
      30,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        activity: new Map([
          [`${snapshot.cubes[0]!.id}:${quiet.id}`, [
            { capturedAt: shared, sentRate: 3 },
          ]],
          [`${snapshot.cubes[0]!.id}:${busy.id}`, includeBusy
            ? [{ capturedAt: shared, sentRate: 3 }]
            : []],
        ]),
        observation: [{ capturedAt: shared, sentRate: 0 }],
      },
    );
    const single = asciiScopeGraphRows(render(false));
    const combinedFrame = render(true);
    const combined = asciiScopeGraphRows(combinedFrame);
    const lastColumnHeight = (rows: readonly string[]) => rows.filter((row) => row.at(-1) !== " ").length;
    expect(lastColumnHeight(combined)).toBeGreaterThan(lastColumnHeight(single));
    expect(combinedFrame.match(/builder-01/gu)).toHaveLength(1);
    expect(combinedFrame.match(/busy/gu)).toHaveLength(1);
    expect(combinedFrame.match(/SENSOR SCOPE/gu)).toHaveLength(1);
    expect(render(true, 80).split("\n").filter((line) =>
      line.includes("builder-01") || line.includes("busy"))).toHaveLength(2);
  });

  it("matches literal Nightwatch grids and keeps color character-identical to NO_COLOR", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(3), server);
    const monoRenderer = createDashboardRenderer({ glyphMode: "box", color: false, motionMode: "off" });
    const colorRenderer = createDashboardRenderer({
      glyphMode: "box",
      color: true,
      colorDepth: "truecolor",
      motionMode: "off",
    });
    for (const [columns, rows, resolution] of [
      [80, 24, "30s/bar"],
      [120, 40, "20s/bar"],
      [200, 50, "20s/bar"],
    ] as const) {
      const mono = monoRenderer(snapshot, columns, rows);
      const color = colorRenderer(snapshot, columns, rows);
      expect(stripAnsi(color)).toBe(mono);
      expect(mono.split("\n")).toHaveLength(rows);
      expect(mono.split("\n").every((line) => stringWidth(line) === columns)).toBe(true);
      expect(mono).toContain(resolution);
      expect(mono).not.toContain("\u001b");
      expect(JSON.stringify(mono)).toMatchSnapshot(`${columns}x${rows} NO_COLOR`);
      for (const line of color.split("\n")) {
        expect(line.startsWith("\u001b[48;2;9;11;16m")).toBe(true);
        expect(line.endsWith("\u001b[0m")).toBe(true);
      }
    }
    const stacked = monoRenderer(snapshot, 120, 40).split("\n");
    expect(stacked.findIndex((line) => line.includes("SENSOR SCOPE")))
      .toBeLessThan(stacked.findIndex((line) => line.includes("DRONES")));
    const wideTitle = monoRenderer(snapshot, 200, 50).split("\n")
      .find((line) => line.includes("SENSOR SCOPE"))!;
    expect(wideTitle).toContain("DRONES");

    const compactMono = monoRenderer(snapshot, 40, 10);
    const compactColor = colorRenderer(snapshot, 40, 10);
    expect(stripAnsi(compactColor)).toBe(compactMono);
    expect(compactMono).toContain("Server data and identity remain saved.");
    expect(compactMono).toContain("^C stop server  |  read-only");

    const ansi256 = createDashboardRenderer({
      glyphMode: "box",
      color: true,
      colorDepth: "ansi256",
    })(snapshot, 80, 24);
    expect(ansi256).toContain("\u001b[48;5;232m");
    expect(ansi256).toContain("\u001b[38;5;215m");
    const ansi16 = createDashboardRenderer({
      glyphMode: "box",
      color: true,
      colorDepth: "ansi16",
    })(snapshot, 80, 24);
    expect(ansi16).not.toMatch(/\u001b\[48;/u);
    expect(ansi16).toContain("\u001b[33m");
  });

  it("paints the live Ink frame background and full rows", async () => {
    const harness = terminalHarness();
    const dashboard = startForegroundDashboard({
      source: sourceHarness(snapshotData(1)),
      server,
      terminal: harness.terminal,
      renderer: createDashboardRenderer({
        glyphMode: "box",
        color: true,
        colorDepth: "ansi256",
        motionMode: "off",
      }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const output = harness.output.join("");
    expect(output).toContain(`\u001b[48;5;232m\u001b[H${" ".repeat(80)}`);
    expect(output).toContain("\u001b[48;5;232m\u001b[38;5;215m");
    dashboard.close();
  });

  it("forces strict ASCII frames to remain escape-free", () => {
    const renderer = createDashboardRenderer({
      glyphMode: "ascii",
      color: true,
      colorDepth: "truecolor",
    });
    const frame = renderer(rankDashboardSnapshot(snapshotData(1), server), 80, 24);
    expect(frame).not.toContain("\u001b");
    expect(frame).not.toMatch(/[^\x00-\x7F]/u);
    expect(renderer.inkOptions).toMatchObject({ color: false, colorDepth: "none" });
  });

  it("uses adjacent fixed scope modes and fixed board geometry at 143/144", () => {
    const snapshot = rankDashboardSnapshot(snapshotData(1), server);
    const renderer = createDashboardRenderer({ glyphMode: "box", color: false, motionMode: "off" });
    const stacked = renderer(snapshot, 143, 40).split("\n");
    const wide = renderer(snapshot, 144, 40).split("\n");
    const stackedTitle = stacked.find((line) => line.includes("SENSOR SCOPE"))!;
    const wideTitle = wide.find((line) => line.includes("SENSOR SCOPE"))!;
    expect(stackedTitle).toContain("20s/bar");
    expect(stackedTitle).not.toContain("DRONES");
    expect(wideTitle).toContain("30s/bar");
    expect(wideTitle).toContain("DRONES");
    expect(wideTitle.indexOf("┬")).toBe(66);
    expect(stringWidth(wideTitle)).toBe(144);
    const stackedAxis = stacked.find((line) => line.includes("15m") && line.includes("now"))!;
    const wideAxis = wide.find((line) => line.includes("15m") && line.includes("now"))!;
    expect(stackedAxis.indexOf("15m")).toBe(52);
    expect(wideAxis.indexOf("15m")).toBe(6);
  });

  it("maps Nightwatch tokens across chrome, bind, feed, lifecycle, and footer regions", () => {
    const data = snapshotData(1);
    const recent = [{
      id: "40000000-0000-4000-8000-000000000010",
      cube_name: "cube-01",
      actor_kind: "drone-session" as const,
      actor_label: "builder-01",
      actor_role: "Builder",
      created_at: data.captured_at,
      visibility: "broadcast" as const,
      recipient_count: 0,
      activity_class: "status",
      message_head: "feed message",
    }];
    const snapshot = rankDashboardSnapshot({ ...data, recent_activity: recent }, server);
    const lines = createDashboardRenderer({
      glyphMode: "box",
      color: true,
      colorDepth: "ansi256",
    })(snapshot, 120, 40).split("\n");
    const find = (text: string) => lines.find((line) => stripAnsi(line).includes(text))!;
    expect(find("Endpoint:")).toContain("\u001b[38;5;245m");
    expect(find("────────")).toContain("\u001b[38;5;215m");
    expect(find("SENSOR SCOPE")).toContain("\u001b[38;5;215m");
    expect(find("FEED")).toContain("\u001b[38;5;147m");
    expect(find("FEED")).toContain("\u001b[38;5;245m");
    expect(find("server data and identity")).toContain("\u001b[38;5;245m");
    expect(lines.at(-1)).toContain("\u001b[38;5;245m");
  });

  it("keeps fixed two-cell scope buckets stable within a resolution mode", () => {
    const data = snapshotData(1);
    const snapshot = rankDashboardSnapshot(data, server);
    const cube = snapshot.cubes[0]!;
    const drone = cube.drones[0]!;
    const end = Date.parse(snapshot.captured_at);
    const start = end - 15 * 60_000;
    const samples = Array.from({ length: 30 }, (_, index) => ({
      capturedAt: new Date(start + index * 30_000 + 15_000).toISOString(),
      sentRate: index % 4,
    }));
    const render = (width: number) => createDashboardRenderer({ glyphMode: "ascii", color: false, motionMode: "off" })(
      snapshot,
      width,
      24,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        activity: new Map([[`${cube.id}:${drone.id}`, samples]]),
        observation: samples,
        activityWindowMs: 15 * 60_000,
        motionMode: "off",
      },
    );
    const sixtyCellCanvas = (frame: string) => asciiScopeGraphRows(frame).map((row) => row.slice(-60));
    expect(sixtyCellCanvas(render(80))).toEqual(sixtyCellCanvas(render(88)));
    expect(render(80)).toContain("30s/bar");
    expect(render(88)).toContain("30s/bar");
  });

  it("fills aggregate bars bottom-up and distinguishes observed from missing buckets", () => {
    const data = snapshotData(1);
    const snapshot = rankDashboardSnapshot(data, server);
    const cube = snapshot.cubes[0]!;
    const drone = cube.drones[0]!;
    const end = Date.parse(snapshot.captured_at);
    const start = end - 15 * 60_000;
    const bucket = (index: number, sentRate: number) => ({
      capturedAt: new Date(start + index * 20_000 + 10_000).toISOString(),
      sentRate,
    });
    const activity = [bucket(41, 0), bucket(42, 1), bucket(43, 4), bucket(44, 8)];
    const observations = Array.from({ length: 45 }, (_, index) => bucket(index, 0));
    const render = (ambientPhase: number) => createDashboardRenderer({ glyphMode: "ascii", color: false })(
      snapshot,
      120,
      40,
      {
        autoFollow: true,
        focusedCubeId: null,
        pulseCubeIds: new Set(),
        pulsePhase: 0,
        ambientPhase,
        activity: new Map([[`${cube.id}:${drone.id}`, activity]]),
        observation: observations,
        activityWindowMs: 15 * 60_000,
        motionMode: "ambient",
      },
    );
    const rows = asciiScopeGraphRows(render(5)).map((row) => row.slice(-90));
    const heightAt = (bucketIndex: number) => rows.filter((row) =>
      row.slice(bucketIndex * 2, bucketIndex * 2 + 2) === "##").length;
    expect(heightAt(41)).toBe(0);
    expect(heightAt(42)).toBe(1);
    expect(heightAt(43)).toBe(Math.ceil(rows.length / 2));
    expect(heightAt(44)).toBe(rows.length);
    for (const bucketIndex of [42, 43, 44]) {
      const occupied = rows.map((row) => row.slice(bucketIndex * 2, bucketIndex * 2 + 2) === "##");
      expect(occupied.slice(occupied.indexOf(true)).every(Boolean)).toBe(true);
    }
    const frame = render(5);
    const lines = frame.split("\n");
    const axis = lines.findIndex((line) => line.includes("15m") && line.includes("now"));
    expect(lines[axis - 1]!.slice(-91, -1)).toBe(".".repeat(90));

    const missing = createDashboardRenderer({ glyphMode: "ascii", color: false })(snapshot, 120, 40, {
      autoFollow: true,
      focusedCubeId: null,
      pulseCubeIds: new Set(),
      pulsePhase: 0,
      activity: new Map([[`${cube.id}:${drone.id}`, activity]]),
      observation: observations.filter((_sample, index) => index % 2 === 0),
      activityWindowMs: 15 * 60_000,
      motionMode: "off",
    });
    const missingLines = missing.split("\n");
    const missingAxis = missingLines.findIndex((line) => line.includes("15m") && line.includes("now"));
    expect(missingLines[missingAxis - 1]!.slice(-91, -1)).toMatch(/\.\.  \.\.  /u);

    const occupancy = (value: string) => asciiScopeGraphRows(value)
      .map((row) => row.replace(/[^#]/gu, " "));
    expect(occupancy(render(5))).toEqual(occupancy(render(37)));
  });

  it("uses fixed drone columns, sanitizes models, and drops whole columns", () => {
    const data = snapshotData(1);
    const cube = data.cubes[0]!;
    const drones = [
      { ...cube.drones[0]!, id: "long", label: "very-long-drone-label-that-must-truncate", role: "Very Long Role", reported_model: "model\u001b[31m-unsafe-name-that-is-long" },
      { ...cube.drones[0]!, id: "null", label: "short", reported_model: null },
    ];
    const snapshot = rankDashboardSnapshot({
      ...data,
      cubes: [{ ...cube, drones, drones_total: drones.length }],
    }, server);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false })(snapshot, 120, 40);
    const lines = frame.split("\n");
    const header = lines.find((line) => line.includes("STATUS") && line.includes("MODEL"))!;
    const long = lines.find((line) => line.includes("very-long"))!;
    const absent = lines.find((line) => line.includes("short"))!;
    for (const label of ["STATUS", "!", "DRONE", "ROLE", "MODEL", "SENT", "AGE"]) {
      expect(header.indexOf(label)).toBeGreaterThanOrEqual(0);
    }
    expect(long).not.toContain("\u001b");
    expect(long).toContain("model-unsafe-name-that-is-long");
    const modelStart = header.indexOf("MODEL");
    const sentStart = header.indexOf("SENT");
    expect(absent.slice(modelStart, sentStart).trim()).toBe("-");
    expect(long.indexOf("1", sentStart)).toBe(sentStart + 3);
    expect(absent.indexOf("1", sentStart)).toBe(sentStart + 3);

    const noModel = createDashboardRenderer({ glyphMode: "ascii", color: false })(snapshot, 68, 30);
    const compact = createDashboardRenderer({ glyphMode: "ascii", color: false })(snapshot, 56, 30);
    expect(noModel).not.toContain("MODEL");
    expect(noModel).toContain("SENT");
    expect(compact).not.toContain("MODEL");
    expect(compact).not.toContain("SENT");
    expect(compact).not.toContain("ROLE");
    expect(compact).toContain("short");
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
    const render = (color: boolean, glyphMode: "ascii" | "box" = "ascii") =>
      createDashboardRenderer({ glyphMode, color })(snapshot, 100, 36);
    const colorFrame = render(true, "box");
    const lines = colorFrame.split("\n");
    expect(boardSegment(lines.find((line) => line.includes("live"))!)).toContain("\u001b[32;1m");
    expect(boardSegment(lines.find((line) => line.includes("recent"))!)).toContain("RECENT");
    expect(boardSegment(lines.find((line) => line.includes("idle"))!)).toContain("QUIET");
    expect(boardSegment(lines.find((line) => line.includes("stale"))!)).toContain("\u001b[2m");
    expect(render(false)).not.toContain("\u001b[");
    expect(render(true)).not.toContain("\u001b[");
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
      version: "2.1.0\u001b[2J",
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

  it("renders sanitized wide drone labels with compact status metrics beside the shared scope", () => {
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
    expect(frame).toMatch(/RECENT\s+東京🚀-red\s+Builder r…\s+claude-opus-5\s+12\s+1m/u);
    expect(frame).toContain("SENSOR SCOPE");
    expect(frame).not.toContain("DIRECTED 8");
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
    expect(frame).toContain("cov 0%");
    expect(frame).not.toContain("collecting");
    expect(frame.match(new RegExp(drone.label, "gu"))).toHaveLength(1);
    expect(asciiScopeGraphRows(frame).every((line) => /^\s*:\s*$/u.test(line))).toBe(true);
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
        ambientPhase: 30,
        activity: new Map([[key, samples]]),
        observation: samples,
        activityWindowMs: 15 * 60_000,
      });
      const rows = asciiScopeGraphRows(frame);
      const graph = Array.from({ length: rows[0]?.length ?? 0 }, (_unused, column) =>
        rows.map((row) => row[column]!).find((character) => character !== " ") ?? " ").join("");
      return { frame, graph };
    };
    const withoutSweep = (graph: string) => `${graph.slice(0, 30)} ${graph.slice(31)}`;

    const clustered = [
      ...Array.from({ length: 90 }, (_, index) => sample(start + 5_000 + (index * 100), 1)),
      ...Array.from({ length: 90 }, (_, index) => sample(end - 9_000 + (index * 100), 4)),
    ];
    const clusteredFrame = graphFor(clustered);
    expect(clusteredFrame.frame).toContain("cov 2%");
    expect(withoutSweep(clusteredFrame.graph)).toMatch(/[.:+*#]\s{40,}[.:+*#]/u);

    const uniformMinute = Array.from(
      { length: 180 },
      (_, index) => sample(end - 60_000 + Math.floor(index * 60_000 / 180), 1 + (index % 4)),
    );
    const uniformGraph = graphFor(uniformMinute).graph;
    expect(withoutSweep(uniformGraph).search(/[+*#]/u)).toBeGreaterThan(45);

    const endpoints = graphFor([sample(start, 1), sample(end, 4)]).graph;
    expect(endpoints.search(/[.:+*#]/u)).toBeGreaterThan(0);
    expect(endpoints.at(-1)).toMatch(/[.:+*#]/u);
    expect(endpoints.replace(":", " ")).toMatch(/^\s*##\s+##$/u);

    const full = Array.from(
      { length: 180 },
      (_, index) => sample(start + (index * 5_000), 1 + (index % 4)),
    );
    expect(graphFor(full).frame).toContain("cov 100%");
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
    expect(sparseFrame).toContain("cov 10%");

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
    expect(frame).toContain("cov 100%");
    expect(frame.match(/late-joiner/gu)).toHaveLength(1);
    expect(asciiScopeGraphRows(frame).some((line) => /[.:+*#]\s*$/u.test(line))).toBe(true);
  });

  it("treats NO_COLOR and terminal/locale fallback as first-class variants", () => {
    expect(dashboardColorEnabled({ NO_COLOR: "" })).toBe(false);
    expect(dashboardColorEnabled({ TERM: "xterm-256color" })).toBe(true);
    expect(dashboardColorDepth({ NO_COLOR: "", TERM: "xterm-256color" })).toBe("none");
    expect(dashboardColorDepth({ TERM: "dumb", COLORTERM: "truecolor" })).toBe("none");
    expect(dashboardColorDepth({ TERM: "xterm-256color" })).toBe("ansi256");
    expect(dashboardColorDepth({ TERM: "xterm", COLORTERM: "24bit" })).toBe("truecolor");
    expect(dashboardColorDepth({ TERM: "xterm" })).toBe("ansi16");
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
    expect(resolveDashboardMotionMode({ noMotion: false, environment: {} })).toBe("ambient");
    expect(resolveDashboardMotionMode({ noMotion: false, environment: { BORGMCP_DASHBOARD_MOTION: "calm" } })).toBe("calm");
    expect(resolveDashboardMotionMode({ noMotion: true, environment: { BORGMCP_DASHBOARD_MOTION: "ambient" } })).toBe("off");
    expect(() => resolveDashboardMotionMode({
      noMotion: false,
      environment: { BORGMCP_DASHBOARD_MOTION: "fast" },
    })).toThrow("Set BORGMCP_DASHBOARD_MOTION to ambient, calm, or off.");
  });

  it("renders attention and a bounded sanitized recent feed across Ink and plain fallbacks", () => {
    const data = snapshotData(1);
    const attention = {
      unacked_directed: 2,
      stale_directed: 1,
      oldest_unacked: {
        created_at: "2026-07-25T11:55:00.000Z",
        cube_name: "cube-01",
        recipient_label: "builder-01",
      },
    } as const;
    const recent = [{
      id: "40000000-0000-4000-8000-000000000001",
      cube_name: "cube-01",
      actor_kind: "drone-session" as const,
      actor_label: "builder-01",
      actor_role: "Builder",
      created_at: "2026-07-25T11:59:00.000Z",
      visibility: "direct" as const,
      recipient_count: 1,
      activity_class: "review",
      message_head: "safe\u001b[2J\nmessage",
    }];
    const snapshot = rankDashboardSnapshot({
      ...data,
      attention,
      recent_activity: recent,
      cubes: data.cubes.map((cube) => ({
        ...cube,
        attention,
        drones: cube.drones.map((drone) => ({ ...drone, attention })),
      })),
    }, server);
    const ink = createDashboardRenderer({ glyphMode: "ascii", color: false, motionMode: "off" })(snapshot, 100, 24);
    const plain = renderPlainDashboard(snapshot, 39, 9);
    for (const frame of [ink, plain]) {
      expect(frame).toContain("ATTN STALE 1");
      expect(frame).toContain("FEED");
      expect(frame).not.toContain("\u001b[2J");
    }
    expect(ink).toContain("safe message");
    const inverse = createDashboardRenderer({ glyphMode: "box", color: true, motionMode: "off" })(snapshot, 100, 24);
    expect(inverse).toContain("\u001b[7m");
    expect(ink).not.toContain("\u001b[7m");
  });

  it("keeps new feed and attention text strictly 7-bit in ASCII mode", () => {
    const data = snapshotData(1);
    const snapshot = rankDashboardSnapshot({
      ...data,
      recent_activity: [{
        id: "40000000-0000-4000-8000-000000000002",
        cube_name: "東京",
        actor_kind: "operator",
        actor_label: null,
        actor_role: null,
        created_at: data.captured_at,
        visibility: "broadcast",
        recipient_count: 0,
        activity_class: "通知",
        message_head: "更新 🚀",
      }],
    }, server);
    const frame = createDashboardRenderer({ glyphMode: "ascii", color: false, motionMode: "off" })(
      snapshot,
      100,
      24,
    );
    expect(frame).toContain("FEED");
    expect(frame).not.toMatch(/[^\x00-\x7f]/u);
  });
});

describe("foreground dashboard lifecycle", () => {
  it("degrades ambient motion to calm after a frame budget overrun", async () => {
    const harness = terminalHarness();
    harness.setDimensions(120, 30);
    const dashboard = startForegroundDashboard({
      source: sourceHarness(snapshotData(2)),
      server,
      terminal: harness.terminal,
      renderer: createDashboardRenderer({
        glyphMode: "ascii",
        color: false,
        motionMode: "ambient",
        navigation: true,
      }),
      frameBudgetMs: -1,
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(harness.output.join("\n")).toContain("motion: calm (auto)");
    dashboard.close();
  });

  it("animates the ambient scope without refreshing data and stays static when motion is off", async () => {
    vi.useFakeTimers();
    for (const [motionMode, expectedExtraWrites] of [["ambient", true], ["off", false]] as const) {
      const harness = terminalHarness();
      const source = sourceHarness(snapshotData(1));
      const dashboard = startForegroundDashboard({
        source,
        server,
        terminal: harness.terminal,
        renderer: createDashboardRenderer({ glyphMode: "ascii", color: false, motionMode }),
        ambientFrameMs: 100,
      });
      const reads = source.readCount();
      const writes = harness.output.length;
      await vi.advanceTimersByTimeAsync(300);
      expect(source.readCount()).toBe(reads);
      expect(harness.output.length > writes).toBe(expectedExtraWrites);
      dashboard.close();
    }
  });
  it("bounds activity history when the live drone set rotates", async () => {
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
      idleRefreshMs: 100,
    });
    const cube = initial.cubes[0]!;
    const originalDrone = cube.drones[0]!;
    let latestDroneId = originalDrone.id;

    for (let index = 1; index <= 20; index += 1) {
      latestDroneId = `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      source.set({
        ...initial,
        captured_at: new Date(Date.parse(initial.captured_at) + (index * 100)).toISOString(),
        cubes: [{
          ...cube,
          drones: [{ ...originalDrone, id: latestDroneId }],
        }],
      });
      await vi.advanceTimersByTimeAsync(100);
    }

    const activity = renderer.mock.lastCall?.[3]?.activity;
    expect(activity).toHaveProperty("size", 1);
    expect(activity?.has(`${cube.id}:${latestDroneId}`)).toBe(true);
    dashboard.close();
  });

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
    expect(harness.output.at(-1)).toContain("SCOPE");
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
    expect(pulse).toContain("SCOPE");
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
    harness.setDimensions(80, 16);
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

    expect(harness.output.at(-1)).toContain("SCOPE cube-01 . (auto)");
    harness.input(">");
    expect(harness.output.at(-1)).toContain("SCOPE cube-02 . (pinned)");
    harness.input("<");
    expect(harness.output.at(-1)).toContain("SCOPE cube-01 . (pinned)");
    harness.input("a");
    expect(harness.output.at(-1)).toContain("SCOPE cube-01 . (auto)");
    harness.input("<");
    expect(harness.output.at(-1)).toContain("SCOPE cube-03 . (pinned)");
    harness.input("a");
    expect(harness.output.at(-1)).toContain("SCOPE cube-01 . (auto)");

    harness.input("w");
    expect(harness.output.at(-1)).toContain("w 60m");
    harness.input("w");
    expect(harness.output.at(-1)).toContain("w 5m");
    harness.setDimensions(80, 13);
    harness.resize();
    harness.input(" ");
    expect(harness.output.at(-1)).toContain("SPACE 2/3");
    harness.input(" ");
    harness.setDimensions(80, 16);
    harness.resize();

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
    expect(pulseStart).toContain("SCOPE");
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
      renderer: createDashboardRenderer({ glyphMode: "box", color: true, colorDepth: "ansi256" }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeResume = harness.output.length;

    harness.input("\u001a");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.output).toContain("\u001b[0m\u001b[?25h\u001b[?1049l\u001b[?25h");
    expect(harness.output).toContain("\u001b[?1049h\u001b[?25l");
    expect(harness.output.slice(beforeResume).join("")).toContain("SCOPE");
    dashboard.close();
    expect(harness.output.at(-1)).toBe("\u001b[0m\u001b[?25h\u001b[?1049l\u001b[?25h");
  });

  it("restores terminal state, emits bounded plain status, and rejects on render failure", async () => {
    vi.useFakeTimers();
    const harness = terminalHarness();
    const source = sourceHarness(snapshotData(1));
    let calls = 0;
    const baseRenderer = createDashboardRenderer({
      glyphMode: "box",
      color: true,
      colorDepth: "ansi256",
    });
    const failingRenderer: DashboardRenderer = (snapshot, columns, rows) => {
      calls += 1;
      if (calls === 2) throw new Error("render failed");
      return baseRenderer(snapshot, columns, rows);
    };
    Object.defineProperty(failingRenderer, "inkOptions", { value: baseRenderer.inkOptions });
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: harness.terminal,
      renderer: failingRenderer,
    });
    const rejected = expect(dashboard.failure).rejects.toThrow("render failed");
    source.emit();
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(harness.output).toContain("\u001b[0m\u001b[?25h\u001b[?1049l\u001b[?25h");
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
    store.forPrincipal(droneSessionPrincipal({
      id: sessionId,
      clientId: ids.client,
      cubeId,
      droneId,
    })).updateOwnRuntimeMetadata(cubeId, { reported_model: `model-${name.toLowerCase()}` });
  }
}

function snapshotData(count: number): DashboardDataSnapshot {
  const attention = { unacked_directed: 0, stale_directed: 0, oldest_unacked: null } as const;
  return {
    captured_at: "2026-07-25T12:00:00.000Z",
    attention,
    recent_activity: [],
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
      attention,
      drones: [{
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        label: `builder-${String(index + 1).padStart(2, "0")}`,
        role: "Builder",
        reported_model: index % 2 === 0 ? "claude-opus-5" : null,
        last_seen: new Date(Date.parse("2026-07-25T12:00:00.000Z") - ((index + 1) * 60_000)).toISOString(),
        sent: index + 1,
        sent_5s: index + 1,
        received: index + 1,
        attention,
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
