import { createInkDashboardElement, renderInkDashboardFrame } from "./dashboard-ink.js";
import { renderPlainDashboard } from "./dashboard-plain.js";
import { render as renderInk, type Instance as InkInstance } from "ink";
import { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { operatorErrors } from "./operator-error.js";

export const DASHBOARD_ACTIVITY_WINDOW_MS = 15 * 60_000;
export const DASHBOARD_IDLE_REFRESH_MS = 5_000;
export const DASHBOARD_EVENT_COALESCE_MS = 250;
export const DASHBOARD_RESIZE_DEBOUNCE_MS = 125;
export const DASHBOARD_PULSE_FRAME_MS = 125;
export const DASHBOARD_AMBIENT_FRAME_MS = 500;
export const DASHBOARD_FRAME_BUDGET_MS = 50;
const DASHBOARD_PULSE_PHASES = 4;

export type DashboardMotionMode = "ambient" | "calm" | "off";

export interface DashboardAttentionData {
  readonly unacked_directed: number;
  readonly stale_directed: number;
  readonly oldest_unacked: {
    readonly created_at: string;
    readonly cube_name: string;
    readonly recipient_label: string;
  } | null;
}

export interface DashboardRecentActivityData {
  readonly id: string;
  readonly cube_name: string;
  readonly actor_kind: "operator" | "client" | "drone-session";
  readonly actor_label: string | null;
  readonly actor_role: string | null;
  readonly created_at: string;
  readonly visibility: "broadcast" | "direct";
  readonly recipient_count: number;
  readonly activity_class: string | null;
  readonly message_head: string;
}

export interface DashboardDroneData {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly last_seen: string;
  readonly sent: number;
  readonly sent_5s: number;
  readonly received: number;
  readonly attention: DashboardAttentionData;
}

export interface DashboardCubeData {
  readonly id: string;
  readonly name: string;
  readonly posts_15m: number;
  readonly distinct_posting_drones_15m: number;
  readonly drones_total: number;
  readonly drones_seen_15m: number;
  readonly last_post_at: string | null;
  readonly drones: readonly DashboardDroneData[];
  readonly attention: DashboardAttentionData;
}

export interface DashboardDataSnapshot {
  readonly captured_at: string;
  readonly cubes: readonly DashboardCubeData[];
  readonly attention: DashboardAttentionData;
  readonly recent_activity: readonly DashboardRecentActivityData[];
}

export interface DashboardSnapshotSource {
  readonly read: () => DashboardDataSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface DashboardServerIdentity {
  readonly name: string;
  readonly version: string;
  readonly endpoint: string;
  readonly bind_mode: "loopback" | "lan";
  readonly state: "online" | "degraded" | "shutting-down";
  readonly started_at: string;
}

export interface DashboardCubeSnapshot extends DashboardCubeData {
  readonly rank: number;
  readonly rank_change: number;
}

export interface DashboardSnapshot {
  readonly captured_at: string;
  readonly server: DashboardServerIdentity;
  readonly cubes: readonly DashboardCubeSnapshot[];
  readonly attention: DashboardAttentionData;
  readonly recent_activity: readonly DashboardRecentActivityData[];
}

export type DashboardGlyphMode = "box" | "ascii";

export const EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER =
  "Press Ctrl-C or close this terminal to stop the server. Your server data and identity remain saved.";
export const EMBEDDED_DASHBOARD_FOOTER = "^C stop server  |  read-only";
export const STANDALONE_DASHBOARD_FOOTER = "^C close viewer  |  read-only";
export type DashboardFooter =
  | typeof EMBEDDED_DASHBOARD_FOOTER
  | typeof STANDALONE_DASHBOARD_FOOTER;

export interface DashboardRenderOptions {
  readonly glyphMode: DashboardGlyphMode;
  readonly color: boolean;
  readonly footer: DashboardFooter;
  readonly navigation?: boolean;
  readonly motionMode?: DashboardMotionMode;
}

export interface DashboardViewState {
  readonly autoFollow: boolean;
  readonly focusedCubeId: string | null;
  readonly pulseCubeIds: ReadonlySet<string>;
  readonly pulsePhase: number;
  readonly activity?: ReadonlyMap<string, readonly DashboardActivitySample[]>;
  readonly observation?: readonly DashboardActivitySample[];
  readonly activityWindowMs?: number;
  readonly page?: number;
  readonly motionMode?: DashboardMotionMode;
  readonly motionAutoDegraded?: boolean;
  readonly ambientPhase?: number;
}

export interface DashboardActivitySample {
  readonly capturedAt: string;
  readonly sentRate: number;
}

export interface DashboardRenderer {
  (
    snapshot: DashboardSnapshot,
    columns: number,
    rows: number,
    view?: DashboardViewState,
  ): string;
  readonly inkOptions?: DashboardRenderOptions & { readonly baseFooter: string };
}

export interface DashboardTerminal {
  readonly write: (value: string) => void;
  readonly dimensions: () => { readonly columns: number; readonly rows: number };
  readonly onResize: (listener: () => void) => () => void;
  readonly onInput?: (listener: (value: Uint8Array) => void) => () => void;
  readonly requestInterrupt?: () => void;
  readonly requestSuspend?: (resume: () => void) => void;
}

export interface ForegroundDashboard {
  readonly failure: Promise<never>;
  readonly close: () => void;
}

export interface Glyphs {
  readonly horizontal: string;
  readonly vertical: string;
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly rail: string;
  readonly cube: readonly string[];
  readonly ellipsis: string;
  readonly separator: string;
  readonly dash: string;
  readonly axis: string;
}

export const BOX_GLYPHS: Glyphs = Object.freeze({
  horizontal: "─",
  vertical: "│",
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  rail: "█",
  cube: ["·", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  ellipsis: "…",
  separator: "·",
  dash: "—",
  axis: "→",
});

export const ASCII_GLYPHS: Glyphs = Object.freeze({
  horizontal: "-",
  vertical: "|",
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  rail: "=",
  cube: [".", ":", "+", "*", "#"],
  ellipsis: "...",
  separator: ".",
  dash: "-",
  axis: "->",
});

const alternateScreenEnter = "\u001b[?1049h\u001b[?25l";
const alternateScreenRestore = "\u001b[?25h\u001b[?1049l\u001b[?25h";
const clearScreen = "\u001b[2J\u001b[H";
const inkRenderers = new WeakSet<DashboardRenderer>();

export function rankDashboardSnapshot(
  data: DashboardDataSnapshot,
  server: DashboardServerIdentity,
  previousRanks: ReadonlyMap<string, number> = new Map(),
): DashboardSnapshot {
  const cubes = [...data.cubes]
    .sort((left, right) =>
      right.posts_15m - left.posts_15m ||
      right.distinct_posting_drones_15m - left.distinct_posting_drones_15m ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((cube, index) => {
      const rank = index + 1;
      const previous = previousRanks.get(cube.id);
      return Object.freeze({
        ...cube,
        rank,
        rank_change: previous === undefined ? 0 : previous - rank,
      });
    });
  return Object.freeze({
    captured_at: data.captured_at,
    server: Object.freeze({ ...server }),
    cubes: Object.freeze(cubes),
    attention: data.attention,
    recent_activity: data.recent_activity,
  });
}

export function createDashboardRenderer(options: DashboardRenderOptions): DashboardRenderer {
  const baseFooter = sanitizeTerminalLabel(options.footer);
  const renderer: DashboardRenderer = (snapshot, columns, rows, view = {
    autoFollow: true,
    focusedCubeId: null,
    pulseCubeIds: new Set(),
    pulsePhase: 0,
    activity: new Map(),
    activityWindowMs: DASHBOARD_ACTIVITY_WINDOW_MS,
    page: 0,
    motionMode: options.motionMode ?? "ambient",
    motionAutoDegraded: false,
    ambientPhase: 0,
  }) => {
    if (!usesInkDashboard(columns, rows)) {
      return renderPlainDashboard(snapshot, columns, rows, options.footer);
    }
    return renderInkDashboardFrame(snapshot, columns, rows, view, {
      ...options,
      footer: options.footer,
      baseFooter,
    });
  };
  Object.defineProperty(renderer, "inkOptions", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ ...options, baseFooter }),
    writable: false,
  });
  inkRenderers.add(renderer);
  return renderer;
}

export { renderPlainDashboard } from "./dashboard-plain.js";

export function selectDashboardGlyphMode(input: {
  readonly asciiRequested: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): DashboardGlyphMode {
  if (input.asciiRequested || input.environment["TERM"] === "dumb") return "ascii";
  const locale = input.environment["LC_ALL"] ?? input.environment["LC_CTYPE"] ??
    input.environment["LANG"];
  return locale !== undefined && !/utf-?8/iu.test(locale) ? "ascii" : "box";
}

export function dashboardColorEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment["NO_COLOR"] === undefined && environment["TERM"] !== "dumb";
}

export function resolveDashboardMotionMode(input: {
  readonly noMotion: boolean;
  readonly environment: { readonly BORGMCP_DASHBOARD_MOTION?: string };
}): DashboardMotionMode {
  if (input.noMotion) return "off";
  const configured = input.environment["BORGMCP_DASHBOARD_MOTION"];
  if (configured === undefined || configured === "ambient") return "ambient";
  if (configured === "calm" || configured === "off") return configured;
  throw operatorErrors.DASHBOARD_MOTION_INVALID;
}

function usesInkDashboard(columns: number, rows: number): boolean {
  const width = Math.min(500, Math.max(20, finiteDashboardDimension(columns, 20)));
  const height = Math.min(200, Math.max(4, finiteDashboardDimension(rows, 4)));
  return width >= 40 && height >= 10;
}

function finiteDashboardDimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

export function sanitizeTerminalText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizeTerminalLabel(value: string): string {
  // DashboardFooter structurally limits callers to static copy. This preserves
  // intentional spacing; untrusted terminal text must use sanitizeTerminalText.
  return value
    .normalize("NFC")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B(?:P|X|\^|_)[\s\S]*?\u001B\\/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .trim();
}

export function startForegroundDashboard(input: {
  readonly source: DashboardSnapshotSource;
  readonly server: DashboardServerIdentity;
  readonly terminal: DashboardTerminal;
  readonly renderer: DashboardRenderer;
  readonly fallbackFooter?: DashboardFooter;
  readonly idleRefreshMs?: number;
  readonly eventCoalesceMs?: number;
  readonly resizeDebounceMs?: number;
  readonly pulseFrameMs?: number;
  readonly ambientFrameMs?: number;
  readonly frameBudgetMs?: number;
}): ForegroundDashboard {
  let closed = false;
  let restored = false;
  let priorRanks = new Map<string, number>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let ambientTimer: ReturnType<typeof setTimeout> | undefined;
  let inkInstance: InkInstance | undefined;
  let inkStdout: NodeJS.WriteStream | undefined;
  let autoFollow = true;
  let focusedCubeId: string | null = null;
  let pulseCubeIds = new Set<string>();
  let pulsePhase = 0;
  let activityWindowMs = DASHBOARD_ACTIVITY_WINDOW_MS;
  let page = 0;
  let motionMode = input.renderer.inkOptions?.motionMode ?? "ambient";
  let motionAutoDegraded = false;
  let ambientPhase = 0;
  const activityHistory = new Map<string, DashboardActivitySample[]>();
  const observationHistory: DashboardActivitySample[] = [];
  let previousActivity = new Map<string, {
    readonly posts15m: number;
    readonly lastPostAt: string | null;
  }>();
  let lastSnapshot: DashboardSnapshot | undefined;
  let lastFrame: string | undefined;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });

  const restore = (): void => {
    if (restored) return;
    restored = true;
    try { input.terminal.write(alternateScreenRestore); } catch { /* Best-effort terminal repair. */ }
  };
  const clearTimers = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (eventTimer !== undefined) clearTimeout(eventTimer);
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    if (pulseTimer !== undefined) clearTimeout(pulseTimer);
    if (ambientTimer !== undefined) clearTimeout(ambientTimer);
  };
  let unsubscribeSource = (): void => undefined;
  let unsubscribeResize = (): void => undefined;
  let unsubscribeInput = (): void => undefined;
  const subscribeInput = (): void => {
    if (input.terminal.onInput === undefined) return;
    if (input.terminal.requestInterrupt === undefined) {
      throw new Error("Dashboard input requires interrupt handling.");
    }
    unsubscribeInput = input.terminal.onInput(handleInput);
  };
  const unmountInk = (): void => {
    try { inkInstance?.unmount(); } catch { /* Continue restoring terminal state. */ }
    if (inkStdout !== undefined) flushInkStdout(inkStdout);
    inkInstance = undefined;
    inkStdout = undefined;
  };
  const mountInk = (
    snapshot: DashboardSnapshot,
    dimensions: { readonly columns: number; readonly rows: number },
    view: DashboardViewState,
    options: NonNullable<DashboardRenderer["inkOptions"]>,
  ): void => {
    inkStdout = createInkStdout(input.terminal);
    inkInstance = renderInk(
      createInkDashboardElement(snapshot, dimensions.columns, dimensions.rows, view, options),
      {
        stdout: inkStdout,
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: 0,
        interactive: true,
      },
    );
    flushInkStdout(inkStdout);
  };
  const stop = (): void => {
    if (closed) return;
    closed = true;
    clearTimers();
    try { unsubscribeSource(); } catch { /* Continue restoring terminal state. */ }
    try { unsubscribeResize(); } catch { /* Continue restoring terminal state. */ }
    try { unsubscribeInput(); } catch { /* Continue restoring terminal state. */ }
    unmountInk();
    restore();
  };
  const fail = (error: unknown): void => {
    if (closed) return;
    let fallback: string | undefined;
    try {
      fallback = renderPlainDashboard(
        rankDashboardSnapshot(input.source.read(), input.server),
        input.terminal.dimensions().columns,
        input.terminal.dimensions().rows,
        input.fallbackFooter,
      );
    } catch {
      // Preserve the original rendering failure.
    }
    stop();
    if (fallback !== undefined) {
      try { input.terminal.write(`${fallback}\n`); } catch { /* Output is already unavailable. */ }
    }
    rejectFailure(error);
  };
  const paint = (): void => {
    if (closed || lastSnapshot === undefined) return;
    try {
      const startedAt = performance.now();
      const dimensions = input.terminal.dimensions();
      const view = {
        autoFollow,
        focusedCubeId,
        pulseCubeIds,
        pulsePhase,
        activity: activityHistory,
        observation: observationHistory,
        activityWindowMs,
        page,
        motionMode,
        motionAutoDegraded,
        ambientPhase,
      } satisfies DashboardViewState;
      const inkOptions = inkRenderers.has(input.renderer) ? input.renderer.inkOptions : undefined;
      if (inkOptions !== undefined && usesInkDashboard(dimensions.columns, dimensions.rows)) {
        const frameKey = dashboardFrameKey(lastSnapshot, dimensions, view, inkOptions);
        if (frameKey === lastFrame) return;
        if (inkInstance === undefined || inkStdout === undefined) {
          if (lastFrame !== undefined) input.terminal.write(clearScreen);
          mountInk(lastSnapshot, dimensions, view, inkOptions);
        } else {
          unmountInk();
          mountInk(lastSnapshot, dimensions, view, inkOptions);
        }
        lastFrame = frameKey;
        finishFrame(startedAt, true);
        return;
      }
      if (inkInstance !== undefined || inkStdout !== undefined) unmountInk();
      const frame = input.renderer(lastSnapshot, dimensions.columns, dimensions.rows, view);
      if (frame === lastFrame) return;
      input.terminal.write(`${clearScreen}${frame}`);
      lastFrame = frame;
      finishFrame(startedAt, false);
    } catch (error) {
      fail(error);
    }
  };
  const refresh = (): void => {
    if (closed) return;
    try {
      const snapshot = rankDashboardSnapshot(input.source.read(), input.server, priorRanks);
      const changedCubeIds = snapshot.cubes
        .filter((cube) => {
          const previous = previousActivity.get(cube.id);
          return previous !== undefined && (
            cube.posts_15m > previous.posts15m ||
            (cube.last_post_at !== null && cube.last_post_at !== previous.lastPostAt)
          );
        })
        .map((cube) => cube.id);
      previousActivity = new Map(snapshot.cubes.map((cube) => [
        cube.id,
        { posts15m: cube.posts_15m, lastPostAt: cube.last_post_at },
      ]));
      if (changedCubeIds.length > 0) {
        if (motionMode === "off") {
          pulseCubeIds = new Set();
          pulsePhase = 0;
        } else {
          pulseCubeIds = new Set(changedCubeIds);
          pulsePhase = DASHBOARD_PULSE_PHASES;
          schedulePulse();
        }
      }
      if (motionMode === "calm") ambientPhase += 1;
      priorRanks = new Map(snapshot.cubes.map((cube) => [cube.id, cube.rank]));
      recordDashboardActivity(snapshot, activityHistory, observationHistory, activityWindowMs);
      lastSnapshot = snapshot;
      paint();
    } catch (error) {
      fail(error);
    }
  };
  const scheduleIdle = (): void => {
    idleTimer = setTimeout(() => {
      refresh();
      if (!closed) scheduleIdle();
    }, input.idleRefreshMs ?? DASHBOARD_IDLE_REFRESH_MS);
    // Presentation timers never own process lifetime: the embedded server has
    // its listener, while the standalone viewer's poll source holds one ref.
    idleTimer.unref?.();
  };
  const scheduleEvent = (): void => {
    if (closed || eventTimer !== undefined) return;
    eventTimer = setTimeout(() => {
      eventTimer = undefined;
      refresh();
    }, input.eventCoalesceMs ?? DASHBOARD_EVENT_COALESCE_MS);
    eventTimer.unref?.();
  };
  const scheduleResize = (): void => {
    if (closed) return;
    if (inkRenderers.has(input.renderer)) {
      const dimensions = input.terminal.dimensions();
      if (!usesInkDashboard(dimensions.columns, dimensions.rows) && ambientTimer !== undefined) {
        clearTimeout(ambientTimer);
        ambientTimer = undefined;
      }
      paint();
      scheduleAmbient();
      return;
    }
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      paint();
    }, input.resizeDebounceMs ?? DASHBOARD_RESIZE_DEBOUNCE_MS);
    resizeTimer.unref?.();
  };
  function schedulePulse(): void {
    if (closed || motionMode === "off" || pulseTimer !== undefined) return;
    pulseTimer = setTimeout(() => {
      pulseTimer = undefined;
      pulsePhase = Math.max(0, pulsePhase - 1);
      if (pulsePhase === 0) pulseCubeIds = new Set();
      paint();
      if (!closed && pulsePhase > 0) schedulePulse();
    }, input.pulseFrameMs ?? DASHBOARD_PULSE_FRAME_MS);
    pulseTimer.unref?.();
  }
  function scheduleAmbient(): void {
    if (closed || motionMode !== "ambient" || ambientTimer !== undefined ||
        !inkRenderers.has(input.renderer)) return;
    const dimensions = input.terminal.dimensions();
    if (!usesInkDashboard(dimensions.columns, dimensions.rows)) return;
    ambientTimer = setTimeout(() => {
      ambientTimer = undefined;
      ambientPhase += 1;
      paint();
      scheduleAmbient();
    }, input.ambientFrameMs ?? DASHBOARD_AMBIENT_FRAME_MS);
    ambientTimer.unref?.();
  }
  function finishFrame(startedAt: number, ink: boolean): void {
    if (!ink || motionMode !== "ambient" ||
        performance.now() - startedAt <= (input.frameBudgetMs ?? DASHBOARD_FRAME_BUDGET_MS)) return;
    motionMode = "calm";
    motionAutoDegraded = true;
    if (ambientTimer !== undefined) clearTimeout(ambientTimer);
    ambientTimer = undefined;
    lastFrame = undefined;
    queueMicrotask(paint);
  }
  const navigate = (direction: -1 | 1): void => {
    const cubes = lastSnapshot?.cubes ?? [];
    if (cubes.length === 0) return;
    const currentIndex = autoFollow || focusedCubeId === null
      ? 0
      : Math.max(0, cubes.findIndex((cube) => cube.id === focusedCubeId));
    const nextIndex = (currentIndex + direction + cubes.length) % cubes.length;
    autoFollow = false;
    focusedCubeId = cubes[nextIndex]!.id;
    paint();
  };
  const suspend = (): void => {
    if (input.terminal.requestSuspend === undefined) return;
    unsubscribeInput();
    unsubscribeInput = (): void => undefined;
    if (ambientTimer !== undefined) clearTimeout(ambientTimer);
    ambientTimer = undefined;
    unmountInk();
    lastFrame = undefined;
    input.terminal.write(alternateScreenRestore);
    input.terminal.requestSuspend(() => {
      if (closed) return;
      try {
        input.terminal.write(alternateScreenEnter);
        subscribeInput();
        refresh();
        scheduleAmbient();
      } catch (error) {
        fail(error);
      }
    });
  };
  const handleInput = (value: Uint8Array): void => {
    try {
      for (const byte of value) {
        if (byte === 3) {
          input.terminal.requestInterrupt?.();
          return;
        }
        if (byte === 26) {
          suspend();
          return;
        }
        if (byte === 60) navigate(-1);
        else if (byte === 62) navigate(1);
        else if (byte === 97) {
          autoFollow = true;
          focusedCubeId = null;
          paint();
        } else if (byte === 119) {
          activityWindowMs = activityWindowMs === 5 * 60_000
            ? DASHBOARD_ACTIVITY_WINDOW_MS
            : activityWindowMs === DASHBOARD_ACTIVITY_WINDOW_MS ? 60 * 60_000 : 5 * 60_000;
          paint();
        } else if (byte === 32) {
          page += 1;
          paint();
        }
      }
    } catch (error) {
      fail(error);
    }
  };

  try {
    input.terminal.write(alternateScreenEnter);
    unsubscribeSource = input.source.subscribe(scheduleEvent);
    unsubscribeResize = input.terminal.onResize(scheduleResize);
    subscribeInput();
    refresh();
    if (!closed) scheduleIdle();
    scheduleAmbient();
  } catch (error) {
    stop();
    throw error;
  }
  return Object.freeze({ failure, close: stop });
}

