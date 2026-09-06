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

interface CollectivePalette {
  readonly primary: string;
  readonly identity: string;
  readonly statusBand: string;
  readonly attentionBand: string;
  readonly panelColor: string;
  readonly selectionColor: string;
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
const textReset = "\u001b[39m\u001b[22m";

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
  const palette = collectivePalette(options.color ? options.colorDepth ?? "ansi16" : "none");
  return normalizeInkFrame(rendered, width, height, palette.background, palette.primary);
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

// Shared with the live frame projection so paging follows the rendered budget.
export function dashboardBodyBudget(
  snapshot: DashboardSnapshot,
  focus: DashboardCubeSnapshot | undefined,
  width: number,
  height: number,
  bodyRows: number,
): { feedRows: number; listCap: number; panelRows: number; commandColumns: boolean } {
  const commandColumns = width >= 100 && height >= 20;
  const desiredFeedRows = Math.min(snapshot.recent_activity.length, bodyRows < 10 ? 1 : height >= 36 ? 4 : 3);
  // Reserve the focused board and a readable scope before ancillary rows.
  const desiredPanelRows = focus === undefined ? 3 : width < 64
    ? focus.drones.length + 2
    : 6 + focus.drones.length + 4 + (focus.attention.unacked_directed > 0 ? 1 : 0);
  const desiredCommandBoardRows = Math.max(6, (focus?.drones.length ?? 0) + 5);
  const reservedPanelRows = Math.min(bodyRows, commandColumns ? desiredCommandBoardRows : desiredPanelRows);
  const feedRows = Math.min(desiredFeedRows, Math.max(0, bodyRows - reservedPanelRows - (commandColumns ? 1 : 0)));
  const listCap = commandColumns
    ? Math.max(1, Math.floor((bodyRows * 0.4 - 2) / 3))
    : Math.max(0, bodyRows - reservedPanelRows - feedRows);
  const panelRows = Math.max(1, bodyRows - Math.min(snapshot.cubes.length, listCap) - feedRows);
  return { feedRows, listCap, panelRows, commandColumns };
}

function InkDashboard(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly height: number;
  readonly view: DashboardViewState;
  readonly options: InkRenderOptions;
}): ReactNode {
  const { snapshot, width, height, view, options } = input;
  const palette = collectivePalette(options.color ? options.colorDepth ?? "ansi16" : "none");
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
  const { feedRows, listCap, panelRows, commandColumns } = dashboardBodyBudget(
    snapshot, focus, width, height, bodyRows,
  );
  const listRows = Math.min(snapshot.cubes.length, listCap);
  const pageCount = listCap === 0 ? 1 : Math.max(1, Math.ceil(snapshot.cubes.length / listCap));
  const page = Math.max(0, view.page ?? 0) % pageCount;
  const pageStart = page * listCap;

  const children: ReactNode[] = [
    h(InkRail, { key: "rail", snapshot, width, glyphs, palette }),
    h(InkBindStatus, { key: "bind", snapshot, width, glyphs, palette }),
    h(InkAttention, { key: "attention", snapshot, width, glyphs, palette }),
    h(InkRule, { key: "separator-top", width, glyphs, palette }),
  ];
  if (commandColumns && focus !== undefined) {
    const leftWidth = Math.floor((width - 3) * 0.30);
    const rightWidth = width - leftWidth - 3;
    const omittedCubeRow = snapshot.cubes.length > listRows ? 1 : 0;
    const scopeRows = Math.max(9, bodyRows - Math.min(listRows * 3 + 1 + omittedCubeRow, Math.floor(bodyRows * 0.4)));
    const cubeRows = Math.max(0, bodyRows - scopeRows - 1 - omittedCubeRow);
    const visibleCubes = snapshot.cubes.slice(pageStart, pageStart + Math.floor(cubeRows / 3));
    const boardRows = Math.min(bodyRows, Math.max(6, focus.drones.length + 5));
    const left: ReactNode[] = [h(InkSensorScope, {
      key: "scope", snapshot, cube: focus, width: leftWidth, rows: scopeRows, glyphs, view, palette,
    }), h(InkPanelTitle, { key: "cubes-title", title: ` CUBES ${snapshot.cubes.length} `,
      width: leftWidth, glyphs, palette })];
    for (const cube of visibleCubes) {
      const selected = cube.id === focus.id ? ">" : " ";
      const pulse = view.pulseCubeIds.has(cube.id) ? activityPulseMarker(view.pulsePhase) : " ";
      const lines = [
        `${selected}${cube.rank} ${dashboardText(cube.name, glyphs)} ${pulse} ${rankMarker(cube.rank_change)}`,
        `${cube.posts_15m}/15m  ${cube.distinct_posting_drones_15m} ${plural(cube.distinct_posting_drones_15m, "poster")}  ${formatAge(snapshot.captured_at, cube.last_post_at)}`,
        `${cube.drones_seen_15m}/${cube.drones_total} seen`,
      ];
      lines.forEach((value, index) => left.push(h(Box, { key: `${cube.id}-${index}`, width: leftWidth, height: 1,
        ...(selected === ">" && palette.selectionColor !== "" ? { backgroundColor: palette.selectionColor } : {}) },
        h(Text, null, styledText(truncateCell(value, leftWidth, glyphs.ellipsis),
          { sequence: index === 0 ? palette.primary : palette.muted })))));
    }
    if (visibleCubes.length < snapshot.cubes.length) left.push(h(Text, { key: "cubes-hidden" },
      `+${snapshot.cubes.length - visibleCubes.length} cubes (Space)`));
    const right: ReactNode[] = [h(InkDroneBoard, {
      key: "board", snapshot, cube: focus, width: rightWidth, rows: boardRows,
      glyphs, palette, twoColumns: false,
    })];
    if (bodyRows > boardRows) right.push(h(InkPanelTitle, {
      key: "feed-title", title: " ACTIVITY FEED ", width: rightWidth, glyphs, palette,
    }));
    snapshot.recent_activity.slice(0, feedRows).forEach((activity, index) => right.push(
      h(InkFeedRow, { key: activity.id, snapshot, activity, width: rightWidth, glyphs, palette,
        showClass: true, first: index === 0 }),
    ));
    children.push(h(Box, { key: "command", width, height: bodyRows, flexDirection: "row", overflow: "hidden" },
      h(Box, { width: 1, height: bodyRows, flexDirection: "column" },
        Array.from({ length: bodyRows }, (_, index) => h(Text, { key: index }, styledText(glyphs.rail, { sequence: palette.chrome })))),
      h(Box, { width: leftWidth, height: bodyRows, flexDirection: "column", overflow: "hidden",
        ...(palette.panelColor === "" ? {} : { backgroundColor: palette.panelColor }) }, left),
      h(Box, { width: 2 }),
      h(Box, { width: rightWidth, height: bodyRows, flexDirection: "column", overflow: "hidden",
        ...(palette.panelColor === "" ? {} : { backgroundColor: palette.panelColor }) }, right),
    ));
    children.push(h(InkRule, { key: "separator-bottom", width, glyphs, palette }));
  } else {
    children.push(focus === undefined
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
  );

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
  const palette = collectivePalette(
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
  readonly palette: CollectivePalette;
}): ReactNode {
  const windowMs = input.view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const mode = input.view.autoFollow || input.view.focusedCubeId === null ? "(auto)" : "(pinned)";
  const prefix = `SCOPE ${dashboardText(input.cube.name, input.glyphs)} ${input.glyphs.separator} ${mode} `;
  const suffix = ` ${formatWindow(windowMs)}`;
  const graphWidth = Math.max(1, input.width - terminalCellWidth(prefix) - terminalCellWidth(suffix));
  const buckets = dashboardScopeBuckets(input.cube, input.snapshot.captured_at, windowMs, graphWidth);
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const graph = buckets.map((bucket) => bucket.count > 0
    ? input.glyphs.cube[Math.min(input.glyphs.cube.length - 1, Math.ceil(bucket.count / maximum * (input.glyphs.cube.length - 1)))]!
    : bucket.coverage === 0 ? (input.glyphs === ASCII_GLYPHS ? "/" : "░")
    : bucket.coverage < 1 ? (input.glyphs === ASCII_GLYPHS ? ":" : "▒") : input.glyphs.cube[0]!).join("");
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
  readonly palette: CollectivePalette;
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
  const visible = truncateCell(`! ${value}`, input.width, input.glyphs.ellipsis);
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, styledText(visible.padEnd(input.width), { sequence: input.palette.attentionBand })));

}

