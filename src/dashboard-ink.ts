import { createElement as h, type ReactNode } from "react";
import {
  Box,
  renderToString,
  Text,
  type TextProps,
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

type InkTextStyle = Pick<TextProps, "bold" | "color" | "dimColor">;

const DASHBOARD_PULSE_PHASES = 4;
const DASHBOARD_ACTIVITY_PULSE_MARKERS = [" ", "_", "-", "o", "O"] as const;
const green = "\u001b[32;1m";
const amber = "\u001b[33m";
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
  return normalizeInkFrame(rendered, width, height);
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
    h(InkRail, { key: "rail", snapshot, width, glyphs, color: options.color }),
    h(InkBindStatus, { key: "bind", snapshot, width, glyphs }),
    h(InkAttention, { key: "attention", snapshot, width, glyphs, color: options.color }),
    h(InkRule, { key: "separator-top", width, glyphs }),
    focus === undefined
      ? h(InkEmptyPanel, { key: "empty-panel", width, glyphs })
      : h(InkFocusPanel, {
          key: "focus-panel",
          snapshot,
          cube: focus,
          width,
          rows: panelRows,
          glyphs,
          view,
          color: options.color,
        }),
    h(InkRule, { key: "separator-bottom", width, glyphs }),
  ];

  snapshot.recent_activity.slice(0, feedRows).forEach((activity, index) => {
    children.push(h(InkFeedRow, {
      key: `feed-${activity.id}`,
      snapshot,
      activity,
      width,
      glyphs,
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
      color: options.color,
    }));
  }
  if (lifecycleRows > 0) {
    children.push(h(InkLifecycleFooter, {
      key: "lifecycle",
      value: EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER,
      width,
      rows: lifecycleRows,
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
  }));

  return h(Box, { width, height, flexDirection: "column", overflow: "hidden" }, children);
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
  const bodyRows = Math.max(1, input.height - 5);
  return h(Box, { width: input.width, height: input.height, flexDirection: "column", overflow: "hidden" }, [
    h(InkRail, { key: "rail", snapshot: input.snapshot, width: input.width, glyphs: input.glyphs, color: input.options.color }),
    h(InkAttention, { key: "attention", snapshot: input.snapshot, width: input.width, glyphs: input.glyphs, color: input.options.color }),
    h(InkRule, { key: "separator-top", width: input.width, glyphs: input.glyphs }),
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
          color: input.options.color,
        }),
    h(InkRule, { key: "separator-bottom", width: input.width, glyphs: input.glyphs }),
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
    }),
  ]);
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
  readonly color: boolean;
}): ReactNode {
  const windowMs = input.view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const mode = input.view.autoFollow || input.view.focusedCubeId === null ? "(auto)" : "(pinned)";
  const prefix = `SCOPE ${dashboardText(input.cube.name, input.glyphs)} ${input.glyphs.separator} ${mode} `;
  const suffix = ` ${formatWindow(windowMs)}`;
  const graphWidth = Math.max(1, input.width - terminalCellWidth(prefix) - terminalCellWidth(suffix));
  const samples = aggregateActivitySamples(input.cube, input.view.activity);
  const maximum = activityRateMaximum(input.cube, input.view.activity);
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
  const visible = input.cube.drones.slice(0, Math.max(1, available - 1));
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
      color: input.color,
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
  readonly color: boolean;
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
  const active = input.color && attention.unacked_directed > 0;
  const visible = truncateCell(value, input.width, input.glyphs.ellipsis);
  const rendered = active
    ? `\u001b[7m${attention.stale_directed > 0 ? amber : green}${visible}${reset}`
    : visible;
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, rendered));
}

function InkRail(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly color: boolean;
}): ReactNode {
  const { snapshot, width, glyphs, color } = input;
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
  const bodyNode = color
    ? styledRailText(visibleBody, brand, state)
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
}): ReactNode {
  const endpoint = sanitizeTerminalText(input.snapshot.server.endpoint);
  const value = `Endpoint: ${endpoint}  Bind mode: ${input.snapshot.server.bind_mode}`;
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, truncateCell(value, input.width, input.glyphs.ellipsis)),
  );
}