function createInkStdout(terminal: DashboardTerminal): NodeJS.WriteStream {
  let pending = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        pending += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  Object.defineProperties(stream, {
    columns: { configurable: true, enumerable: true, get: () => terminal.dimensions().columns },
    isTTY: { configurable: true, enumerable: true, value: true, writable: false },
    rows: { configurable: true, enumerable: true, get: () => terminal.dimensions().rows },
  });
  Object.defineProperty(stream, "flushInk", {
    configurable: false,
    enumerable: false,
    value: () => {
      if (pending === "") return;
      const value = pending;
      pending = "";
      terminal.write(value);
    },
    writable: false,
  });
  return stream as unknown as NodeJS.WriteStream;
}

function flushInkStdout(stream: NodeJS.WriteStream): void {
  (stream as NodeJS.WriteStream & { readonly flushInk?: () => void }).flushInk?.();
}

// The live Ink route cannot call the synchronous renderer to compare frames:
// renderToString creates a throwaway reconciler tree that is retained by Ink.
// Project the state that can reach the current viewport instead, so invisible
// cube churn does not trigger an unnecessary remount.
function dashboardFrameKey(
  snapshot: DashboardSnapshot,
  dimensions: { readonly columns: number; readonly rows: number },
  view: DashboardViewState,
  options: NonNullable<DashboardRenderer["inkOptions"]>,
): string {
  const width = Math.min(500, Math.max(20, finiteDashboardDimension(dimensions.columns, 20)));
  const height = Math.min(200, Math.max(4, finiteDashboardDimension(dimensions.rows, 4)));
  const lifecycleRows = options.footer === EMBEDDED_DASHBOARD_FOOTER
    ? dashboardLifecycleFooterRows(EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER, width)
    : 0;
  const footerRows = lifecycleRows + 1;
  const bodyRows = Math.max(0, height - (5 + footerRows));
  const desiredFeedRows = snapshot.recent_activity.length === 0 ? 0 : Math.min(
    snapshot.recent_activity.length,
    bodyRows < 10 ? 1 : height >= 36 ? 4 : 3,
  );
  const feedRows = Math.min(desiredFeedRows, Math.max(0, bodyRows - 1));
  const listSpace = Math.max(1, bodyRows - feedRows);
  const minimumPanelRows = Math.min(4, Math.max(1, bodyRows - feedRows));
  const listLimit = Math.max(0, bodyRows - feedRows - minimumPanelRows);
  const desiredListCap = Math.max(
    snapshot.cubes.length > 1 && listSpace >= 4 ? 2 : 1,
    Math.floor(listSpace * 0.42),
  );
  const listCap = Math.min(listLimit, desiredListCap);
  const pageCount = listCap === 0 ? 1 : Math.max(1, Math.ceil(snapshot.cubes.length / listCap));
  const page = Math.max(0, view.page ?? 0) % pageCount;
  const summaryCubes = snapshot.cubes.slice(page * listCap, page * listCap + Math.min(snapshot.cubes.length, listCap));
  const focus = view.autoFollow || view.focusedCubeId === null
    ? snapshot.cubes[0]
    : snapshot.cubes.find((cube) => cube.id === view.focusedCubeId) ?? snapshot.cubes[0];
  const focusActivity = [...(view.activity?.entries() ?? [])]
    .filter(([key]) => focus !== undefined && key.startsWith(`${focus.id}:`))
    .sort(([left], [right]) => left.localeCompare(right));
  const visiblePulseCubeIds = summaryCubes
    .filter((cube) => view.pulseCubeIds.has(cube.id))
    .map((cube) => cube.id)
    .sort();
  const activityWindowMs = view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const panelRows = Math.max(1, bodyRows - Math.min(snapshot.cubes.length, listCap) - feedRows);
  return JSON.stringify({
    kind: "ink-dashboard",
    dimensions: { columns: width, rows: height },
    options,
    snapshot: {
      captured_at: snapshot.captured_at,
      server: snapshot.server,
      cubeCount: snapshot.cubes.length,
      totalPosts: snapshot.cubes.reduce((sum, cube) => sum + cube.posts_15m, 0),
      maximumPosts: Math.max(...snapshot.cubes.map((cube) => cube.posts_15m), 0),
      summaryCubes,
      focus,
      attention: snapshot.attention,
      recentActivity: snapshot.recent_activity.slice(0, feedRows),
    },
    view: {
      autoFollow: view.autoFollow,
      focusedCubeId: view.focusedCubeId,
      pulseCubeIds: visiblePulseCubeIds,
      pulsePhase: visiblePulseCubeIds.length > 0 ? view.pulsePhase : 0,
      activity: focusActivity,
      observation: view.observation ?? [],
      activityWindowMs,
      page,
      motionMode: view.motionMode ?? options.motionMode ?? "ambient",
      motionAutoDegraded: view.motionAutoDegraded === true,
      ambientPhase: panelRows >= 4 ? view.ambientPhase ?? 0 : 0,
    },
  });
}