function InkRail(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: CollectivePalette;
}): ReactNode {
  const { snapshot, width, glyphs, palette } = input;
  const identity = `${sanitizeTerminalText(snapshot.server.name).toUpperCase()} v${sanitizeTerminalText(snapshot.server.version)}`;
  const brandWidth = Math.min(width - 15, terminalCellWidth(identity) + 2);
  const brand = truncateCell(` ${identity} `, brandWidth, glyphs.ellipsis);
  const totalPosts = snapshot.cubes.reduce((sum, cube) => sum + cube.posts_15m, 0);
  const status = ` ${snapshot.server.state.toUpperCase()}  ${snapshot.cubes.length} ${plural(snapshot.cubes.length, "cube")}  ${totalPosts}/15m`;
  const rightWidth = width - brandWidth - 1;
  const band = truncateCell(status, rightWidth, glyphs.ellipsis);
  return h(Box, { width, height: 1, flexDirection: "row", overflow: "hidden" },
    h(Text, null, styledText(brand + " ".repeat(brandWidth - terminalCellWidth(brand)), { sequence: palette.identity })),
    h(Text, null, " "),
    h(Text, null, styledText(band + " ".repeat(rightWidth - terminalCellWidth(band)), { sequence: palette.statusBand })),
  );
}

function InkBindStatus(input: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: CollectivePalette;
}): ReactNode {
  const endpoint = sanitizeTerminalText(input.snapshot.server.endpoint);
  const uptime = `up ${formatUptime(input.snapshot.captured_at, input.snapshot.server.started_at)}`;
  const endpointWidth = Math.max(0, input.width - uptime.length - 2);
  const value = truncateCell(`Endpoint: ${endpoint}  Bind mode: ${input.snapshot.server.bind_mode}`, endpointWidth, input.glyphs.ellipsis).padEnd(endpointWidth) + `  ${uptime}`;
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, styledText(
      truncateCell(value, input.width, input.glyphs.ellipsis),
      { sequence: input.palette.muted },
    )),
  );
}

