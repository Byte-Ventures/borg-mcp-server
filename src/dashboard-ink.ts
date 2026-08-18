import { createElement as h, type ReactNode } from "react";
import {
  Box,
  renderToString,
  Text,
} from "ink";
import stringWidth from "string-width";

import {
  ASCII_GLYPHS,
  BOX_GLYPHS,
  DASHBOARD_ACTIVITY_WINDOW_MS,
  EMBEDDED_DASHBOARD_FOOTER,
  EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER,
  sanitizeTerminalText,
  type DashboardActivitySample,
  type DashboardColorDepth,
  type DashboardCubeSnapshot,
  type DashboardDroneData,
  type DashboardRenderOptions,
  type DashboardSnapshot,
  type DashboardViewState,
  type Glyphs,
} from "./dashboard.js";

export interface InkRenderOptions extends DashboardRenderOptions {
  readonly baseFooter: string;
}

type InkTextStyle = { readonly sequence?: string };

interface NightwatchPalette {
  readonly background: string;
  readonly backgroundColor: string;
  readonly chrome: string;
  readonly chromeColor: string;
  readonly data: string;
  readonly liveness: string;
  readonly attention: string;
  readonly muted: string;
  readonly inactive: string;
}

const DASHBOARD_PULSE_PHASES = 4;
const DASHBOARD_ACTIVITY_PULSE_MARKERS = [" ", "_", "-", "o", "O"] as const;
const reset = "\u001b[0m";

/**
 * The public renderer stays synchronous for the frame oracle. Every visible
 * section below is an Ink component; renderToString is only the synchronous
 * adapter used by the renderer and by the standalone capture harness.
 */
export function renderInkDashboardFrame(
  snapshot: DashboardSnapshot,
  columns: number,
  rows: number,
  view: DashboardViewState,
  options: InkRenderOptions,
): string {
  const width = Math.min(500, Math.max(20, finiteDimension(columns, 20)));
  const height = Math.min(200, Math.max(4, finiteDimension(rows, 4)));
  const rendered = renderToString(
    createInkDashboardElement(snapshot, width, height, view, options),
    { columns: width },
  );
  const palette = nightwatchPalette(options.color ? options.colorDepth ?? "ansi16" : "none");
  return normalizeInkFrame(rendered, width, height, palette.background, palette.chrome);
}

export function createInkDashboardElement(
  snapshot: DashboardSnapshot,
  width: number,
  height: number,
  view: DashboardViewState,
  options: InkRenderOptions,
): ReactNode {
  return h(InkDashboard, { snapshot, width, height, view, options });
}

function InkDashboard(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly height: number;
  readonly view: DashboardViewState;
  readonly options: InkRenderOptions;
}): ReactNode {
  const { snapshot, width, height, view, options } = input;
  const palette = nightwatchPalette(options.color ? options.colorDepth ?? "ansi16" : "none");
  const focus = view.autoFollow || view.focusedCubeId === null
    ? snapshot.cubes[0]
    : snapshot.cubes.find((cube) => cube.id === view.focusedCubeId) ?? snapshot.cubes[0];
  const glyphs = options.glyphMode === "ascii" ? ASCII_GLYPHS : BOX_GLYPHS;
  if (height < 12) {
    return h(InkCompactDashboard, { snapshot, focus, width, height, view, options, glyphs });
  }
  const lifecycleRows = options.footer === EMBEDDED_DASHBOARD_FOOTER
    ? lifecycleFooterRows(EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER, width)
    : 0;
  const maximumPosts = Math.max(...snapshot.cubes.map((cube) => cube.posts_15m), 0);
  const footerRows = lifecycleRows + 1;
  const chromeRows = 5 + footerRows;
  const bodyRows = Math.max(0, height - chromeRows);
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
  const listRows = Math.min(snapshot.cubes.length, listCap);
  const panelRows = Math.max(1, bodyRows - listRows - feedRows);
  const pageCount = listCap === 0 ? 1 : Math.max(1, Math.ceil(snapshot.cubes.length / listCap));
  const page = Math.max(0, view.page ?? 0) % pageCount;
  const pageStart = page * listCap;

  const children: ReactNode[] = [
    h(InkRail, { key: "rail", snapshot, width, glyphs, palette }),
    h(InkBindStatus, { key: "bind", snapshot, width, glyphs, palette }),
    h(InkAttention, { key: "attention", snapshot, width, glyphs, palette }),
    h(InkRule, { key: "separator-top", width, glyphs, palette }),
    focus === undefined
      ? h(InkEmptyPanel, { key: "empty-panel", width, glyphs, palette })
      : h(InkFocusPanel, {
          key: "focus-panel",
          snapshot,
          cube: focus,
          width,
          rows: panelRows,
          glyphs,
          view,
          palette,
        }),
    h(InkRule, { key: "separator-bottom", width, glyphs, palette }),
  ];

  snapshot.recent_activity.slice(0, feedRows).forEach((activity, index) => {
    children.push(h(InkFeedRow, {
      key: `feed-${activity.id}`,
      snapshot,
      activity,
      width,
      glyphs,
      palette,
      showClass: width >= 100,
      first: index === 0,
    }));
  });
  for (const [index, cube] of snapshot.cubes.slice(pageStart, pageStart + listRows).entries()) {
    children.push(h(InkSummaryRow, {
      key: `summary-${index}`,
      snapshot,
      cube,
      width,
      glyphs,
      view,
      maximumPosts,
      palette,
    }));
  }
  if (lifecycleRows > 0) {
    children.push(h(InkLifecycleFooter, {
      key: "lifecycle",
      value: EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER,
      width,
      rows: lifecycleRows,
      palette,
    }));
  }
  children.push(h(InkFooter, {
    key: "footer",
    snapshot,
    width,
    navigation: options.navigation === true,
    activityWindowMs: view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS,
    page,
    pageCount,
    baseFooter: options.baseFooter,
    ellipsis: glyphs.ellipsis,
    motionMode: view.motionMode ?? options.motionMode ?? "ambient",
    motionAutoDegraded: view.motionAutoDegraded === true,
    palette,
  }));

  return h(Box, {
    width,
    height,
    flexDirection: "column",
    overflow: "hidden",
    ...(palette.backgroundColor === "" ? {} : { backgroundColor: palette.backgroundColor }),
  }, children);
}

function InkCompactDashboard(input: {
  readonly snapshot: DashboardSnapshot;
  readonly focus: DashboardCubeSnapshot | undefined;
  readonly width: number;
  readonly height: number;
  readonly view: DashboardViewState;
  readonly options: InkRenderOptions;
  readonly glyphs: Glyphs;
}): ReactNode {
  const palette = nightwatchPalette(
    input.options.color ? input.options.colorDepth ?? "ansi16" : "none",
  );
  const lifecycleRows = input.options.footer === EMBEDDED_DASHBOARD_FOOTER ? 1 : 0;
  const bodyRows = Math.max(1, input.height - 5 - lifecycleRows);
  const children: ReactNode[] = [
    h(InkRail, { key: "rail", snapshot: input.snapshot, width: input.width, glyphs: input.glyphs, palette }),
    h(InkAttention, { key: "attention", snapshot: input.snapshot, width: input.width, glyphs: input.glyphs, palette }),
    h(InkRule, { key: "separator-top", width: input.width, glyphs: input.glyphs, palette }),
    input.focus === undefined
      ? h(InkEmptyCompactDeck, { key: "empty", width: input.width, rows: bodyRows })
      : h(InkCompactDeck, {
          key: "deck",
          snapshot: input.snapshot,
          cube: input.focus,
          width: input.width,
          rows: bodyRows,
          glyphs: input.glyphs,
          view: input.view,
          palette,
        }),
    h(InkRule, { key: "separator-bottom", width: input.width, glyphs: input.glyphs, palette }),
    lifecycleRows > 0
      ? h(InkLifecycleFooter, {
          key: "lifecycle",
          value: "Server data and identity remain saved.",
          width: input.width,
          rows: lifecycleRows,
          palette,
        })
      : null,
    h(InkFooter, {
      key: "footer",
      snapshot: input.snapshot,
      width: input.width,
      navigation: false,
      activityWindowMs: input.view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS,
      page: 0,
      pageCount: 1,
      baseFooter: input.options.baseFooter,
      ellipsis: input.glyphs.ellipsis,
      motionMode: input.view.motionMode ?? input.options.motionMode ?? "ambient",
      motionAutoDegraded: input.view.motionAutoDegraded === true,
      palette,
    }),
  ];
  return h(Box, {
    width: input.width,
    height: input.height,
    flexDirection: "column",
    overflow: "hidden",
    ...(palette.backgroundColor === "" ? {} : { backgroundColor: palette.backgroundColor }),
  }, children);
}

