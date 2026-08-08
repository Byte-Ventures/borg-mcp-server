import stringWidth from "string-width";

import {
  ASCII_GLYPHS,
  EMBEDDED_DASHBOARD_FOOTER,
  STANDALONE_DASHBOARD_FOOTER,
  sanitizeTerminalText,
  type DashboardFooter,
  type DashboardSnapshot,
} from "./dashboard.js";

/**
 * The plain path is only the failure/tiny-terminal fallback. The normal
 * dashboard is composed in dashboard-ink.ts; keeping this fallback separate
 * prevents its deliberately lossy text layout from becoming an Ink input.
 */
export function renderPlainDashboard(
  snapshot: DashboardSnapshot,
  columns = 80,
  rows = 20,
  footer?: DashboardFooter,
): string {
  const width = boundedPlainDimension(columns, 20, 500);
  const height = boundedPlainDimension(rows, 4, 200);
  const totalPosts = snapshot.cubes.reduce((sum, cube) => sum + cube.posts_15m, 0);
  const lines = [
    plainCell(
      `${sanitizeTerminalText(snapshot.server.name)} ${snapshot.server.state}`,
      width,
      ASCII_GLYPHS.ellipsis,
    ),
    plainCell(
      `Endpoint: ${sanitizeTerminalText(snapshot.server.endpoint)}  Bind mode: ${snapshot.server.bind_mode}`,
      width,
      ASCII_GLYPHS.ellipsis,
    ),
    plainCell(`${snapshot.cubes.length} cubes | ${totalPosts} posts/15m`, width, ASCII_GLYPHS.ellipsis),
    ...plainFooter(footer, width),
  ];
  const available = Math.max(0, height - lines.length);
  for (const cube of snapshot.cubes.slice(0, available)) {
    lines.push(plainCell(
      `${cube.rank}. ${sanitizeTerminalText(cube.name)} ${cube.posts_15m}/15m ` +
      `${plainAge(snapshot.captured_at, cube.last_post_at)}`,
      width,
      ASCII_GLYPHS.ellipsis,
    ));
  }
  return lines.join("\n");
}

function plainFooter(footer: DashboardFooter | undefined, width: number): string[] {
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

function plainCell(value: string, width: number, ellipsis: string): string {
  const targetWidth = Math.max(0, width);
  if (stringWidth(value) <= targetWidth) return `${value}${blank(targetWidth - stringWidth(value))}`;
  const suffix = targetWidth >= 4 ? ellipsis : "";
  const target = Math.max(0, targetWidth - stringWidth(suffix));
  let result = "";
  for (const character of value) {
    if (stringWidth(result + character) > target) break;
    result += character;
  }
  return `${result}${suffix}${blank(Math.max(0, targetWidth - stringWidth(result + suffix)))}`;
}

function blank(width: number): string {
  return Array.from({ length: Math.max(0, width) }, () => " ").join("");
}

function boundedPlainDimension(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function plainAge(capturedAt: string, timestamp: string | null): string {
  if (timestamp === null) return "never";
  const age = Math.max(0, Date.parse(capturedAt) - Date.parse(timestamp));
  if (!Number.isFinite(age)) return "unknown";
  if (age < 60_000) return "<1m";
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 24 * 60 * 60_000) return `${Math.floor(age / (60 * 60_000))}h`;
  return `${Math.floor(age / (24 * 60 * 60_000))}d`;
}