function InkRule(input: {
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: CollectivePalette;
}): ReactNode {
  return h(Box, { width: input.width, height: 1, overflow: "hidden" },
    h(Text, null, styledText(input.glyphs.horizontal.repeat(input.width), { sequence: input.palette.chrome })));

}

function InkEmptyPanel(input: {
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly palette: CollectivePalette;
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
  readonly palette: CollectivePalette;
}): ReactNode {
  const { snapshot, cube, width, rows, glyphs, view, palette } = input;
  if (rows < 6 || width < 64) {
    return h(InkCompactDeck, { snapshot, cube, width, rows, glyphs, view, palette });
  }
  const desiredBoardRows = cube.drones.length + 4 + (cube.attention.unacked_directed > 0 ? 1 : 0);
  const scopeRows = Math.max(3, Math.min(rows - 3,
    Math.max(6, Math.min(Math.floor(rows * 0.5), rows - desiredBoardRows))));
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

function InkSensorScope(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly palette: CollectivePalette;
  readonly unframed?: boolean;
}): ReactNode {
  const inner = Math.max(1, input.unframed ? input.width : input.width - 2);
  const contentRows = Math.max(1, input.unframed ? input.rows : input.rows - 2);
  const windowMs = input.view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS;
  const mode = input.view.autoFollow || input.view.focusedCubeId === null ? "(auto)" : "(pinned)";
  const labelWidth = Math.min(16, Math.max(5, Math.floor(inner * 0.33)));
  const bucketCount = Math.max(1, Math.floor((inner - labelWidth) / 2));
  const canvasWidth = bucketCount * 2;
  const buckets = dashboardScopeBuckets(input.cube, input.snapshot.captured_at, windowMs, bucketCount);
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const coverage = buckets.reduce((sum, bucket) => sum + bucket.coverage, 0) / bucketCount;
  const ordered = prioritizeDrones(input.snapshot.captured_at, input.cube.drones);
  const visibleCount = Math.min(ordered.length, Math.max(0, contentRows - 9));
  const graphRows = Math.max(1, Math.min(5, contentRows - visibleCount - 6));
  const unknown = input.glyphs === ASCII_GLYPHS ? "/" : "░";
  const partial = input.glyphs === ASCII_GLYPHS ? ":" : "▒";
  const presence = input.glyphs === ASCII_GLYPHS ? "#" : "■";
  const quiet = input.glyphs.cube[0]!;
  const line = (key: string, label: string, cells: string, sequence = input.palette.muted): ReactNode => {
    const visibleLabel = truncateCell(label, labelWidth - 1, input.glyphs.ellipsis);
    return h(Text, { key }, styledText(visibleLabel + " ".repeat(labelWidth - terminalCellWidth(visibleLabel)),
      { sequence: input.palette.muted }) + styledText(cells, { sequence }));
  };
  const body: ReactNode[] = [h(Text, { key: "meta" }, styledText(truncateCell(
    `${formatWindow(windowMs)} ${formatBucketResolution(windowMs, bucketCount)} cov ${Math.round(coverage * 100)}% ${mode}` +
      (contentRows < 8 && ordered.length > 0 ? ` +${ordered.length} sender rows` : ""),
    inner, input.glyphs.ellipsis), { sequence: input.palette.muted }))];
  for (let row = 0; row < graphRows; row += 1) {
    const cells = buckets.map((bucket) => {
      const fill = Math.min(1, Math.max(0, bucket.count / maximum * graphRows - (graphRows - row - 1)));
      if (fill > 0) {
        // Fractional cells preserve count-height differences even in a one-row
        // plot; ASCII uses its ordered magnitude levels instead of full blocks.
        const level = Math.ceil(fill * (input.glyphs.cube.length - 1));
        return styledText(input.glyphs.cube[level]!.repeat(2), { sequence: input.palette.chrome });
      }
      return bucket.coverage === 0 ? styledText(unknown.repeat(2), { sequence: input.palette.inactive }) : "  ";
    }).join("");
    body.push(line(`volume-${row}`, row === 0 ? `${maximum} msgs` : "", cells, input.palette.chrome));
  }
  body.push(line("coverage", "0", buckets.map((bucket) =>
    (bucket.coverage === 0 ? unknown : bucket.coverage < 1 ? partial : quiet).repeat(2)).join("")));
  const axis = scopeAxis(canvasWidth, windowMs, input.glyphs);
  const sweep = scopeSweepPosition(canvasWidth, input.view.ambientPhase ?? 0, input.view.motionMode ?? "ambient");
  body.push(line("axis", "", sweep >= 0 && axis[sweep] === input.glyphs.horizontal
    ? axis.slice(0, sweep) + scopeSweepGlyph(input.glyphs) + axis.slice(sweep + 1) : axis, input.palette.chrome));
  body.push(h(Text, { key: "presence-label" }, styledText(truncateCell(
    coverage === 0 ? "Observation pending" : "MESSAGE PRESENCE", inner, input.glyphs.ellipsis),
    { sequence: input.palette.data })));
  ordered.slice(0, visibleCount).forEach((drone, index) => {
    body.push(line(`sender-${drone.id}`, `${index + 1} ${dashboardText(drone.label, input.glyphs)}`,
      buckets.map((bucket) => {
        const marker = bucket.senders.has(drone.id) ? presence
          : bucket.coverage === 0 ? unknown : bucket.coverage < 1 ? partial : quiet;
        return styledText(marker.repeat(2), { sequence: marker === presence ? input.palette.data
          : marker === partial ? input.palette.muted : input.palette.inactive });
      }).join(""), input.palette.data));
  });
  if (visibleCount < ordered.length) body.push(h(Text, { key: "omitted" }, `+${ordered.length - visibleCount} sender rows`));
  body.push(h(Text, { key: "legend" }, styledText(truncateCell(
    `${unknown} unknown ${partial} partial ${quiet} quiet`, inner, input.glyphs.ellipsis), { sequence: input.palette.muted })));
  const fittedBody = body.slice(0, contentRows).map((node, index) => h(Box, {
    key: index, width: inner, height: 1, minHeight: 1, flexShrink: 0, overflow: "hidden",
  }, node));
  if (input.unframed) return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, fittedBody);
  return h(Box, { width: input.width, height: input.rows, flexDirection: "column", overflow: "hidden" }, [
    h(InkPanelTitle, { key: "title", title: ` SENSOR SCOPE ${dashboardText(input.cube.name, input.glyphs)} `,
      width: input.width, glyphs: input.glyphs, palette: input.palette }),
    h(Box, { key: "body", width: input.width, height: input.rows - 1, flexDirection: "column",
      borderStyle: borderStyle(input.glyphs), borderTop: false, overflow: "hidden",
      ...(input.palette.chromeColor === "" ? {} : { borderColor: input.palette.chromeColor }) }, fittedBody),
  ]);
}