function InkEmptyCompactDeck(input: { readonly width: number; readonly rows: number }): ReactNode {
  return h(Box, { width: input.width, height: input.rows, overflow: "hidden" },
    h(Text, null, "No cubes yet."));
}

function InkCompactDeck(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const windowMs = input.view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const mode = input.view.autoFollow || input.view.focusedCubeId === null ? "(auto)" : "(pinned)";
  const prefix = `SCOPE ${dashboardText(input.cube.name, input.glyphs)} ${input.glyphs.separator} ${mode} `;
  const suffix = ` ${formatWindow(windowMs)}`;
  const graphWidth = Math.max(1, input.width - terminalCellWidth(prefix) - terminalCellWidth(suffix));
  const samples = aggregateActivitySamples(input.cube, input.view.activity);
  const maximum = scopeActivityScale(samples);
  const phase = scopeSweepPosition(
    graphWidth,
    input.view.ambientPhase ?? 0,
    input.view.motionMode ?? "ambient",
  );
  const graph = overlayScopeSweep(
    graphText(samples, graphWidth, 1, windowMs, input.snapshot.captured_at, input.glyphs, maximum),
    phase,
    scopeSweepGlyph(input.glyphs),
  ).replaceAll(" ", input.glyphs.cube[0]!);
  const available = Math.max(0, input.rows - 1);
  const prioritized = prioritizeDrones(input.snapshot.captured_at, input.cube.drones);
  const visible = prioritized.slice(0, Math.max(1, available - 1));
  const hidden = Math.max(0, input.cube.drones.length - visible.length);
  const lines: ReactNode[] = [
    h(Text, { key: "scope", wrap: "truncate-end" }, truncateCell(
      `${prefix}${graph}${suffix}`,
      input.width,
      input.glyphs.ellipsis,
    )),
    ...visible.map((drone) => h(InkDroneCell, {
      key: drone.id,
      drone,
      capturedAt: input.snapshot.captured_at,
      width: input.width,
      glyphs: input.glyphs,
      palette: input.palette,
      detailed: false,
    })),
  ];
  if (hidden > 0 && lines.length < input.rows) {
    lines.push(h(Text, { key: "hidden" }, `+${hidden} more drones`));
  }
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, lines);
}

function InkAttention(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const attention = input.snapshot.attention;
  let value = "ATTN 0";
  if (attention.unacked_directed > 0) {
    const oldest = attention.oldest_unacked;
    const age = oldest === null ? "unknown" : formatAge(input.snapshot.captured_at, oldest.created_at);
    const origin = oldest === null ? "" :
      ` ${dashboardText(oldest.cube_name, input.glyphs)}/${dashboardText(oldest.recipient_label, input.glyphs)}`;
    value = attention.stale_directed > 0
      ? `>> ATTN STALE ${attention.stale_directed}  unacked ${attention.unacked_directed}  oldest ${age}${origin}`
      : `ATTN PENDING ${attention.unacked_directed}  oldest ${age}${origin}`;
  }
  const active = input.palette.attention !== "" && attention.unacked_directed > 0;
  const visible = truncateCell(value, input.width, input.glyphs.ellipsis);
  const rendered = active
    ? `\u001b[7m${attention.stale_directed > 0 ? input.palette.attention : input.palette.liveness}${visible}${reset}`
    : styledText(visible, { sequence: input.palette.muted });
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, rendered));
}

function InkRail(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const { snapshot, width, glyphs, palette } = input;
  const identity = sanitizeTerminalText(snapshot.server.name).toUpperCase();
  const version = sanitizeTerminalText(snapshot.server.version);
  const uptime = formatUptime(snapshot.captured_at, snapshot.server.started_at);
  const totalPosts = snapshot.cubes.reduce((sum, cube) => sum + cube.posts_15m, 0);
  const state = snapshot.server.state.toUpperCase();
  const brand = `${glyphs.rail}${glyphs.rail} ${identity} ${glyphs.rail}${glyphs.rail}`;
  const body = `${brand} ${state}  ${snapshot.cubes.length} ${plural(snapshot.cubes.length, "cube")}  ` +
    `${totalPosts}/15m  v${version}`;
  const uptimeSuffix = `  up ${uptime}`;
  const bodyWidth = Math.max(0, width - terminalCellWidth(uptimeSuffix));
  const visibleBody = truncateCell(body, bodyWidth, glyphs.ellipsis);
  const bodyNode = palette.chrome !== ""
    ? styledRailText(visibleBody, brand, state, palette)
    : h(Text, { wrap: "truncate-end" }, visibleBody);

  return h(Box, { width, height: 1, flexDirection: "row", overflow: "hidden" },
    h(Box, { width: bodyWidth, flexDirection: "row", overflow: "hidden" },
      bodyNode,
      h(Box, { flexGrow: 1 }),
    ),
    h(Text, null, uptimeSuffix),
  );
}

function InkBindStatus(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const endpoint = sanitizeTerminalText(input.snapshot.server.endpoint);
  const value = `Endpoint: ${endpoint}  Bind mode: ${input.snapshot.server.bind_mode}`;
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, styledText(
      truncateCell(value, input.width, input.glyphs.ellipsis),
      { sequence: input.palette.muted },
    )),
  );
}

function styledRailText(
  value: string,
  brand: string,
  state: string,
  palette: NightwatchPalette,
): ReactNode {
  return h(
    Text,
    { wrap: "truncate-end" },
    value
      .replace(brand, `${palette.chrome}${brand}${reset}`)
      .replace(state, `${palette.liveness}${state}${reset}`),
  );
}

function InkRule(input: {
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
}): ReactNode {
  return h(Box, {
    width: input.width,
    height: 1,
    borderStyle: borderStyle(input.glyphs),
    borderTop: true,
    borderBottom: false,
    borderLeft: false,
    borderRight: false,
    ...(input.palette.chromeColor === "" ? {} : { borderColor: input.palette.chromeColor }),
  });
}