function styledRailText(value: string, brand: string, state: string): ReactNode {
  return h(
    Text,
    { wrap: "truncate-end" },
    value.replace(brand, `${amber}${brand}${reset}`).replace(state, `${green}${state}${reset}`),
  );
}

function InkRule(input: { readonly width: number; readonly glyphs: Glyphs }): ReactNode {
  return h(Box, {
    width: input.width,
    height: 1,
    borderStyle: borderStyle(input.glyphs),
    borderTop: true,
    borderBottom: false,
    borderLeft: false,
    borderRight: false,
  });
}

function InkEmptyPanel(input: { readonly width: number; readonly glyphs: Glyphs }): ReactNode {
  const inner = Math.max(1, input.width - 2);
  return h(
    Box,
    {
      width: input.width,
      height: 3,
      flexDirection: "column",
    borderStyle: borderStyle(input.glyphs),
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
  readonly color: boolean;
}): ReactNode {
  const { snapshot, cube, width, rows, glyphs, view, color } = input;
  if (rows < 6) {
    return h(InkCompactDeck, { snapshot, cube, width, rows, glyphs, view, color });
  }
  if (width >= 100) {
    const boardWidth = Math.max(38, Math.floor(width * 0.4));
    const scopeWidth = width - boardWidth;
    return h(Box, { width, height: rows, flexDirection: "row", overflow: "hidden" }, [
      h(InkSensorScope, { key: "scope", snapshot, cube, width: scopeWidth, rows, glyphs, view, color }),
      h(InkDroneBoard, { key: "board", snapshot, cube, width: boardWidth, rows, glyphs, color, twoColumns: false }),
    ]);
  }
  const scopeRows = Math.max(3, Math.min(rows - 3, Math.floor(rows * 0.4)));
  return h(Box, { width, height: rows, flexDirection: "column", overflow: "hidden" }, [
    h(InkSensorScope, { key: "scope", snapshot, cube, width, rows: scopeRows, glyphs, view, color }),
    h(InkDroneBoard, {
      key: "board",
      snapshot,
      cube,
      width,
      rows: rows - scopeRows,
      glyphs,
      color,
      twoColumns: true,
    }),
  ]);
}

function InkSensorScope(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly color: boolean;
}): ReactNode {
  const inner = Math.max(1, input.width - 2);
  const windowMs = input.view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const mode = input.view.autoFollow || input.view.focusedCubeId === null ? "(auto)" : "(pinned)";
  const coverage = activityCoverage(input.view.observation ?? [], input.snapshot.captured_at, windowMs);
  const title = ` SENSOR SCOPE ${dashboardText(input.cube.name, input.glyphs)} ${input.glyphs.separator} ${mode} ` +
    `${input.glyphs.separator} ${formatWindow(windowMs)} ${input.glyphs.separator} cov ${Math.round(coverage * 100)}% `;
  const contentRows = Math.max(1, input.rows - 2);
  const graphRows = Math.max(1, contentRows - 1);
  const samples = aggregateActivitySamples(input.cube, input.view.activity);
  const maximum = activityRateMaximum(input.cube, input.view.activity);
  const sweep = scopeSweepPosition(
    inner,
    input.view.ambientPhase ?? 0,
    input.view.motionMode ?? "ambient",
  );
  const body: ReactNode[] = Array.from({ length: graphRows }, (_unused, row) => {
    const graph = graphText(
      samples,
      inner,
      graphRows,
      windowMs,
      input.snapshot.captured_at,
      input.glyphs,
      maximum,
      row,
    );
    const graphStyle = input.color ? { color: "green" as const, bold: true } : undefined;
    return h(Box, { key: `graph-${row}`, width: inner, height: 1, flexDirection: "row", overflow: "hidden" }, [
      h(Text, { key: "before" }, styledText(graph.slice(0, sweep), graphStyle)),
      h(Text, { key: "sweep", dimColor: input.color }, scopeSweepGlyph(input.glyphs)),
      h(Text, { key: "after" }, styledText(graph.slice(sweep + 1), graphStyle)),
    ]);
  });
  if (contentRows > 1) {
    body.push(h(Text, { key: "axis", dimColor: input.color }, scopeAxis(inner, windowMs, input.glyphs)));
  }
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, [
    h(InkPanelTitle, { key: "title", title, width: input.width, glyphs: input.glyphs, color: input.color }),
    h(Box, {
      key: "body",
      width: input.width,
      height: input.rows - 1,
      flexDirection: "column",
      borderStyle: borderStyle(input.glyphs),
      borderTop: false,
      overflow: "hidden",
    }, body),
  ]);
}

