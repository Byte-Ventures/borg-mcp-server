import { createElement as h, type ReactNode } from "react";
import { Box, renderToString, Text, Transform } from "ink";

import {
  ASCII_GLYPHS,
  BOX_GLYPHS,
  DASHBOARD_ACTIVITY_WINDOW_MS,
  EMBEDDED_DASHBOARD_FOOTER,
  EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER,
  renderDashboardFooter,
  renderEmptyPanel,
  renderFocusPanel,
  renderPlainDashboard,
  renderRail,
  renderSummaryRow,
  fitCell,
  wrapDashboardFooter,
  type DashboardRenderOptions,
  type DashboardSnapshot,
  type DashboardViewState,
} from "./dashboard.js";

export interface InkRenderOptions extends DashboardRenderOptions {
  readonly baseFooter: string;
}

/**
 * The dashboard's public renderer remains a synchronous function because the
 * frame oracle and the plain fallback are synchronous. Ink owns the component
 * tree and layout; renderToString is Ink's synchronous, terminal-free adapter
 * for that API. The live dashboard uses the same tree through Ink's renderer.
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
  if (width < 40 || height < 10) {
    return renderPlainDashboard(snapshot, width, height, options.footer);
  }
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
  const glyphs = options.glyphMode === "ascii" ? ASCII_GLYPHS : BOX_GLYPHS;
  const lifecycleFooter = options.footer === EMBEDDED_DASHBOARD_FOOTER
    ? wrapDashboardFooter(EMBEDDED_DASHBOARD_LIFECYCLE_FOOTER, width)
    : [];
  const maximumPosts = Math.max(...snapshot.cubes.map((cube) => cube.posts_15m), 0);
  const footerRows = lifecycleFooter.length + 1;
  const chromeRows = 3 + footerRows;
  const bodyRows = Math.max(0, height - chromeRows);
  const listCap = Math.max(1, Math.floor(bodyRows * 0.42));
  const listRows = Math.min(snapshot.cubes.length, listCap);
  const panelRows = Math.max(1, bodyRows - listRows);
  const focus = view.autoFollow || view.focusedCubeId === null
    ? snapshot.cubes[0]
    : snapshot.cubes.find((cube) => cube.id === view.focusedCubeId) ?? snapshot.cubes[0];
  const pageCount = Math.max(1, Math.ceil(snapshot.cubes.length / listCap));
  const page = Math.max(0, view.page ?? 0) % pageCount;
  const pageStart = page * listCap;

  const children: ReactNode[] = [
    inkLine(renderRail(snapshot, width, glyphs, options.color), "rail"),
    inkLine(glyphs.horizontal.repeat(width), "separator-top"),
  ];
  const panelLines = focus === undefined
    ? renderEmptyPanel(width, glyphs)
    : renderFocusPanel(snapshot, focus, width, panelRows, glyphs, view, options.color);
  children.push(...panelLines.map((line, index) => inkLine(
    fitCell(line, width, " ", glyphs.ellipsis),
    `panel-${index}`,
  )));
  children.push(inkLine(glyphs.horizontal.repeat(width), "separator-bottom"));
  for (const [index, cube] of snapshot.cubes.slice(pageStart, pageStart + listRows).entries()) {
    children.push(inkLine(renderSummaryRow(
      snapshot,
      cube,
      width,
      glyphs,
      view,
      maximumPosts,
      options.color,
    ), `summary-${index}`));
  }
  children.push(...lifecycleFooter.map((line, index) => inkLine(
    fitCell(line, width, " ", glyphs.ellipsis),
    `lifecycle-${index}`,
  )));
  children.push(inkLine(fitCell(renderDashboardFooter(
    snapshot,
    width,
    options.navigation === true,
    view.activityWindowMs ?? DASHBOARD_ACTIVITY_WINDOW_MS,
    page,
    pageCount,
    options.baseFooter,
    glyphs,
  ), width, " ", glyphs.ellipsis), "footer"));

  return h(Box, { width, height, flexDirection: "column", overflow: "hidden" }, children);
}

function finiteDimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function inkLine(line: string, key: string): ReactNode {
  const plain = stripAnsi(line);
  if (!line.includes("\u001b[")) return h(Text, { key, wrap: "truncate-end" }, plain);
  return h(
    Transform,
    { key, transform: () => line },
    h(Text, { wrap: "truncate-end" }, plain),
  );
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
  const visible = Array.from(stripAnsi(line)).length;
  const missing = Math.max(0, width - visible);
  if (missing === 0) return line;
  const suffix = line.match(/(\u001b\[[0-?]*[ -/]*[@-~])$/u)?.[1];
  if (suffix === undefined) return `${line}${" ".repeat(missing)}`;
  return `${line.slice(0, -suffix.length)}${" ".repeat(missing)}${suffix}`;
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