function InkEmptyPanel(input: {
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const inner = Math.max(1, input.width - 2);
  return h(
    Box,
    {
      width: input.width,
      height: 3,
      flexDirection: "column",
      borderStyle: borderStyle(input.glyphs),
      ...(input.palette.chromeColor === "" ? {} : { borderColor: input.palette.chromeColor }),
      overflow: "hidden",
    },
    h(Text, { wrap: "truncate-end" }, truncateCell(
      " No cubes yet. Activity will appear here.",
      inner,
      input.glyphs.ellipsis,
    )),
  );
}

function InkFocusPanel(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const { snapshot, cube, width, rows, glyphs, view, palette } = input;
  if (rows < 6 || width < 64) {
    return h(InkCompactDeck, { snapshot, cube, width, rows, glyphs, view, palette });
  }
  if (width >= 144) {
    return h(InkWideDeck, { snapshot, cube, width, rows, glyphs, view, palette });
  }
  const scopeRows = Math.max(3, Math.min(rows - 3, Math.max(5, Math.floor(rows * 0.4))));
  return h(Box, { width, height: rows, flexDirection: "column", overflow: "hidden" }, [
    h(InkSensorScope, { key: "scope", snapshot, cube, width, rows: scopeRows, glyphs, view, palette }),
    h(InkDroneBoard, {
      key: "board",
      snapshot,
      cube,
      width,
      rows: rows - scopeRows,
      glyphs,
      palette,
      twoColumns: false,
    }),
  ]);
}

function InkWideDeck(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const innerWidth = Math.max(3, input.width - 3);
  const boardWidth = input.width >= 200 ? 99 : 76;
  const scopeWidth = innerWidth - boardWidth;
  const contentRows = Math.max(1, input.rows - 2);
  const windowMs = input.view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const mode = input.view.autoFollow || input.view.focusedCubeId === null ? "(auto)" : "(pinned)";
  const coverage = activityCoverage(input.view.observation ?? [], input.snapshot.captured_at, windowMs);
  const resolution = formatBucketResolution(windowMs, scopeCanvasWidth(scopeWidth, true) / 2);
  const scopeTitle = ` SENSOR SCOPE ${dashboardText(input.cube.name, input.glyphs)} ${input.glyphs.separator} ${mode} ` +
    `${input.glyphs.separator} ${formatWindow(windowMs)} ${input.glyphs.separator} ${resolution} ` +
    `${input.glyphs.separator} cov ${Math.round(coverage * 100)}% `;
  const boardTitle = ` DRONES ${input.cube.drones.length} ${input.glyphs.separator} ` +
    `ATTN ${input.cube.attention.unacked_directed} `;
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, [
    h(Text, { key: "title" }, sharedDeckTitle(
      scopeTitle,
      boardTitle,
      scopeWidth,
      boardWidth,
      input.glyphs,
      input.palette,
    )),
    h(Box, {
      key: "body",
      width: input.width,
      height: contentRows,
      flexDirection: "row",
      borderStyle: borderStyle(input.glyphs),
      borderTop: false,
      borderBottom: false,
      overflow: "hidden",
      ...(input.palette.chromeColor === "" ? {} : { borderColor: input.palette.chromeColor }),
    }, [
      h(InkSensorScope, {
        key: "scope",
        ...input,
        width: scopeWidth,
        rows: contentRows,
        unframed: true,
      }),
      h(Box, {
        key: "divider",
        width: 1,
        height: contentRows,
        borderStyle: borderStyle(input.glyphs),
        borderTop: false,
        borderBottom: false,
        borderRight: false,
        ...(input.palette.chromeColor === "" ? {} : { borderColor: input.palette.chromeColor }),
      }),
      h(InkDroneBoard, {
        key: "board",
        ...input,
        width: boardWidth,
        rows: contentRows,
        twoColumns: false,
        unframed: true,
      }),
    ]),
    h(Text, { key: "bottom" }, styledText(
      sharedDeckBottom(scopeWidth, boardWidth, input.glyphs),
      { sequence: input.palette.chrome },
    )),
  ]);
}

function InkSensorScope(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly palette: NightwatchPalette;
  readonly unframed?: boolean;
}): ReactNode {
  const inner = Math.max(1, input.unframed ? input.width : input.width - 2);
  const windowMs = input.view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const mode = input.view.autoFollow || input.view.focusedCubeId === null ? "(auto)" : "(pinned)";
  const coverage = activityCoverage(input.view.observation ?? [], input.snapshot.captured_at, windowMs);
  const contentRows = Math.max(1, input.unframed ? input.rows : input.rows - 2);
  const graphRows = Math.max(1, contentRows - (contentRows >= 3 ? 2 : 1));
  const samples = aggregateActivitySamples(input.cube, input.view.activity);
  const canvasWidth = scopeCanvasWidth(inner, input.unframed === true);
  const buckets = resolvedScopeBuckets(
    samples,
    input.view.observation ?? [],
    input.snapshot.captured_at,
    windowMs,
    canvasWidth / 2,
  );
  const maximum = scopeActivityScale(buckets.map((bucket) => ({
    capturedAt: input.snapshot.captured_at,
    sentRate: bucket.sentRate,
  })));
  const title = ` SENSOR SCOPE ${dashboardText(input.cube.name, input.glyphs)} ${input.glyphs.separator} ${mode} ` +
    `${input.glyphs.separator} ${formatWindow(windowMs)} ${input.glyphs.separator} ` +
    `${formatBucketResolution(windowMs, buckets.length)} ${input.glyphs.separator} cov ${Math.round(coverage * 100)}% `;
  const leftMargin = " ".repeat(Math.max(0, inner - canvasWidth));
  const sweep = scopeSweepPosition(
    canvasWidth,
    input.view.ambientPhase ?? 0,
    input.view.motionMode ?? "ambient",
  );
  const body: ReactNode[] = Array.from({ length: graphRows }, (_unused, row) => {
    const graph = resolvedGraphRow(buckets, graphRows, maximum, row, input.glyphs);
    const sweepValue = graph[sweep] === " " ? scopeSweepGlyph(input.glyphs) : graph[sweep]!;
    return h(Box, { key: `graph-${row}`, width: inner, height: 1, flexDirection: "row", overflow: "hidden" }, [
      h(Text, { key: "margin" }, leftMargin),
      h(Text, { key: "before" }, styledText(graph.slice(0, sweep), { sequence: input.palette.data })),
      h(Text, { key: "sweep" }, styledText(sweepValue, { sequence: input.palette.inactive })),
      h(Text, { key: "after" }, styledText(graph.slice(sweep + 1), { sequence: input.palette.data })),
    ]);
  });
  if (contentRows >= 3) {
    body.push(h(Text, { key: "baseline" }, styledText(
      `${leftMargin}${scopeObservationBaseline(buckets, input.glyphs)}`,
      { sequence: input.palette.muted },
    )));
  }
  if (contentRows >= 2) {
    body.push(h(Text, { key: "axis" }, styledText(
      `${leftMargin}${scopeAxis(canvasWidth, windowMs, input.glyphs)}`,
      { sequence: input.palette.chrome },
    )));
  }
  if (input.unframed) {
    return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, body);
  }
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, [
    h(InkPanelTitle, { key: "title", title, width: input.width, glyphs: input.glyphs, palette: input.palette }),
    h(Box, {
      key: "body",
      width: input.width,
      height: input.rows - 1,
      flexDirection: "column",
      borderStyle: borderStyle(input.glyphs),
      borderTop: false,
      overflow: "hidden",
      ...(input.palette.chromeColor === "" ? {} : { borderColor: input.palette.chromeColor }),
    }, body),
  ]);
}