function InkDroneBoard(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly color: boolean;
  readonly twoColumns: boolean;
}): ReactNode {
  const inner = Math.max(1, input.width - 2);
  const contentRows = Math.max(1, input.rows - 2);
  const attentionRows = input.cube.attention.unacked_directed > 0 ? 1 : 0;
  const itemRows = Math.max(1, contentRows - attentionRows);
  const capacity = itemRows * (input.twoColumns ? 2 : 1);
  const counts = livenessCounts(input.snapshot.captured_at, input.cube.drones);
  const summary = `LIVE ${counts.LIVE}  RECENT ${counts.RECENT}  QUIET ${counts.QUIET}  DARK ${counts.DARK}`;
  let visibleCount = Math.min(input.cube.drones.length, Math.max(1, capacity - 1));
  if (visibleCount < input.cube.drones.length) visibleCount = Math.max(1, capacity - 2);
  const items: Array<{ readonly key: string; readonly drone?: DashboardDroneData; readonly value?: string }> =
    input.cube.drones.slice(0, visibleCount).map((drone) => ({ key: drone.id, drone }));
  const hidden = input.cube.drones.length - visibleCount;
  if (hidden > 0) items.push({ key: "hidden", value: `+${hidden} more drones` });
  items.push({ key: "summary", value: summary });
  const body: ReactNode[] = [];
  const columns = input.twoColumns ? 2 : 1;
  for (let index = 0; index < items.length && body.length < itemRows; index += columns) {
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
            color: input.color,
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
  const title = ` DRONES ${input.cube.drones.length} ${input.glyphs.separator} ATTN ${input.cube.attention.unacked_directed} `;
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, [
    h(InkPanelTitle, { key: "title", title, width: input.width, glyphs: input.glyphs, color: input.color }),
    h(Box, {
      key: "body",
      width: input.width,
      height: input.rows - 1,
      flexDirection: "column",
      borderStyle: borderStyle(input.glyphs),
      borderTop: false,
      overflow: "hidden",
    }, body),
  ]);
}

function InkDroneCell(input: {
  readonly drone: DashboardDroneData;
  readonly capturedAt: string;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly color: boolean;
  readonly detailed: boolean;
}): ReactNode {
  const status = livenessStatus(input.capturedAt, input.drone.last_seen);
  const marker = input.drone.attention.unacked_directed > 0
    ? ` !${input.drone.attention.unacked_directed}`
    : "";
  const age = formatAge(input.capturedAt, input.drone.last_seen);
  const role = truncateCell(dashboardText(input.drone.role, input.glyphs), 7, input.glyphs.ellipsis);
  const suffix = input.detailed ? `  ${role} ${input.drone.sent} ${age}` : ` ${age}`;
  const prefix = `${status}${marker} `;
  const labelWidth = Math.max(1, input.width - terminalCellWidth(prefix) - terminalCellWidth(suffix));
  const label = truncateCell(dashboardText(input.drone.label, input.glyphs), labelWidth, input.glyphs.ellipsis);
  const value = truncateCell(`${prefix}${label}${suffix}`, input.width, input.glyphs.ellipsis);
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, styledText(value, livenessStyle(input.capturedAt, input.drone.last_seen, input.color))));
}