function dashboardLifecycleFooterRows(value: string, width: number): number {
  const sentences = value.match(/[^.]+(?:\.|$)/gu)?.map((sentence) => sentence.trim()) ?? [value];
  return sentences.reduce((total, sentence) => {
    let rows = 0;
    let current = "";
    for (const word of sentence.split(/\s+/u)) {
      if (current === "" || `${current} ${word}`.length > width) {
        rows += 1;
        current = word;
      } else {
        current = `${current} ${word}`;
      }
    }
    return total + rows;
  }, 0);
}

function recordDashboardActivity(
  snapshot: DashboardSnapshot,
  history: Map<string, DashboardActivitySample[]>,
  observation: DashboardActivitySample[],
  windowMs: number,
): void {
  const capturedAt = Date.parse(snapshot.captured_at);
  if (!Number.isFinite(capturedAt)) return;
  recordActivityBucket(observation, { capturedAt: snapshot.captured_at, sentRate: 0 });
  while (observation.length > 0 && Date.parse(observation[0]!.capturedAt) < capturedAt - Math.max(windowMs, 60 * 60_000)) observation.shift();
  const activeKeys = new Set<string>();
  for (const cube of snapshot.cubes) for (const drone of cube.drones) {
    const key = `${cube.id}:${drone.id}`;
    activeKeys.add(key);
    const samples = history.get(key) ?? [];
    recordActivityBucket(samples, { capturedAt: snapshot.captured_at, sentRate: drone.sent_5s });
    const oldest = capturedAt - Math.max(windowMs, 60 * 60_000);
    while (samples.length > 0 && Date.parse(samples[0]!.capturedAt) < oldest) samples.shift();
    history.set(key, samples);
  }
  for (const key of history.keys()) if (!activeKeys.has(key)) history.delete(key);
}

function recordActivityBucket(
  samples: DashboardActivitySample[],
  sample: DashboardActivitySample,
): void {
  const timestamp = Date.parse(sample.capturedAt);
  if (!Number.isFinite(timestamp)) return;
  const bucket = Math.floor(timestamp / DASHBOARD_IDLE_REFRESH_MS);
  const existing = samples.findIndex((candidate) =>
    Math.floor(Date.parse(candidate.capturedAt) / DASHBOARD_IDLE_REFRESH_MS) === bucket);
  if (existing >= 0) samples[existing] = sample;
  else {
    samples.push(sample);
    samples.sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  }
}