function InkDroneBoard(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
  readonly twoColumns: boolean;
  readonly unframed?: boolean;
}): ReactNode {
  const inner = Math.max(1, input.unframed ? input.width : input.width - 2);
  const contentRows = Math.max(1, input.unframed ? input.rows : input.rows - 2);
  const tableContentWidth = Math.max(1, inner - 2);
  const table = !input.twoColumns && tableContentWidth >= 40 && contentRows >= 2;
  const headerRows = table ? 1 : 0;
  const attentionRows = input.cube.attention.unacked_directed > 0 ? 1 : 0;
  const itemRows = Math.max(1, contentRows - attentionRows - headerRows);
  const capacity = itemRows * (input.twoColumns ? 2 : 1);
  const prioritized = prioritizeDrones(input.snapshot.captured_at, input.cube.drones);
  const counts = livenessCounts(input.snapshot.captured_at, prioritized);
  const reportedModels = prioritized.filter((drone) => drone.reported_model != null).length;
  const showsModel = table && droneTableColumns(tableContentWidth).some(({ key }) => key === "model");
  const summary = `LIVE ${counts.LIVE}  RECENT ${counts.RECENT}  QUIET ${counts.QUIET}  DARK ${counts.DARK}` +
    `${showsModel ? `  MODEL ${reportedModels}/${prioritized.length} reported` : ""}`;
  let visibleCount = Math.min(input.cube.drones.length, Math.max(1, capacity - 1));
  if (visibleCount < input.cube.drones.length) visibleCount = Math.max(1, capacity - 2);
  const items: Array<{ readonly key: string; readonly drone?: DashboardDroneData; readonly value?: string }> =
    prioritized.slice(0, visibleCount).map((drone) => ({ key: drone.id, drone }));
  const hidden = input.cube.drones.length - visibleCount;
  if (hidden > 0) items.push({ key: "hidden", value: `+${hidden} more drones` });
  items.push({ key: "summary", value: summary });
  const body: ReactNode[] = [];
  if (table) {
    body.push(h(InkDroneTableHeader, {
      key: "header",
      width: inner,
      glyphs: input.glyphs,
      palette: input.palette,
    }));
  }
  const columns = input.twoColumns ? 2 : 1;
  for (let index = 0; index < items.length && body.length < itemRows + headerRows; index += columns) {
    const row = items.slice(index, index + columns);
    const leftWidth = input.twoColumns ? Math.floor(inner / 2) : inner;
    body.push(h(Box, { key: `row-${index}`, width: inner, height: 1, flexDirection: "row", overflow: "hidden" },
      row.map((item, cellIndex) => item.drone === undefined
        ? h(InkFixedText, {
            key: item.key,
            value: item.value ?? "",
            width: input.twoColumns && cellIndex === 1 ? inner - leftWidth : leftWidth,
            ellipsis: input.glyphs.ellipsis,
          })
        : h(InkDroneCell, {
            key: item.key,
            drone: item.drone,
            capturedAt: input.snapshot.captured_at,
            width: input.twoColumns && cellIndex === 1 ? inner - leftWidth : leftWidth,
            glyphs: input.glyphs,
            palette: input.palette,
            detailed: !input.twoColumns,
          })),
    ));
  }
  if (attentionRows > 0) {
    const oldest = input.cube.attention.oldest_unacked;
    const age = oldest === null ? "unknown" : formatAge(input.snapshot.captured_at, oldest.created_at);
    const label = oldest === null ? "" : ` ${dashboardText(oldest.recipient_label, input.glyphs)}`;
    body.push(h(Text, { key: "attention", wrap: "truncate-end" }, truncateCell(
      `ATTN !${input.cube.attention.unacked_directed}${label} unacked ${age}`,
      inner,
      input.glyphs.ellipsis,
    )));
  }
  if (input.unframed) {
    return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, body);
  }
  const title = ` DRONES ${input.cube.drones.length} ${input.glyphs.separator} ATTN ${input.cube.attention.unacked_directed} `;
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, [
    h(InkPanelTitle, { key: "title", title, width: input.width, glyphs: input.glyphs, palette: input.palette }),
    h(Box, {
      key: "body",
      width: input.width,
      height: input.rows - 1,
      flexDirection: "column",
      borderStyle: borderStyle(input.glyphs),
      borderTop: false,
      overflow: "hidden",
      ...(input.palette.chromeColor === "" ? {} : { borderColor: input.palette.chromeColor }),
    }, body),
  ]);
}

function InkDroneCell(input: {
  readonly drone: DashboardDroneData;
  readonly capturedAt: string;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
  readonly detailed: boolean;
}): ReactNode {
  const status = livenessStatus(input.capturedAt, input.drone.last_seen);
  const marker = input.drone.attention.unacked_directed > 0
    ? ` !${input.drone.attention.unacked_directed}`
    : "";
  const age = formatAge(input.capturedAt, input.drone.last_seen);
  if (input.detailed) {
    return h(InkDroneTableRow, input);
  }
  const suffix = ` ${age}`;
  const prefix = `${status}${marker} `;
  const labelWidth = Math.max(1, input.width - terminalCellWidth(prefix) - terminalCellWidth(suffix));
  const label = truncateCell(dashboardText(input.drone.label, input.glyphs), labelWidth, input.glyphs.ellipsis);
  const style = livenessStyle(input.capturedAt, input.drone.last_seen, input.palette);
  return h(Box, { width: input.width, height: 1, flexDirection: "row", overflow: "hidden" }, [
    h(Text, { key: "status" }, styledText(status, style)),
    marker === "" ? null : h(Text, { key: "attention" }, attentionMarker(marker, input.drone, input.palette)),
    h(Text, { key: "details" }, styledText(` ${label}${suffix}`, style)),
  ]);
}

type DroneTableColumn = "status" | "attention" | "drone" | "role" | "model" | "sent" | "age";

