export const DASHBOARD_ACTIVITY_WINDOW_MS = 15 * 60_000;
export const DASHBOARD_IDLE_REFRESH_MS = 5_000;
export const DASHBOARD_EVENT_COALESCE_MS = 250;
export const DASHBOARD_RESIZE_DEBOUNCE_MS = 125;
export const DASHBOARD_PULSE_FRAME_MS = 125;
const DASHBOARD_PULSE_PHASES = 4;
const DASHBOARD_ACTIVITY_PULSE_MARKERS = [" ", "_", "-", "o", "O"] as const;

export interface DashboardDroneData {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly last_seen: string;
  readonly sent: number;
  readonly sent_5s: number;
  readonly received: number;
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
}

export interface DashboardDataSnapshot {
  readonly captured_at: string;
  readonly cubes: readonly DashboardCubeData[];
}

export interface DashboardSnapshotSource {
  readonly read: () => DashboardDataSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface DashboardServerIdentity {
  readonly name: string;
  readonly version: string;
  readonly endpoint: string;
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
}

export interface DashboardActivitySample {
  readonly capturedAt: string;
  readonly sentRate: number;
}

export type DashboardRenderer = (
  snapshot: DashboardSnapshot,
  columns: number,
  rows: number,
  view?: DashboardViewState,
) => string;

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

interface Glyphs {
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

const BOX_GLYPHS: Glyphs = Object.freeze({
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

const ASCII_GLYPHS: Glyphs = Object.freeze({
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
const amber = "\u001b[33m";
const green = "\u001b[32;1m";
const dim = "\u001b[2m";
const reset = "\u001b[0m";

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
  });
}

export function createDashboardRenderer(options: DashboardRenderOptions): DashboardRenderer {
  const glyphs = options.glyphMode === "ascii" ? ASCII_GLYPHS : BOX_GLYPHS;
  const baseFooter = sanitizeTerminalLabel(options.footer);
  return (snapshot, columns, rows, view = {
    autoFollow: true,
    focusedCubeId: null,
    pulseCubeIds: new Set(),
    pulsePhase: 0,
    activity: new Map(),
    activityWindowMs: DASHBOARD_ACTIVITY_WINDOW_MS,
    page: 0,
  }) => {
    const width = boundedDimension(columns, 20, 500);
    const height = boundedDimension(rows, 4, 200);
    if (width < 40 || height < 10) {
      return renderPlainDashboard(
        snapshot,
        width,
        height,
        options.footer,
      );
    }
    const lifecycleFooter = options.footer === EMBEDDED_DASHBOARD_FOOTER
      ? wrapDashboardFooter(EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER, width)
      : [];

    const lines: string[] = [];
    lines.push(renderRail(snapshot, width, glyphs, options.color));
    lines.push(glyphs.horizontal.repeat(width));
    const focus = view.autoFollow || view.focusedCubeId === null
      ? snapshot.cubes[0]
      : snapshot.cubes.find((cube) => cube.id === view.focusedCubeId) ?? snapshot.cubes[0];
    const maximumPosts = Math.max(...snapshot.cubes.map((cube) => cube.posts_15m), 0);
    const footerRows = lifecycleFooter.length + 1;
    const chromeRows = 3 + footerRows;
    const bodyRows = Math.max(0, height - chromeRows);
    const listCap = Math.max(1, Math.floor(bodyRows * 0.42));
    const listRows = Math.min(snapshot.cubes.length, listCap);
    const panelRows = Math.max(1, bodyRows - listRows);
    if (focus === undefined) {
      lines.push(...renderEmptyPanel(width, glyphs));
    } else {
      lines.push(...renderFocusPanel(snapshot, focus, width, panelRows, glyphs, view, options.color));
    }
    lines.push(glyphs.horizontal.repeat(width));
    const pageCount = Math.max(1, Math.ceil(snapshot.cubes.length / listCap));
    const page = Math.max(0, view.page ?? 0) % pageCount;
    const pageStart = page * listCap;
    for (const cube of snapshot.cubes.slice(pageStart, pageStart + listRows)) {
      lines.push(renderSummaryRow(snapshot, cube, width, glyphs, view, maximumPosts, options.color));
    }
    const footerWithPage = renderDashboardFooter(
      snapshot,
      width,
      options.navigation === true,
      view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS,
      page,
      pageCount,
      baseFooter,
      glyphs,
    );
    lines.push(...lifecycleFooter.map((line) => fitCell(line, width, " ", glyphs.ellipsis)));
    lines.push(footerWithPage);
    return lines.slice(0, height)
      .map((line) => fitCell(line, width, " ", glyphs.ellipsis))
      .join("\n");
  };
}

function renderDashboardFooter(
  snapshot: DashboardSnapshot,
  width: number,
  navigation: boolean,
  activityWindowMs: number,
  page: number,
  pageCount: number,
  baseFooter: string,
  glyphs: Glyphs,
): string {
  const pageSegment = pageCount > 1
    ? `${navigation ? "SPACE " : "page "}${page + 1}/${pageCount}`
    : undefined;
  const segments = navigation
    ? [
        ...(snapshot.cubes.length > 1 ? ["< > switch  |  a auto"] : []),
        ...(pageSegment === undefined ? [] : [pageSegment]),
        `w ${formatWindow(activityWindowMs)}`,
        baseFooter,
      ]
    : [
        ...(pageSegment === undefined ? [] : [pageSegment]),
        baseFooter,
      ];
  while (segments.length > 1 && displayWidth(segments.join("  |  ")) > width) segments.shift();
  return fitCell(segments.join("  |  "), width, " ", glyphs.ellipsis);
}

function wrapDashboardFooter(value: string, width: number): string[] {
  const sentences = value.match(/[^.]+(?:\.|$)/gu)?.map((sentence) => sentence.trim()) ?? [value];
  return sentences.flatMap((sentence) => {
    const lines: string[] = [];
    for (const word of sentence.split(/\s+/u)) {
      const current = lines.at(-1);
      if (current === undefined || displayWidth(`${current} ${word}`) > width) {
        lines.push(word);
      } else {
        lines[lines.length - 1] = `${current} ${word}`;
      }
    }
    return lines;
  });
}

export function renderPlainDashboard(
  snapshot: DashboardSnapshot,
  columns = 80,
  rows = 20,
  footer?: DashboardFooter,
): string {
  const width = boundedDimension(columns, 20, 500);
  const height = boundedDimension(rows, 4, 200);
  const totalPosts = snapshot.cubes.reduce((sum, cube) => sum + cube.posts_15m, 0);
  const lines = [
    fitCell(
      `${sanitizeTerminalText(snapshot.server.name)} ${snapshot.server.state} ` +
      `${sanitizeTerminalText(snapshot.server.endpoint)}`,
      width,
      " ",
      ASCII_GLYPHS.ellipsis,
    ),
    fitCell(
      `${snapshot.cubes.length} cubes | ${totalPosts} posts/15m`,
      width,
      " ",
      ASCII_GLYPHS.ellipsis,
    ),
    ...renderPlainDashboardFooter(footer, width),
  ];
  const available = Math.max(0, height - lines.length);
  for (const cube of snapshot.cubes.slice(0, available)) {
    lines.push(fitCell(
      `${cube.rank}. ${sanitizeTerminalText(cube.name)} ` +
      `${cube.posts_15m}/15m ${formatAge(snapshot.captured_at, cube.last_post_at)}`,
      width,
      " ",
      ASCII_GLYPHS.ellipsis,
    ));
  }
  return lines.join("\n");
}

function renderPlainDashboardFooter(footer: DashboardFooter | undefined, width: number): string[] {
  if (footer === EMBEDDED_DASHBOARD_FOOTER) {
    return [
      width >= 60
        ? "Press Ctrl-C or close this terminal to stop the server."
        : width >= 38 ? "Ctrl-C or close terminal stops server." : "Ctrl-C stops server.",
      width >= 60
        ? "Your server data and identity remain saved. Read-only view."
        : width >= 44 ? "Data and identity saved. Read-only view."
        : width >= 33 ? "Data saved. Read-only view." : "Saved. Read-only.",
    ];
  }
  if (footer === STANDALONE_DASHBOARD_FOOTER) {
    return width >= 35
      ? ["Ctrl-C closes this viewer.", "Server stays up. View is read-only."]
      : ["Ctrl-C closes viewer", "Read-only, server up"];
  }
  return [];
}

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
}): ForegroundDashboard {
  let closed = false;
  let restored = false;
  let priorRanks = new Map<string, number>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let autoFollow = true;
  let focusedCubeId: string | null = null;
  let pulseCubeIds = new Set<string>();
  let pulsePhase = 0;
  let activityWindowMs = DASHBOARD_ACTIVITY_WINDOW_MS;
  let page = 0;
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
  const stop = (): void => {
    if (closed) return;
    closed = true;
    clearTimers();
    try { unsubscribeSource(); } catch { /* Continue restoring terminal state. */ }
    try { unsubscribeResize(); } catch { /* Continue restoring terminal state. */ }
    try { unsubscribeInput(); } catch { /* Continue restoring terminal state. */ }
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
      const dimensions = input.terminal.dimensions();
      const frame = input.renderer(lastSnapshot, dimensions.columns, dimensions.rows, {
        autoFollow,
        focusedCubeId,
        pulseCubeIds,
        pulsePhase,
        activity: activityHistory,
        observation: observationHistory,
        activityWindowMs,
        page,
      });
      if (frame === lastFrame) return;
      input.terminal.write(`${clearScreen}${frame}`);
      lastFrame = frame;
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
        pulseCubeIds = new Set(changedCubeIds);
        pulsePhase = DASHBOARD_PULSE_PHASES;
        schedulePulse();
      }
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
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      paint();
    }, input.resizeDebounceMs ?? DASHBOARD_RESIZE_DEBOUNCE_MS);
    resizeTimer.unref?.();
  };
  function schedulePulse(): void {
    if (closed || pulseTimer !== undefined) return;
    pulseTimer = setTimeout(() => {
      pulseTimer = undefined;
      pulsePhase = Math.max(0, pulsePhase - 1);
      if (pulsePhase === 0) pulseCubeIds = new Set();
      paint();
      if (!closed && pulsePhase > 0) schedulePulse();
    }, input.pulseFrameMs ?? DASHBOARD_PULSE_FRAME_MS);
    pulseTimer.unref?.();
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
    input.terminal.write(alternateScreenRestore);
    input.terminal.requestSuspend(() => {
      if (closed) return;
      try {
        input.terminal.write(alternateScreenEnter);
        lastFrame = undefined;
        subscribeInput();
        refresh();
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
  } catch (error) {
    stop();
    throw error;
  }
  return Object.freeze({ failure, close: stop });
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
  for (const cube of snapshot.cubes) for (const drone of cube.drones) {
    const key = `${cube.id}:${drone.id}`;
    const samples = history.get(key) ?? [];
    recordActivityBucket(samples, { capturedAt: snapshot.captured_at, sentRate: drone.sent_5s });
    const oldest = capturedAt - Math.max(windowMs, 60 * 60_000);
    while (samples.length > 0 && Date.parse(samples[0]!.capturedAt) < oldest) samples.shift();
    history.set(key, samples);
  }
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

function renderRail(
  snapshot: DashboardSnapshot,
  width: number,
  glyphs: Glyphs,
  color: boolean,
): string {
  const identity = sanitizeTerminalText(snapshot.server.name).toUpperCase();
  const version = sanitizeTerminalText(snapshot.server.version);
  const endpoint = sanitizeTerminalText(snapshot.server.endpoint);
  const uptime = formatUptime(snapshot.captured_at, snapshot.server.started_at);
  const totalPosts = snapshot.cubes.reduce((sum, cube) => sum + cube.posts_15m, 0);
  const state = snapshot.server.state.toUpperCase();
  const body = `${glyphs.rail}${glyphs.rail} ${identity} ${glyphs.rail}${glyphs.rail} ` +
    `${state}  ${snapshot.cubes.length} ${plural(snapshot.cubes.length, "cube")}  ${totalPosts}/15m  ` +
    `${endpoint}  v${version}`;
  const uptimeSuffix = `  up ${uptime}`;
  const line = `${fitCell(
    body,
    Math.max(0, width - displayWidth(uptimeSuffix)),
    " ",
    glyphs.ellipsis,
  )}${uptimeSuffix}`;
  if (!color) return line;
  const brand = `${glyphs.rail}${glyphs.rail} ${identity} ${glyphs.rail}${glyphs.rail}`;
  return line
    .replace(brand, `${amber}${brand}${reset}`)
    .replace(state, `${green}${state}${reset}`);
}

function renderFocusPanel(
  snapshot: DashboardSnapshot,
  cube: DashboardCubeSnapshot,
  width: number,
  rows: number,
  glyphs: Glyphs,
  view: DashboardViewState,
  color: boolean,
): string[] {
  const inner = Math.max(1, width - 2);
  if (rows < 4) {
    return [fitCell(
      `${sanitizeTerminalText(cube.name)} ${glyphs.dash} ${cube.drones.length} ${plural(cube.drones.length, "drone")} ${glyphs.separator} activity panel needs a taller terminal`,
      width,
      " ",
      glyphs.ellipsis,
    )];
  }
  const window = view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const mode = view.autoFollow || view.focusedCubeId === null ? "(auto)" : "(pinned)";
  const title = ` ${sanitizeTerminalText(cube.name)} ${glyphs.separator} ${mode} ${glyphs.separator} DRONE ACTIVITY ${glyphs.separator} ${formatWindow(window)} ago ${glyphs.axis} now `;
  const top = glyphs.topLeft + title + glyphs.horizontal.repeat(Math.max(0, inner - displayWidth(title))) + glyphs.topRight;
  const contentRows = rows - 2;
  const coverage = activityCoverage(view.observation ?? [], snapshot.captured_at, window);
  const maximumActivityRate = activityRateMaximum(cube, view.activity);
  const collecting = coverage < 1;
  const reserveNotes = collecting ? 1 : 0;
  const bandHeight = ([3, 2, 1] as const).find((candidate) =>
    cube.drones.length <= Math.floor((contentRows - reserveNotes) / candidate)) ?? 1;
  const allFit = cube.drones.length <= Math.floor((contentRows - reserveNotes) / bandHeight);
  const visible = allFit
    ? cube.drones.length
    : Math.max(1, Math.floor((contentRows - reserveNotes - 1) / bandHeight));
  const drones = cube.drones.slice(0, visible);
  const lines = drones.flatMap((drone) => renderDroneBand(
    drone,
    snapshot.captured_at,
    inner,
    bandHeight,
    view.activity?.get(`${cube.id}:${drone.id}`) ?? [],
    window,
    maximumActivityRate,
    glyphs,
    color,
  ));
  const hidden = Math.max(0, cube.drones.length - drones.length);
  if (hidden > 0 && lines.length < contentRows) lines.push(fitCell(` +${hidden} more drones ${glyphs.dash} taller terminal shows them`, inner, " ", glyphs.ellipsis));
  if (collecting && lines.length < contentRows) {
    lines.push(fitCell(
      ` collecting ${glyphs.dash} ${Math.round(coverage * 100)}% of ${formatWindow(window)} observed`,
      inner,
      " ",
      glyphs.ellipsis,
    ));
  }
  while (lines.length < contentRows) lines.push(" ".repeat(inner));
  return [top, ...lines.slice(0, contentRows).map((line) => `${glyphs.vertical}${fitCell(line, inner, " ", glyphs.ellipsis)}${glyphs.vertical}`), `${glyphs.bottomLeft}${glyphs.horizontal.repeat(inner)}${glyphs.bottomRight}`];
}

function renderDroneBand(
  drone: DashboardDroneData,
  capturedAt: string,
  width: number,
  height: number,
  samples: readonly DashboardActivitySample[],
  windowMs: number,
  maximumActivityRate: number,
  glyphs: Glyphs,
  color: boolean,
): string[] {
  const label = fitCell(sanitizeTerminalText(drone.label), Math.max(8, Math.floor(width * 0.32)), " ", glyphs.ellipsis).trimEnd();
  const role = fitCell(sanitizeTerminalText(drone.role), Math.max(4, Math.floor(width * 0.12)), " ", glyphs.ellipsis).trimEnd();
  const last = formatAge(capturedAt, drone.last_seen);
  if (height === 1) {
    const prefix = `${label} ${drone.sent} ${last} `;
    return colorizeDashboardLines([
      fitCell(`${prefix}${renderActivityGraph(samples, Math.max(4, width - displayWidth(prefix)), 1, windowMs, capturedAt, glyphs, maximumActivityRate)}`, width, " ", glyphs.ellipsis),
    ], capturedAt, drone.last_seen, color);
  }
  const identity = height >= 3
    ? `${label} ${role}  SENT ${drone.sent}  RECV ${drone.received}  LAST ${last}`
    : `${label} ${role}  SENT ${drone.sent}  LAST ${last}`;
  return colorizeDashboardLines([
    fitCell(identity, width, " ", glyphs.ellipsis),
    ...Array.from({ length: height - 1 }, (_unused, index) =>
      renderActivityGraph(samples, width, height - 1, windowMs, capturedAt, glyphs, maximumActivityRate, index)),
  ], capturedAt, drone.last_seen, color);
}

function renderActivityGraph(
  samples: readonly DashboardActivitySample[],
  width: number,
  height: number,
  windowMs: number,
  capturedAt: string,
  glyphs: Glyphs,
  maximumActivityRate: number,
  row = 0,
): string {
  const slots = activitySlots(samples, capturedAt, windowMs);
  const graph = Array.from({ length: width }, (_unused, columnIndex) => {
    const startSlot = Math.floor(columnIndex * slots.total / width);
    const endSlot = Math.max(startSlot + 1, Math.floor((columnIndex + 1) * slots.total / width));
    const sample = [...slots.entries()].find(([slot]) => slot >= startSlot && slot < endSlot)?.[1];
    if (sample === undefined) return " ";
    if (sample.sentRate <= 0 || maximumActivityRate <= 0) return glyphs.cube[0]!;
    const level = Math.ceil((sample.sentRate / maximumActivityRate) * (height * 8)) - ((height - row - 1) * 8);
    if (level <= 0) return " ";
    return magnitudeGlyph(level, height * 8, glyphs);
  }).join("");
  return graph;
}

function activityRateMaximum(
  cube: DashboardCubeSnapshot,
  activity: ReadonlyMap<string, readonly DashboardActivitySample[]> | undefined,
): number {
  let maximum = 0;
  for (const drone of cube.drones) {
    for (const sample of activity?.get(`${cube.id}:${drone.id}`) ?? []) {
      maximum = Math.max(maximum, sample.sentRate);
    }
  }
  return maximum;
}

function activityCoverage(samples: readonly DashboardActivitySample[], capturedAt: string, windowMs: number): number {
  const slots = activitySlots(samples, capturedAt, windowMs);
  return slots.size / slots.total;
}

function activitySlots(samples: readonly DashboardActivitySample[], capturedAt: string, windowMs: number): (Map<number, DashboardActivitySample> & { total: number }) {
  const end = Date.parse(capturedAt);
  const start = end - windowMs;
  const buckets = new Map<number, DashboardActivitySample>() as Map<number, DashboardActivitySample> & { total: number };
  buckets.total = Math.max(1, Math.ceil(windowMs / DASHBOARD_IDLE_REFRESH_MS));
  for (const sample of samples) {
    const timestamp = Date.parse(sample.capturedAt);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
    const bucket = Math.min(buckets.total - 1, Math.floor((timestamp - start) / DASHBOARD_IDLE_REFRESH_MS));
    buckets.set(bucket, sample);
  }
  return buckets;
}

function formatWindow(windowMs: number): string { return `${Math.floor(windowMs / 60_000)}m`; }

function renderEmptyPanel(width: number, glyphs: Glyphs): string[] {
  const inner = Math.max(1, width - 2);
  return [
    `${glyphs.topLeft}${glyphs.horizontal.repeat(inner)}${glyphs.topRight}`,
    `${glyphs.vertical}${fitCell(" No cubes yet. Activity will appear here.", inner, " ", glyphs.ellipsis)}${glyphs.vertical}`,
    `${glyphs.bottomLeft}${glyphs.horizontal.repeat(inner)}${glyphs.bottomRight}`,
  ];
}

function renderSummaryRow(
  snapshot: DashboardSnapshot,
  cube: DashboardCubeSnapshot,
  width: number,
  glyphs: Glyphs,
  view: DashboardViewState,
  maximumPosts: number,
  color: boolean,
): string {
  const pulse = activityPulseMarker(view.pulsePhase);
  const pulseMarker = view.pulseCubeIds.has(cube.id) ? pulse : " ";
  const rank = rankMarker(cube.rank_change);
  const heat = heatGlyph(cube.posts_15m, maximumPosts, glyphs);
  let line: string;
  if (width < 60) {
    const nameWidth = Math.max(6, width - 32);
    line = `${heat} ${String(cube.rank).padStart(3)} ` +
      `${fitCell(sanitizeTerminalText(cube.name), nameWidth, " ", glyphs.ellipsis)} ` +
      `${String(cube.posts_15m).padStart(4)}/15m ` +
      `${formatAge(snapshot.captured_at, cube.last_post_at).padStart(5)} ${pulseMarker} ${rank}`;
  } else {
    const nameWidth = Math.max(10, width - 54);
    line = `${heat} ${String(cube.rank).padStart(3)} ` +
      `${fitCell(sanitizeTerminalText(cube.name), nameWidth, " ", glyphs.ellipsis)} ` +
      `${String(cube.drones_seen_15m).padStart(3)}/${String(cube.drones_total).padEnd(3)} seen ` +
      `${String(cube.posts_15m).padStart(4)}/15m ` +
      `${String(cube.distinct_posting_drones_15m).padStart(3)} ${plural(cube.distinct_posting_drones_15m, "poster")} ` +
      `${formatAge(snapshot.captured_at, cube.last_post_at).padStart(6)} ${pulseMarker} ${rank}`;
  }
  return colorizeDashboardLines([fitCell(line, width, " ", glyphs.ellipsis)], snapshot.captured_at, cube.last_post_at, color)[0]!;
}

function heatGlyph(posts: number, maximumPosts: number, glyphs: Glyphs): string {
  if (posts <= 0 || maximumPosts <= 0) return glyphs.cube[0]!;
  return magnitudeGlyph(posts, maximumPosts, glyphs);
}

function activityPulseMarker(phase: number): string {
  const boundedPhase = Math.max(
    0,
    Math.min(DASHBOARD_PULSE_PHASES, Math.floor(phase)),
  );
  return DASHBOARD_ACTIVITY_PULSE_MARKERS[boundedPhase]!;
}

function rankMarker(delta: number): string {
  if (delta === 0) return "  ";
  return `${delta > 0 ? "^" : "v"}${Math.min(9, Math.abs(delta))}`;
}

function magnitudeGlyph(level: number, maximumLevel: number, glyphs: Glyphs): string {
  if (level <= 0 || maximumLevel <= 0) return glyphs.cube[0]!;
  const index = Math.min(
    glyphs.cube.length - 1,
    Math.max(1, Math.ceil((level / maximumLevel) * (glyphs.cube.length - 1))),
  );
  return glyphs.cube[index]!;
}

function colorizeDashboardLines(
  lines: readonly string[],
  capturedAt: string,
  lastActivity: string | null,
  color: boolean,
): string[] {
  if (!color) return [...lines];
  const style = dashboardLivenessStyle(capturedAt, lastActivity);
  return style === "" ? [...lines] : lines.map((line) => `${style}${line}${reset}`);
}

function dashboardLivenessStyle(capturedAt: string, lastActivity: string | null): string {
  if (lastActivity === null) return dim;
  const age = Date.parse(capturedAt) - Date.parse(lastActivity);
  if (!Number.isFinite(age) || age >= 60 * 60_000) return dim;
  if (age < 60_000) return green;
  if (age < 15 * 60_000) return amber;
  return "";
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function formatAge(capturedAt: string, timestamp: string | null): string {
  if (timestamp === null) return "never";
  const age = Math.max(0, Date.parse(capturedAt) - Date.parse(timestamp));
  if (!Number.isFinite(age)) return "unknown";
  if (age < 60_000) return "<1m";
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 24 * 60 * 60_000) return `${Math.floor(age / (60 * 60_000))}h`;
  return `${Math.floor(age / (24 * 60 * 60_000))}d`;
}

function formatUptime(capturedAt: string, startedAt: string): string {
  const elapsed = Math.max(0, Date.parse(capturedAt) - Date.parse(startedAt));
  if (!Number.isFinite(elapsed)) return "unknown";
  if (elapsed < 60_000) return "<1m";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m`;
  const hours = Math.floor(elapsed / (60 * 60_000));
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}

function fitCell(
  value: string,
  width: number,
  fill: string,
  ellipsis: string,
): string {
  if (displayWidth(value) <= width) return value + fill.repeat(width - displayWidth(value));
  const suffix = width >= 4 ? (fill === " " ? ellipsis : fill) : "";
  const target = Math.max(0, width - displayWidth(suffix));
  let result = "";
  for (const character of value) {
    if (displayWidth(result + character) > target) break;
    result += character;
  }
  return result + suffix + fill.repeat(Math.max(0, width - displayWidth(result + suffix)));
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")) {
    const code = character.codePointAt(0)!;
    if (/\p{Mark}/u.test(character)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function boundedDimension(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