export function dashboardScopeBuckets(
  cube: DashboardCubeSnapshot,
  capturedAt: string,
  windowMs: number,
  count: number,
): readonly { readonly count: number; readonly coverage: number; readonly senders: ReadonlySet<string> }[] {
  const end = Date.parse(capturedAt);
  const start = end - windowMs;
  const observedFrom = cube.scope === undefined ? end : Math.max(start, Date.parse(cube.scope.observed_from));
  const duration = windowMs / count;
  const buckets = Array.from({ length: count }, (_, index) => ({
    count: 0,
    coverage: observedFrom <= start + index * duration ? 1
      : observedFrom >= start + (index + 1) * duration ? 0
      : (start + (index + 1) * duration - observedFrom) / duration,
    senders: new Set<string>(),
  }));
  for (const message of cube.scope?.messages ?? []) {
    const time = Date.parse(message.created_at);
    if (time < start || time > end) continue;
    const index = Math.min(count - 1, Math.floor((time - start) / duration));
    const bucket = buckets[index]!;
    bucket.count += 1;
    if (message.drone_id !== null) bucket.senders.add(message.drone_id);
  }
  return buckets;
}

function InkDroneBoard(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly rows: number;
  readonly glyphs: Glyphs;
  readonly palette: CollectivePalette;
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
            drone: { ...item.drone, label: `${prioritized.indexOf(item.drone) + 1} ${item.drone.label}` },
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
  readonly palette: CollectivePalette;
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
  readonly palette: CollectivePalette;
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
  readonly palette: CollectivePalette;
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
        : `${input.drone.attention.stale_directed > 0
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
  readonly palette: CollectivePalette;
}): ReactNode {
  const plainLeft = `${input.glyphs.topLeft}${input.title}`;
  const left = input.palette.chrome === ""
    ? plainLeft
    : `${input.glyphs.topLeft}${input.palette.chrome}${input.title}${textReset}`;
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

function formatBucketResolution(windowMs: number, bucketCount: number): string {
  const seconds = Number((windowMs / bucketCount / 1_000).toFixed(2));
  return `${seconds * bucketCount * 1_000 === windowMs ? "" : "~"}${seconds}s/b`;
}


function InkSummaryRow(input: {
  readonly snapshot: DashboardSnapshot;
  readonly cube: DashboardCubeSnapshot;
  readonly width: number;
  readonly glyphs: Glyphs;
  readonly view: DashboardViewState;
  readonly maximumPosts: number;
  readonly palette: CollectivePalette;
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
  readonly palette: CollectivePalette;
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
  const withMotion = [...segments.slice(0, -1), `motion: ${input.motionMode}`, input.baseFooter];
  if (!input.motionAutoDegraded && footerSegmentsWidth(withMotion) <= input.width) {
    segments.splice(segments.length - 1, 0, `motion: ${input.motionMode}`);
  }
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
  readonly palette: CollectivePalette;
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
  readonly palette: CollectivePalette;
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
  return opening === "" ? value : `${opening}${value}${/\u001b\[(?:48;|4[0-7]m|10[0-7]m)/u.test(opening) ? reset : textReset}`;
}

function livenessStyle(
  capturedAt: string,
  lastActivity: string | null,
  palette: CollectivePalette,
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

function scopeSweepPosition(width: number, phase: number, motionMode: "ambient" | "calm" | "off"): number {
  const boundedWidth = Math.max(1, width);
  return motionMode === "off" ? boundedWidth - 1 : Math.abs(Math.floor(phase)) % boundedWidth;
}

function scopeSweepGlyph(glyphs: Glyphs): string {
  return glyphs === ASCII_GLYPHS ? ":" : "░";
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
  palette: CollectivePalette,
): string {
  if (palette.attention === "") return value;
  return `${drone.attention.stale_directed > 0 ? palette.attention : palette.liveness}${value}${textReset}`;
}

function heatGlyph(posts: number, maximumPosts: number, glyphs: Glyphs): string {
  if (posts <= 0 || maximumPosts <= 0) return glyphs.cube[0]!;
  const index = Math.min(
    glyphs.cube.length - 1,
    Math.max(1, Math.ceil((Math.log1p(posts) / Math.log1p(maximumPosts)) * (glyphs.cube.length - 1))),
  );
  return glyphs.cube[index]!;
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
    const padded = padInkRow(line, width);
    if (background === "") return padded;
    const base = `${background}${defaultForeground}`;
    return `${base}${padded.replace(/\u001b\[(?:0|39|49)?m/gu, (sequence) => `${sequence}${sequence === "\u001b[39m" ? defaultForeground : base}`)}${reset}`;
  }).join("\n");
}

function collectivePalette(depth: DashboardColorDepth): CollectivePalette {
  if (depth === "none") {
    return { primary: "", identity: "", statusBand: "", attentionBand: "", panelColor: "", selectionColor: "", background: "", backgroundColor: "", chrome: "", chromeColor: "", data: "", liveness: "", attention: "", muted: "", inactive: "" };
  }
  if (depth === "truecolor") {
    return {
      primary: "\u001b[38;2;213;229;218m",
      identity: "\u001b[48;2;162;245;110m\u001b[38;2;6;12;9m",
      statusBand: "\u001b[48;2;81;188;160m\u001b[38;2;6;12;9m",
      attentionBand: "\u001b[48;2;53;48;28m\u001b[38;2;255;202;130m",
      panelColor: "rgb(13, 25, 18)",
      selectionColor: "rgb(35, 60, 38)",
      background: "\u001b[48;2;6;12;9m",
      backgroundColor: "rgb(6, 12, 9)",
      chrome: "\u001b[38;2;162;245;110m",
      chromeColor: "rgb(162, 245, 110)",
      data: "\u001b[38;2;81;188;160m",
      liveness: "\u001b[38;2;81;188;160m",
      attention: "\u001b[38;2;255;202;130m",
      muted: "\u001b[38;2;148;173;156m",
      inactive: "\u001b[38;2;41;65;50m",
    };
  }
  if (depth === "ansi256") {
    return {
      primary: "\u001b[38;5;253m",
      identity: "\u001b[48;5;155m\u001b[30m",
      statusBand: "\u001b[48;5;72m\u001b[30m",
      attentionBand: "\u001b[48;5;58m\u001b[38;5;223m",
      panelColor: "ansi256(233)",
      selectionColor: "ansi256(22)",
      background: "\u001b[48;5;232m",
      backgroundColor: "ansi256(232)",
      chrome: "\u001b[38;5;155m",
      chromeColor: "ansi256(155)",
      data: "\u001b[38;5;72m",
      liveness: "\u001b[38;5;72m",
      attention: "\u001b[38;5;223m",
      muted: "\u001b[38;5;108m",
      inactive: "\u001b[38;5;237m",
    };
  }
  return {
    primary: "\u001b[37m",
    identity: "\u001b[102m\u001b[30m",
    statusBand: "\u001b[46m\u001b[30m",
    attentionBand: "\u001b[40m\u001b[93m",
    panelColor: "black",
    selectionColor: "black",
    background: "\u001b[40m",
    backgroundColor: "black",
    chrome: "\u001b[92m",
    chromeColor: "greenBright",
    data: "\u001b[36m",
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

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}