function InkDroneTableHeader(input: {
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const columns = droneTableColumns(Math.max(1, input.width - 2));
  const labels: Record<DroneTableColumn, string> = {
    status: "STATUS",
    attention: "!",
    drone: "DRONE",
    role: "ROLE",
    model: "MODEL",
    sent: "SENT",
    age: "AGE",
  };
  return h(Box, { width: input.width, height: 1, flexDirection: "row", overflow: "hidden" }, [
    h(Text, { key: "left" }, " "),
    h(DroneTableCells, {
      key: "cells",
      columns,
      glyphs: input.glyphs,
      values: labels,
      alignEnd: new Set<DroneTableColumn>(["sent", "age"]),
      styles: Object.fromEntries(columns.map(({ key }) => [key, { sequence: input.palette.chrome }])),
    }),
    h(Text, { key: "right" }, " "),
  ]);
}

function InkDroneTableRow(input: {
  readonly drone: DashboardDroneData;
  readonly capturedAt: string;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const columns = droneTableColumns(Math.max(1, input.width - 2));
  const status = livenessStatus(input.capturedAt, input.drone.last_seen);
  const attention = input.drone.attention.unacked_directed > 0
    ? `!${input.drone.attention.unacked_directed}`
    : "";
  const values: Record<DroneTableColumn, string> = {
    status,
    attention,
    drone: dashboardText(input.drone.label, input.glyphs),
    role: dashboardText(input.drone.role, input.glyphs),
    model: input.drone.reported_model == null
      ? "-"
      : dashboardText(input.drone.reported_model, input.glyphs),
    sent: String(input.drone.sent),
    age: formatAge(input.capturedAt, input.drone.last_seen),
  };
  const liveness = livenessStyle(input.capturedAt, input.drone.last_seen, input.palette);
  return h(Box, { width: input.width, height: 1, flexDirection: "row", overflow: "hidden" }, [
    h(Text, { key: "left" }, " "),
    h(DroneTableCells, {
      key: "cells",
      columns,
      glyphs: input.glyphs,
      values,
      alignEnd: new Set<DroneTableColumn>(["sent", "age"]),
      styles: {
      status: liveness,
      attention: { sequence: input.palette.attention === ""
        ? ""
        : `\u001b[7m${input.drone.attention.stale_directed > 0
          ? input.palette.attention
          : input.palette.liveness}` },
      drone: { sequence: input.palette.data },
      role: { sequence: input.palette.muted },
      model: { sequence: input.drone.reported_model == null
        ? input.palette.inactive
        : input.palette.muted },
      sent: { sequence: input.palette.data },
      age: { sequence: input.palette.muted },
      },
    }),
    h(Text, { key: "right" }, " "),
  ]);
}

function DroneTableCells(input: {
  readonly columns: readonly { readonly key: DroneTableColumn; readonly width: number }[];
  readonly glyphs: Glyphs;
  readonly values: Readonly<Record<DroneTableColumn, string>>;
  readonly alignEnd: ReadonlySet<DroneTableColumn>;
  readonly styles: Partial<Record<DroneTableColumn, InkTextStyle>>;
}): ReactNode {
  const children: ReactNode[] = [];
  input.columns.forEach((column, index) => {
    if (index > 0) children.push(h(Text, { key: `gap-${column.key}` }, " "));
    children.push(h(InkFixedText, {
      key: column.key,
      value: input.values[column.key],
      width: column.width,
      ellipsis: input.glyphs.ellipsis,
      align: input.alignEnd.has(column.key) ? "end" : "start",
      ...(input.styles[column.key] === undefined ? {} : { style: input.styles[column.key] }),
    }));
  });
  const width = input.columns.reduce((sum, column) => sum + column.width, 0) +
    Math.max(0, input.columns.length - 1);
  return h(Box, { width, height: 1, flexDirection: "row", overflow: "hidden" }, children);
}

function droneTableColumns(width: number): readonly {
  readonly key: DroneTableColumn;
  readonly width: number;
}[] {
  let values: Array<readonly [DroneTableColumn, number]>;
  let baseWidth: number;
  if (width >= 116) {
    values = [["status", 6], ["attention", 3], ["drone", 33], ["role", 16], ["model", 41], ["sent", 6], ["age", 5]];
    baseWidth = 116;
  } else if (width >= 97) {
    values = [["status", 6], ["attention", 3], ["drone", 28], ["role", 16], ["model", 28], ["sent", 5], ["age", 5]];
    baseWidth = 97;
  } else if (width >= 72) {
    values = [["status", 6], ["attention", 3], ["drone", 21], ["role", 10], ["model", 20], ["sent", 5], ["age", 5]];
    baseWidth = 76;
  } else if (width >= 60) {
    values = [["status", 6], ["attention", 3], ["drone", 31], ["role", 10], ["sent", 5], ["age", 5]];
    baseWidth = 65;
  } else if (width >= 48) {
    values = [["status", 6], ["attention", 3], ["drone", 20], ["role", 10], ["age", 5]];
    baseWidth = 48;
  } else {
    values = [["status", 6], ["attention", 3], ["drone", 23], ["age", 5]];
    baseWidth = 40;
  }
  const flexible = values.findIndex(([key]) => key === "drone");
  const delta = width - baseWidth;
  const selected = values[flexible]!;
  values[flexible] = [selected[0], Math.max(4, selected[1] + delta)];
  return values.map(([key, columnWidth]) => ({ key, width: columnWidth }));
}

function InkPanelTitle(input: {
  readonly title: string;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const plainLeft = `${input.glyphs.topLeft}${input.title}`;
  const left = input.palette.chrome === ""
    ? plainLeft
    : `${input.glyphs.topLeft}${input.palette.chrome}${input.title}${reset}`;
  if (terminalCellWidth(plainLeft) + terminalCellWidth(input.glyphs.topRight) > input.width) {
    const visible = truncateCell(plainLeft, input.width, input.glyphs.ellipsis);
    return h(Text, { wrap: "truncate-end" }, styledText(
      visible,
      { sequence: input.palette.chrome },
    ));
  }
  return h(Box, { width: input.width, height: 1, flexDirection: "row", overflow: "hidden" },
    h(Text, { wrap: "truncate-end" }, left),
    h(Box, {
      flexGrow: 1,
      borderStyle: borderStyle(input.glyphs),
      borderTop: true,
      borderBottom: false,
      borderLeft: false,
      borderRight: false,
      ...(input.palette.chromeColor === "" ? {} : { borderColor: input.palette.chromeColor }),
    }),
    h(Text, null, input.glyphs.topRight),
  );
}

function graphText(
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
  return Array.from({ length: width }, (_unused, columnIndex) => {
    const startSlot = Math.floor(columnIndex * slots.total / width);
    const endSlot = Math.max(startSlot + 1, Math.floor((columnIndex + 1) * slots.total / width));
    const sample = [...slots.entries()].find(([slot]) => slot >= startSlot && slot < endSlot)?.[1];
    if (sample === undefined) return " ";
    if (sample.sentRate <= 0 || maximumActivityRate <= 0) return glyphs.cube[0]!;
    const level = Math.ceil((sample.sentRate / maximumActivityRate) * (height * 8)) - ((height - row - 1) * 8);
    if (level <= 0) return " ";
    return magnitudeGlyph(level, height * 8, glyphs);
  }).join("");
}

interface ResolvedScopeBucket {
  readonly sentRate: number;
  readonly observed: boolean;
}

function scopeCanvasWidth(innerWidth: number, allow120: boolean): 60 | 90 | 120 {
  const usableWidth = Math.max(0, innerWidth - 4);
  if (allow120 && usableWidth >= 120) return 120;
  if (usableWidth >= 90) return 90;
  return 60;
}

function resolvedScopeBuckets(
  samples: readonly DashboardActivitySample[],
  observations: readonly DashboardActivitySample[],
  capturedAt: string,
  windowMs: number,
  bucketCount: number,
): readonly ResolvedScopeBucket[] {
  const end = Date.parse(capturedAt);
  const start = end - windowMs;
  const rates = Array.from({ length: bucketCount }, () => 0);
  const observed = Array.from({ length: bucketCount }, () => false);
  const indexFor = (value: DashboardActivitySample): number | undefined => {
    const timestamp = Date.parse(value.capturedAt);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) return undefined;
    return Math.min(bucketCount - 1, Math.floor((timestamp - start) * bucketCount / windowMs));
  };
  for (const sample of samples) {
    const index = indexFor(sample);
    if (index !== undefined) rates[index] = rates[index]! + sample.sentRate;
  }
  for (const observation of observations) {
    const index = indexFor(observation);
    if (index !== undefined) observed[index] = true;
  }
  return rates.map((sentRate, index) => Object.freeze({ sentRate, observed: observed[index]! }));
}

function resolvedGraphRow(
  buckets: readonly ResolvedScopeBucket[],
  graphRows: number,
  maximum: number,
  row: number,
  glyphs: Glyphs,
): string {
  const bar = glyphs === ASCII_GLYPHS ? "#" : "█";
  return buckets.map((bucket) => {
    const height = bucket.sentRate <= 0 || maximum <= 0
      ? 0
      : Math.min(graphRows, Math.max(1, Math.ceil(bucket.sentRate / maximum * graphRows)));
    return (row >= graphRows - height ? bar : " ").repeat(2);
  }).join("");
}

function scopeObservationBaseline(
  buckets: readonly ResolvedScopeBucket[],
  glyphs: Glyphs,
): string {
  const marker = glyphs === ASCII_GLYPHS ? "." : "·";
  return buckets.map((bucket) => (bucket.observed ? marker : " ").repeat(2)).join("");
}

function formatBucketResolution(windowMs: number, bucketCount: number): string {
  const seconds = Math.max(1, Math.round(windowMs / bucketCount / 1_000));
  return seconds < 60 ? `${seconds}s/bar` : `${Math.round(seconds / 60)}m/bar`;
}


function InkSummaryRow(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly maximumPosts: number;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const { snapshot, cube, width, glyphs, view, maximumPosts, palette } = input;
  const style = livenessStyle(snapshot.captured_at, cube.last_post_at, palette);
  const compact = width < 60;
  const nameWidth = compact ? Math.max(6, width - 32) : Math.max(10, width - 54);
  const pulse = activityPulseMarker(view.pulsePhase);
  const pulseMarker = view.pulseCubeIds.has(cube.id) ? pulse : " ";
  const rankChange = rankMarker(cube.rank_change);
  const heat = heatGlyph(cube.posts_15m, maximumPosts, glyphs);
  const content: ReactNode[] = [
    h(InkFixedText, { key: "heat", value: heat, width: 1, ellipsis: glyphs.ellipsis, style }),
    h(Text, { key: "gap-heat" }, styledText(" ", style)),
    h(InkFixedText, { key: "rank", value: String(cube.rank), width: 3, ellipsis: glyphs.ellipsis, align: "end", style }),
    h(Text, { key: "gap-rank" }, styledText(" ", style)),
    h(InkFixedText, {
      key: "name",
      value: sanitizeTerminalText(cube.name),
      width: nameWidth,
      ellipsis: glyphs.ellipsis,
      style,
    }),
  ];
  const prefixWidth = compact
    ? 1 + 1 + 3 + 1 + nameWidth + 1 + 4 + 5 + 5
    : 1 + 1 + 3 + 1 + nameWidth + 1 + 3 + 1 + 3 + 6 + 4 + 5 + 3 +
      terminalCellWidth(` ${plural(cube.distinct_posting_drones_15m, "poster")} `) + 6;
  if (compact) {
    content.push(
      h(Text, { key: "gap-name" }, styledText(" ", style)),
      h(InkFixedText, { key: "posts", value: String(cube.posts_15m), width: 4, ellipsis: glyphs.ellipsis, align: "end", style }),
      h(Text, { key: "posts-window" }, styledText("/15m ", style)),
      h(InkFixedText, { key: "age", value: formatAge(snapshot.captured_at, cube.last_post_at), width: 5, ellipsis: glyphs.ellipsis, align: "end", style }),
      h(InkFixedText, {
        key: "markers",
        value: ` ${pulseMarker} ${rankChange}`,
        width: Math.max(0, width - prefixWidth),
        ellipsis: glyphs.ellipsis,
        forceEllipsis: true,
        style,
      }),
    );
  } else {
    content.push(
      h(Text, { key: "gap-name" }, styledText(" ", style)),
      h(InkFixedText, { key: "seen", value: String(cube.drones_seen_15m), width: 3, ellipsis: glyphs.ellipsis, align: "end", style }),
      h(Text, { key: "total-separator" }, styledText("/", style)),
      h(InkFixedText, { key: "total", value: String(cube.drones_total), width: 3, ellipsis: glyphs.ellipsis, style }),
      h(Text, { key: "seen-label" }, styledText(" seen ", style)),
      h(InkFixedText, { key: "posts", value: String(cube.posts_15m), width: 4, ellipsis: glyphs.ellipsis, align: "end", style }),
      h(Text, { key: "posts-window" }, styledText("/15m ", style)),
      h(InkFixedText, { key: "posters", value: String(cube.distinct_posting_drones_15m), width: 3, ellipsis: glyphs.ellipsis, align: "end", style }),
      h(Text, { key: "poster-label" }, styledText(` ${plural(cube.distinct_posting_drones_15m, "poster")} `, style)),
      h(InkFixedText, { key: "age", value: formatAge(snapshot.captured_at, cube.last_post_at), width: 6, ellipsis: glyphs.ellipsis, align: "end", style }),
      h(InkFixedText, {
        key: "markers",
        value: ` ${pulseMarker} ${rankChange}`,
        width: Math.max(0, width - prefixWidth),
        ellipsis: glyphs.ellipsis,
        forceEllipsis: true,
        style,
      }),
    );
  }
  return h(Box, { width, height: 1, flexDirection: "row", overflow: "hidden" }, content);
}

function InkFixedText(input: {
  readonly value: string;
  readonly width: number;
  readonly ellipsis: string;
  readonly align?: "start" | "end";
  readonly forceEllipsis?: boolean;
  readonly style?: InkTextStyle;
}): ReactNode {
  return h(Box, {
    width: input.width,
    flexShrink: 0,
    justifyContent: input.align === "end" ? "flex-end" : "flex-start",
    overflow: "hidden",
  }, h(Text, null, styledText(
    truncateCell(input.value, input.width, input.ellipsis, input.forceEllipsis),
    input.style,
  )));
}


function InkFooter(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly navigation: boolean;
  readonly activityWindowMs: number;
  readonly page: number;
  readonly pageCount: number;
  readonly baseFooter: string;
  readonly ellipsis: string;
  readonly motionMode: "ambient" | "calm" | "off";
  readonly motionAutoDegraded: boolean;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const pageSegment = input.pageCount > 1
    ? `${input.navigation ? "SPACE " : "page "}${input.page + 1}/${input.pageCount}`
    : undefined;
  const segments = input.navigation
    ? [
        ...(input.snapshot.cubes.length > 1 ? ["< > switch  |  a auto"] : []),
        ...(pageSegment === undefined ? [] : [pageSegment]),
        `w ${formatWindow(input.activityWindowMs)}`,
        ...(input.motionAutoDegraded ? ["motion: calm (auto)"] : []),
        input.baseFooter,
      ]
    : [
        ...(pageSegment === undefined ? [] : [pageSegment]),
        ...(input.motionAutoDegraded ? ["motion: calm (auto)"] : []),
        input.baseFooter,
      ];
  while (segments.length > 1 && footerSegmentsWidth(segments) > input.width) segments.shift();
  const fixedWidth = segments.slice(0, -1).reduce(
    (total, segment) => total + terminalCellWidth(segment) + 5,
    0,
  );
  const finalWidth = Math.max(0, input.width - fixedWidth);
  const children: ReactNode[] = [];
  segments.forEach((segment, index) => {
    if (index > 0) children.push(h(Text, { key: `separator-${index}` }, styledText(
      "  |  ",
      { sequence: input.palette.muted },
    )));
    if (index === segments.length - 1) {
      children.push(h(InkFixedText, {
        key: `footer-${index}`,
        value: segment,
        width: finalWidth,
        ellipsis: input.ellipsis,
        style: { sequence: input.palette.muted },
      }));
    } else {
      children.push(h(Text, { key: `footer-${index}` }, styledText(
        segment,
        { sequence: input.palette.muted },
      )));
    }
  });
  return h(Box, { width: input.width, height: 1, flexDirection: "row", overflow: "hidden" }, children);
}

function InkFeedRow(input: {
  readonly snapshot: DashboardSnapshot;
  readonly activity: DashboardSnapshot["recent_activity"][number];
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly showClass: boolean;
  readonly first: boolean;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const activity = input.activity;
  const actor = dashboardText(activity.actor_label ?? activity.actor_kind, input.glyphs);
  const classification = input.showClass && activity.activity_class !== null
    ? ` [${dashboardText(activity.activity_class, input.glyphs)}]`
    : "";
  const beforeActor = `${input.first ? "FEED " : "     "}` +
    `${formatAge(input.snapshot.captured_at, activity.created_at)} ` +
    `${dashboardText(activity.cube_name, input.glyphs)}/`;
  const afterActor = `${classification} ${dashboardText(activity.message_head, input.glyphs)}`;
  const visible = truncateCell(`${beforeActor}${actor}${afterActor}`, input.width, input.glyphs.ellipsis);
  const actorStart = beforeActor.length;
  const actorEnd = Math.min(visible.length, actorStart + actor.length);
  const rendered = actorStart >= visible.length
    ? styledText(visible, { sequence: input.palette.muted })
    : `${styledText(visible.slice(0, actorStart), { sequence: input.palette.muted })}` +
      `${styledText(visible.slice(actorStart, actorEnd), { sequence: input.palette.data })}` +
      `${styledText(visible.slice(actorEnd), { sequence: input.palette.muted })}`;
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, rendered));
}

function InkLifecycleFooter(input: {
  readonly value: string;
  readonly width: number;
  readonly rows: number;
  readonly palette: NightwatchPalette;
}): ReactNode {
  const sentences = lifecycleSentences(input.value);
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" },
    sentences.map((sentence, index) => h(Text, { key: `sentence-${index}`, wrap: "wrap" }, styledText(
      sentence,
      { sequence: input.palette.muted },
    ))),
  );
}