function InkPanelTitle(input: {
  readonly title: string;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly color: boolean;
}): ReactNode {
  const plainLeft = `${input.glyphs.topLeft}${input.title}`;
  const left = input.color ? `${input.glyphs.topLeft}${amber}${input.title}${reset}` : plainLeft;
  if (terminalCellWidth(plainLeft) + terminalCellWidth(input.glyphs.topRight) > input.width) {
    const visible = truncateCell(plainLeft, input.width, input.glyphs.ellipsis);
    return h(Text, { wrap: "truncate-end" }, styledText(
      visible,
      input.color ? { color: "yellow" } : undefined,
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


function InkSummaryRow(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly maximumPosts: number;
  readonly color: boolean;
}): ReactNode {
  const { snapshot, cube, width, glyphs, view, maximumPosts, color } = input;
  const style = livenessStyle(snapshot.captured_at, cube.last_post_at, color);
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
    if (index > 0) children.push(h(Text, { key: `separator-${index}` }, "  |  "));
    if (index === segments.length - 1) {
      children.push(h(InkFixedText, {
        key: `footer-${index}`,
        value: segment,
        width: finalWidth,
        ellipsis: input.ellipsis,
      }));
    } else {
      children.push(h(Text, { key: `footer-${index}` }, segment));
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
}): ReactNode {
  const activity = input.activity;
  const actor = dashboardText(activity.actor_label ?? activity.actor_kind, input.glyphs);
  const classification = input.showClass && activity.activity_class !== null
    ? ` [${dashboardText(activity.activity_class, input.glyphs)}]`
    : "";
  const prefix = `${input.first ? "FEED " : "     "}${formatAge(input.snapshot.captured_at, activity.created_at)} ` +
    `${dashboardText(activity.cube_name, input.glyphs)}/${actor}${classification} `;
  const value = `${prefix}${dashboardText(activity.message_head, input.glyphs)}`;
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, truncateCell(value, input.width, input.glyphs.ellipsis)));
}

function InkLifecycleFooter(input: {
  readonly value: string;
  readonly width: number;
  readonly rows: number;
}): ReactNode {
  const sentences = lifecycleSentences(input.value);
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" },
    sentences.map((sentence, index) => h(Text, { key: `sentence-${index}`, wrap: "wrap" }, sentence)),
  );
}

function footerSegmentsWidth(segments: readonly string[]): number {
  return segments.reduce(
    (total, segment, index) => total + terminalCellWidth(segment) + (index > 0 ? 5 : 0),
    0,
  );
}

function styledText(value: string, style: InkTextStyle | undefined): string {
  const opening = style === undefined ? "" : styleSequence(style);
  return opening === "" ? value : `${opening}${value}${reset}`;
}

function styleSequence(style: InkTextStyle): string {
  if (style.color === "green" && style.bold === true) return green;
  if (style.color === "yellow") return amber;
  if (style.dimColor === true) return "\u001b[2m";
  return "";
}

function livenessStyle(capturedAt: string, lastActivity: string | null, color: boolean): InkTextStyle {
  if (!color) return {};
  if (lastActivity === null) return { dimColor: true };
  const age = Date.parse(capturedAt) - Date.parse(lastActivity);
  if (!Number.isFinite(age) || age >= 60 * 60_000) return { dimColor: true };
  if (age < 60_000) return { color: "green", bold: true };
  if (age < 15 * 60_000) return { color: "yellow" };
  return {};
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

function scopeAxis(width: number, windowMs: number, glyphs: Glyphs): string {
  const left = formatWindow(windowMs);
  const right = "now";
  const fill = glyphs.cube[0]!.repeat(Math.max(1, width - terminalCellWidth(left) - terminalCellWidth(right)));
  return truncateCell(`${left}${fill}${right}`, width, glyphs.ellipsis);
}

function livenessCounts(
  capturedAt: string,
  drones: readonly DashboardDroneData[],
): Record<"LIVE" | "RECENT" | "QUIET" | "DARK", number> {
  const counts = { LIVE: 0, RECENT: 0, QUIET: 0, DARK: 0 };
  for (const drone of drones) counts[livenessStatus(capturedAt, drone.last_seen)] += 1;
  return counts;
}

function activityRateMaximum(
  cube: DashboardCubeSnapshot,
  activity: ReadonlyMap<string, readonly DashboardActivitySample[]> | undefined,
): number {
  let maximum = 0;
  for (const drone of cube.drones) {
    for (const sample of activity?.get(`${cube.id}:${drone.id}`) ?? []) maximum = Math.max(maximum, sample.sentRate);
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

export function normalizeInkFrame(value: string, width: number, height: number): string {
  const withoutInkControls = stripInkFrameControls(value);
  const withoutTrailingNewline = withoutInkControls.endsWith("\n")
    ? withoutInkControls.slice(0, -1)
    : withoutInkControls;
  const lines = withoutTrailingNewline.split("\n").slice(0, height);
  while (lines.length < height) lines.push("");
  return lines.map((line) => padInkRow(normalizeInkAnsi(line), width)).join("\n");
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