function footerSegmentsWidth(segments: readonly string[]): number {
  return segments.reduce(
    (total, segment, index) => total + terminalCellWidth(segment) + (index > 0 ? 5 : 0),
    0,
  );
}

function styledText(value: string, style: InkTextStyle | undefined): string {
  const opening = style?.sequence ?? "";
  return opening === "" ? value : `${opening}${value}${reset}`;
}

function livenessStyle(
  capturedAt: string,
  lastActivity: string | null,
  palette: NightwatchPalette,
): InkTextStyle {
  if (lastActivity === null) return { sequence: palette.inactive };
  const age = Date.parse(capturedAt) - Date.parse(lastActivity);
  if (!Number.isFinite(age) || age >= 60 * 60_000) return { sequence: palette.inactive };
  if (age < 60_000) return { sequence: palette.liveness };
  if (age < 15 * 60_000) return { sequence: palette.data };
  return { sequence: palette.muted };
}

function livenessStatus(capturedAt: string, lastActivity: string | null): "LIVE" | "RECENT" | "QUIET" | "DARK" {
  if (lastActivity === null) return "DARK";
  const age = Date.parse(capturedAt) - Date.parse(lastActivity);
  if (!Number.isFinite(age) || age >= 60 * 60_000) return "DARK";
  if (age < 60_000) return "LIVE";
  if (age < 15 * 60_000) return "RECENT";
  return "QUIET";
}

function lifecycleFooterRows(value: string, width: number): number {
  const sentences = lifecycleSentences(value);
  return sentences.reduce((total, sentence) => {
    let rows = 0;
    let current = "";
    for (const word of sentence.split(/\s+/u)) {
      if (current === "" || terminalCellWidth(`${current} ${word}`) > width) {
        rows += 1;
        current = word;
      } else {
        current = `${current} ${word}`;
      }
    }
    return total + rows;
  }, 0);
}

function lifecycleSentences(value: string): string[] {
  return value.match(/[^.]+(?:\.|$)/gu)?.map((sentence) => sentence.trim()) ?? [value];
}

function truncateCell(value: string, width: number, ellipsis: string, forceEllipsis = false): string {
  const targetWidth = Math.max(0, width);
  if (terminalCellWidth(value) <= targetWidth) return value;
  const suffix = targetWidth >= 4 || forceEllipsis ? ellipsis : "";
  const target = Math.max(0, targetWidth - terminalCellWidth(suffix));
  let result = "";
  for (const character of value) {
    if (terminalCellWidth(result + character) > target) break;
    result += character;
  }
  return `${result}${suffix}`;
}

function terminalCellWidth(value: string): number {
  return stringWidth(stripAnsi(value));
}

function dashboardText(value: string, glyphs: Glyphs): string {
  const sanitized = sanitizeTerminalText(value);
  return glyphs === ASCII_GLYPHS ? sanitized.replace(/[^\x20-\x7e]/gu, "?") : sanitized;
}

function finiteDimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function borderStyle(glyphs: Glyphs): {
  readonly topLeft: string;
  readonly top: string;
  readonly topRight: string;
  readonly right: string;
  readonly bottomRight: string;
  readonly bottom: string;
  readonly bottomLeft: string;
  readonly left: string;
} {
  return {
    topLeft: glyphs.topLeft,
    top: glyphs.horizontal,
    topRight: glyphs.topRight,
    right: glyphs.vertical,
    bottomRight: glyphs.bottomRight,
    bottom: glyphs.horizontal,
    bottomLeft: glyphs.bottomLeft,
    left: glyphs.vertical,
  };
}

function aggregateActivitySamples(
  cube: DashboardCubeSnapshot,
  activity: ReadonlyMap<string, readonly DashboardActivitySample[]> | undefined,
): readonly DashboardActivitySample[] {
  const buckets = new Map<number, { capturedAt: string; sentRate: number }>();
  for (const drone of cube.drones) {
    for (const sample of activity?.get(`${cube.id}:${drone.id}`) ?? []) {
      const timestamp = Date.parse(sample.capturedAt);
      if (!Number.isFinite(timestamp)) continue;
      const bucket = Math.floor(timestamp / 5_000);
      const current = buckets.get(bucket);
      buckets.set(bucket, {
        capturedAt: current === undefined || Date.parse(sample.capturedAt) > Date.parse(current.capturedAt)
          ? sample.capturedAt
          : current.capturedAt,
        sentRate: (current?.sentRate ?? 0) + sample.sentRate,
      });
    }
  }
  return [...buckets.values()].sort((left, right) =>
    Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
}

function scopeSweepPosition(width: number, phase: number, motionMode: "ambient" | "calm" | "off"): number {
  const boundedWidth = Math.max(1, width);
  return motionMode === "off" ? boundedWidth - 1 : Math.abs(Math.floor(phase)) % boundedWidth;
}

function scopeSweepGlyph(glyphs: Glyphs): string {
  return glyphs === ASCII_GLYPHS ? ":" : "░";
}

function overlayScopeSweep(value: string, position: number, marker: string): string {
  if (value.length === 0) return marker;
  const bounded = Math.max(0, Math.min(value.length - 1, position));
  return `${value.slice(0, bounded)}${marker}${value.slice(bounded + 1)}`;
}

function sharedDeckTitle(
  scopeTitle: string,
  boardTitle: string,
  scopeWidth: number,
  boardWidth: number,
  glyphs: Glyphs,
  palette: NightwatchPalette,
): string {
  const segment = (title: string, width: number): string => {
    const visible = truncateCell(title, width, glyphs.ellipsis);
    const styled = palette.chrome === "" ? visible : `${palette.chrome}${visible}${reset}`;
    return `${styled}${glyphs.horizontal.repeat(Math.max(0, width - terminalCellWidth(visible)))}`;
  };
  const junction = glyphs === ASCII_GLYPHS ? "+" : "┬";
  return `${glyphs.topLeft}${segment(scopeTitle, scopeWidth)}${junction}` +
    `${segment(boardTitle, boardWidth)}${glyphs.topRight}`;
}

function sharedDeckBottom(scopeWidth: number, boardWidth: number, glyphs: Glyphs): string {
  const junction = glyphs === ASCII_GLYPHS ? "+" : "┴";
  return `${glyphs.bottomLeft}${glyphs.horizontal.repeat(scopeWidth)}${junction}` +
    `${glyphs.horizontal.repeat(boardWidth)}${glyphs.bottomRight}`;
}

function scopeAxis(width: number, windowMs: number, glyphs: Glyphs): string {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  const labels = [
    `${minutes}m`,
    `${Math.max(1, Math.round(minutes * 2 / 3))}m`,
    `${Math.max(1, Math.round(minutes / 3))}m`,
    "now",
  ];
  const cells = Array.from({ length: width }, () => glyphs.horizontal);
  labels.forEach((label, index) => {
    const position = index === labels.length - 1
      ? Math.max(0, width - label.length)
      : Math.floor(index * Math.max(0, width - 1) / (labels.length - 1));
    [...label].forEach((character, offset) => {
      if (position + offset < cells.length) cells[position + offset] = character;
    });
  });
  return cells.join("");
}

function livenessCounts(
  capturedAt: string,
  drones: readonly DashboardDroneData[],
): Record<"LIVE" | "RECENT" | "QUIET" | "DARK", number> {
  const counts = { LIVE: 0, RECENT: 0, QUIET: 0, DARK: 0 };
  for (const drone of drones) counts[livenessStatus(capturedAt, drone.last_seen)] += 1;
  return counts;
}

function scopeActivityScale(samples: readonly DashboardActivitySample[]): number {
  return Math.max(8, ...samples.map((sample) => sample.sentRate));
}

function prioritizeDrones(
  capturedAt: string,
  drones: readonly DashboardDroneData[],
): readonly DashboardDroneData[] {
  const livenessPriority = { LIVE: 0, RECENT: 1, QUIET: 2, DARK: 3 } as const;
  return [...drones].sort((left, right) => {
    const attention = Number(right.attention.stale_directed > 0) - Number(left.attention.stale_directed > 0) ||
      Number(right.attention.unacked_directed > 0) - Number(left.attention.unacked_directed > 0) ||
      right.attention.stale_directed - left.attention.stale_directed ||
      right.attention.unacked_directed - left.attention.unacked_directed;
    if (attention !== 0) return attention;
    const liveness = livenessPriority[livenessStatus(capturedAt, left.last_seen)] -
      livenessPriority[livenessStatus(capturedAt, right.last_seen)];
    return liveness || left.label.localeCompare(right.label);
  });
}

function attentionMarker(
  value: string,
  drone: DashboardDroneData,
  palette: NightwatchPalette,
): string {
  if (palette.attention === "") return value;
  return `\u001b[7m${drone.attention.stale_directed > 0 ? palette.attention : palette.liveness}${value}${reset}`;
}

function activityCoverage(samples: readonly DashboardActivitySample[], capturedAt: string, windowMs: number): number {
  const slots = activitySlots(samples, capturedAt, windowMs);
  return slots.size / slots.total;
}

function activitySlots(samples: readonly DashboardActivitySample[], capturedAt: string, windowMs: number): (Map<number, DashboardActivitySample> & { total: number }) {
  const end = Date.parse(capturedAt);
  const start = end - windowMs;
  const buckets = new Map<number, DashboardActivitySample>() as Map<number, DashboardActivitySample> & { total: number };
  buckets.total = Math.max(1, Math.ceil(windowMs / 5_000));
  for (const sample of samples) {
    const timestamp = Date.parse(sample.capturedAt);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
    const bucket = Math.min(buckets.total - 1, Math.floor((timestamp - start) / 5_000));
    buckets.set(bucket, sample);
  }
  return buckets;
}

function graphMagnitude(level: number, maximumLevel: number, glyphs: Glyphs): string {
  if (level <= 0 || maximumLevel <= 0) return glyphs.cube[0]!;
  const index = Math.min(glyphs.cube.length - 1, Math.max(1, Math.ceil((level / maximumLevel) * (glyphs.cube.length - 1))));
  return glyphs.cube[index]!;
}

function heatGlyph(posts: number, maximumPosts: number, glyphs: Glyphs): string {
  if (posts <= 0 || maximumPosts <= 0) return glyphs.cube[0]!;
  const index = Math.min(
    glyphs.cube.length - 1,
    Math.max(1, Math.ceil((Math.log1p(posts) / Math.log1p(maximumPosts)) * (glyphs.cube.length - 1))),
  );
  return glyphs.cube[index]!;
}

function magnitudeGlyph(level: number, maximumLevel: number, glyphs: Glyphs): string {
  return graphMagnitude(level, maximumLevel, glyphs);
}

function activityPulseMarker(phase: number): string {
  const boundedPhase = Math.max(0, Math.min(DASHBOARD_PULSE_PHASES, Math.floor(phase)));
  return DASHBOARD_ACTIVITY_PULSE_MARKERS[boundedPhase]!;
}

function rankMarker(delta: number): string {
  if (delta === 0) return "  ";
  return `${delta > 0 ? "^" : "v"}${Math.min(9, Math.abs(delta))}`;
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

function formatWindow(windowMs: number): string { return `${Math.floor(windowMs / 60_000)}m`; }

function formatUptime(capturedAt: string, startedAt: string): string {
  const elapsed = Math.max(0, Date.parse(capturedAt) - Date.parse(startedAt));
  if (!Number.isFinite(elapsed)) return "unknown";
  if (elapsed < 60_000) return "<1m";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m`;
  const hours = Math.floor(elapsed / (60 * 60_000));
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}

export function normalizeInkFrame(
  value: string,
  width: number,
  height: number,
  background = "",
  defaultForeground = "",
): string {
  const withoutInkControls = stripInkFrameControls(value);
  const withoutTrailingNewline = withoutInkControls.endsWith("\n")
    ? withoutInkControls.slice(0, -1)
    : withoutInkControls;
  const lines = withoutTrailingNewline.split("\n").slice(0, height);
  while (lines.length < height) lines.push("");
  return lines.map((line) => {
    const padded = padInkRow(normalizeInkAnsi(line), width);
    if (background === "") return padded;
    const base = `${background}${defaultForeground}`;
    return `${base}${padded.replaceAll(reset, `${reset}${base}`)}${reset}`;
  }).join("\n");
}

function nightwatchPalette(depth: DashboardColorDepth): NightwatchPalette {
  if (depth === "none") {
    return { background: "", backgroundColor: "", chrome: "", chromeColor: "", data: "", liveness: "", attention: "", muted: "", inactive: "" };
  }
  if (depth === "truecolor") {
    return {
      background: "\u001b[48;2;9;11;16m",
      backgroundColor: "rgb(9, 11, 16)",
      chrome: "\u001b[38;2;230;161;90m",
      chromeColor: "rgb(230, 161, 90)",
      data: "\u001b[38;2;184;199;255m",
      liveness: "\u001b[38;2;121;214;159m",
      attention: "\u001b[38;2;255;122;144m",
      muted: "\u001b[38;2;155;167;184m",
      inactive: "\u001b[38;2;88;98;115m",
    };
  }
  if (depth === "ansi256") {
    return {
      background: "\u001b[48;5;232m",
      backgroundColor: "ansi256(232)",
      chrome: "\u001b[38;5;215m",
      chromeColor: "ansi256(215)",
      data: "\u001b[38;5;147m",
      liveness: "\u001b[38;5;115m",
      attention: "\u001b[38;5;210m",
      muted: "\u001b[38;5;245m",
      inactive: "\u001b[38;5;60m",
    };
  }
  return {
    background: "",
    backgroundColor: "",
    chrome: "\u001b[33m",
    chromeColor: "yellow",
    data: "",
    liveness: "\u001b[32;1m",
    attention: "\u001b[33m",
    muted: "",
    inactive: "\u001b[2m",
  };
}

const ansiSequence = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu;
const sgrSequence = /^\u001b\[[0-?]*m$/u;
const inkFrameControl = /^\u001b\[(?:\?25[hl]|\?2026[hl]|\d*(?:;\d*)?[A-HJKf])$/u;

function stripInkFrameControls(value: string): string {
  let frame = value;
  for (const match of value.matchAll(ansiSequence)) {
    const sequence = match[0];
    if (sgrSequence.test(sequence)) continue;
    if (!inkFrameControl.test(sequence)) {
      throw new Error(`Ink frame emitted an unexpected escape sequence: ${JSON.stringify(sequence)}`);
    }
    frame = frame.replace(sequence, "");
  }
  return frame;
}

function padInkRow(line: string, width: number): string {
  const visible = terminalCellWidth(line);
  if (visible > width) {
    throw new Error(`Ink frame row exceeds requested width: ${visible} > ${width}`);
  }
  const missing = Math.max(0, width - visible);
  if (missing === 0) return line;
  const suffix = line.match(/(\u001b\[[0-?]*[ -/]*[@-~])$/u)?.[1];
  const padding = " ".repeat(missing);
  if (suffix === undefined) return `${line}${padding}`;
  return `${line.slice(0, -suffix.length)}${padding}${suffix}`;
}

function normalizeInkAnsi(line: string): string {
  return line
    .replace(/\u001b\[32m\u001b\[1m/gu, "\u001b[32;1m")
    .replace(/\u001b\[1m\u001b\[32m/gu, "\u001b[32;1m")
    .replace(/\u001b\[22m\u001b\[39m/gu, "\u001b[0m")
    .replace(/\u001b\[39m/gu, "\u001b[0m")
    .replace(/\u001b\[22m/gu, "\u001b[0m");
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}
