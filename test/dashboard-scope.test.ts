import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { dashboardScopeBuckets, normalizeInkFrame } from "../src/dashboard-ink.js";
import {
  createDashboardRenderer, rankDashboardSnapshot, startForegroundDashboard, STANDALONE_DASHBOARD_FOOTER,
  type DashboardDataSnapshot, type DashboardServerIdentity,
} from "../src/dashboard.js";

const server: DashboardServerIdentity = {
  name: "borgmcp-server", version: "4.1.0", endpoint: "https://127.0.0.1:7091",
  bind_mode: "loopback", state: "online", started_at: "2026-09-06T09:00:00.000Z",
};
const now = "2026-09-06T12:00:00.000Z";
const start = "2026-09-06T11:45:00.000Z";
const attention = { unacked_directed: 0, stale_directed: 0, oldest_unacked: null } as const;
const drones = ["coordinator", "builder-01", "builder-02", "website", "builder-03", "reviewer", "quality", "security", "builder-04", "design", "strategy"]
  .map((label, index) => ({
    id: `sender-${index}`, label, role: index === 0 ? "Coordinator" : "Builder",
    reported_model: "model-a", last_seen: now, sent: index + 1, sent_5s: 0, received: 0, attention,
  }));
const data: DashboardDataSnapshot = {
  captured_at: now, attention,
  recent_activity: drones.slice(0, 4).map((drone, index) => ({
    id: `entry-${index}`, cube_name: "demo-project", actor_kind: "drone-session", actor_label: drone.label,
    actor_role: drone.role, created_at: now, visibility: "broadcast", recipient_count: 0,
    activity_class: "status", message_head: "Review evidence is available.",
  })),
  cubes: Array.from({ length: 14 }, (_, index) => ({
    id: `cube-${index}`, name: index === 0 ? "demo-project" : `sample-${index + 1}`,
    posts_15m: index === 0 ? 66 : 0, distinct_posting_drones_15m: index === 0 ? 11 : 0,
    drones_total: index === 0 ? 11 : 0, drones_seen_15m: index === 0 ? 11 : 0,
    last_post_at: index === 0 ? now : null, drones: index === 0 ? drones : [], attention,
    scope: { observed_from: start, messages: index === 0 ? drones.flatMap((drone, sender) =>
      Array.from({ length: sender + 1 }, (_, event) => ({
        created_at: new Date(Date.parse(start) + (sender * 61 + event * 17) * 1_000).toISOString(),
        drone_id: drone.id,
      }))) : [] },
  })),
};
const render = createDashboardRenderer({
  glyphMode: "box", color: true, colorDepth: "truecolor", motionMode: "off",
  navigation: true, footer: STANDALONE_DASHBOARD_FOOTER,
});
const mono = createDashboardRenderer({ glyphMode: "box", color: false, motionMode: "off", footer: STANDALONE_DASHBOARD_FOOTER });
const strip = (value: string): string => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");

describe("Command scope", () => {
  it("counts exact boundary messages once and shares sender cells with volume", () => {
    const cube = rankDashboardSnapshot(data, server).cubes[0]!;
    const scope = { observed_from: start, messages: [
      { created_at: "2026-09-06T11:48:45.000Z", drone_id: "sender-0" },
      { created_at: "2026-09-06T11:48:46.000Z", drone_id: "sender-0" },
      { created_at: now, drone_id: "sender-1" },
      { created_at: "2026-09-06T11:44:59.999Z", drone_id: "sender-2" },
      { created_at: "2026-09-06T12:00:00.001Z", drone_id: "sender-2" },
    ] };
    const buckets = dashboardScopeBuckets({ ...cube, scope }, now, 900_000, 4);
    expect(buckets.map((bucket) => bucket.count)).toEqual([0, 2, 0, 1]);
    expect(buckets.map((bucket) => [...bucket.senders])).toEqual([[], ["sender-0"], [], ["sender-1"]]);
    const single = dashboardScopeBuckets({ ...cube, scope: { ...scope, messages: scope.messages.slice(0, 1) } }, now, 900_000, 4);
    expect(single[1]?.count).toBe(1);
    expect(single[1]?.senders).toEqual(buckets[1]?.senders);
    for (const count of [1, 7, 31]) {
      expect(dashboardScopeBuckets({ ...cube, scope }, now, 900_000, count).every((bucket) => bucket.coverage === 1)).toBe(true);
      expect(dashboardScopeBuckets({ ...cube, scope }, now, 900_000, count).reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
    }
  });

  it("distinguishes full quiet, partial coverage, unknown history, and observation pending", () => {
    const snapshot = rankDashboardSnapshot(data, server);
    const cube = snapshot.cubes[0]!;
    const quiet = { ...cube, scope: { observed_from: start, messages: [] } };
    const partial = { ...cube, scope: { observed_from: "2026-09-06T11:50:00.000Z", messages: [] } };
    expect(dashboardScopeBuckets(quiet, now, 900_000, 4).map((bucket) => bucket.coverage)).toEqual([1, 1, 1, 1]);
    expect(dashboardScopeBuckets(partial, now, 900_000, 4).map((bucket) => bucket.coverage)).toEqual([0, 2 / 3, 1, 1]);
    const renderCube = (value: typeof cube) => mono({ ...snapshot, cubes: [value] }, 168, 64);
    const quietFrame = renderCube(quiet);
    const partialFrame = renderCube(partial);
    const pendingFrame = renderCube({ ...cube, scope: { observed_from: now, messages: [] } });
    expect(quietFrame).toContain("cov 100%");
    expect(partialFrame).toContain("cov 67%");
    expect(partialFrame).toContain("░░");
    expect(partialFrame).toContain("▒▒");
    expect(quietFrame).toContain("··");
    expect(pendingFrame).toContain("Observation pending");
    expect(pendingFrame).toContain("cov 0%");
    expect(new Set([quietFrame, partialFrame, pendingFrame]).size).toBe(3);
  });

  it("aligns sender traces with the board and reports omitted rows", () => {
    const snapshot = rankDashboardSnapshot(data, server);
    const frame = mono(snapshot, 168, 64);
    expect(frame).toContain("MESSAGE PRESENCE");
    const lines = frame.split("\n");
    const board = lines.filter((line) => /LIVE\s+\d+ [a-z]/u.test(line)).map((line) => line.match(/LIVE\s+(\d+) /u)![1]);
    const traces = lines.slice(lines.findIndex((line) => line.includes("MESSAGE PRESENCE")) + 1).filter((line) => /│\d+ [a-z]/u.test(line)).map((line) => line.match(/│(\d+) /u)![1]);
    expect(board).toEqual(traces);
    expect(board).toHaveLength(11);
    const short = mono(snapshot, 120, 24);
    expect(short).toMatch(/\+\d+ sender rows/u);
    const axis = lines.find((line) => line.includes("15m") && line.includes("now"))!;
    const presence = lines.find((line) => line.includes("■■"))!;
    expect(presence.indexOf("■■")).toBeGreaterThanOrEqual(axis.indexOf("15m"));
  });

  it("restores dark cells after explicit background reset and full reset", () => {
    const background = "\u001b[48;2;6;12;9m";
    const source = "\u001b[48;2;13;25;18mtext\u001b[49m pad\u001b[0m tail";
    const frame = normalizeInkFrame(source, 20, 2, background);
    expect(frame).toContain(`\u001b[49m${background}`);
    expect(frame).toContain(`\u001b[0m${background}`);
    for (const line of frame.split("\n")) expect(stringWidth(strip(line))).toBe(20);
  });

  it.each(["white", "black"])("repaints shorter content and resize over a %s terminal default", async (defaultBackground) => {
    let columns = 120, rows = 40;
    let current: DashboardDataSnapshot = {
      ...data, recent_activity: data.recent_activity.map((entry) => ({ ...entry, message_head: "STALE_CONTENT_".repeat(8) })),
    };
    let notify = () => {}, resize = () => {};
    const writes: { value: string; columns: number; rows: number }[] = [];
    const dashboard = startForegroundDashboard({
      server, renderer: render, eventCoalesceMs: 0, resizeDebounceMs: 0,
      source: { read: () => current, subscribe: (listener) => { notify = listener; return () => {}; } },
      terminal: {
        dimensions: () => ({ columns, rows }),
        write: (value) => { writes.push({ value, columns, rows }); },
        onResize: (listener) => { resize = listener; return () => {}; },
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(replayTerminal(writes, defaultBackground).text).toContain("STALE_CONTENT");
      current = { ...data, recent_activity: data.recent_activity.map((entry) => ({ ...entry, message_head: "ok" })) };
      notify();
      await new Promise((resolve) => setTimeout(resolve, 20));
      let screen = replayTerminal(writes, defaultBackground);
      expect(screen.text).not.toContain("STALE_CONTENT");
      expect(screen.backgrounds).not.toContain(defaultBackground);
      columns = 168; rows = 64; resize();
      await new Promise((resolve) => setTimeout(resolve, 20));
      screen = replayTerminal(writes, defaultBackground);
      expect(screen.text).toContain("demo-project/coordinator");
      expect(screen.text).not.toContain("STALE_CONTENT");
      expect(screen.backgrounds).not.toContain(defaultBackground);
    } finally { dashboard.close(); }
  });

  it.each([[168, 64], [120, 40], [80, 30], [40, 10], [39, 9]])("captures the real renderer at %i×%i", (columns, rows) => {
    const frame = render(rankDashboardSnapshot(data, server), columns, rows);
    const lines = strip(frame).split("\n");
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true);
    if (columns >= 100) {
      expect(lines.find((line) => line.includes("SENSOR SCOPE"))).toContain("DRONES");
    } else if (columns === 80) {
      expect(lines.findIndex((line) => line.includes("SENSOR SCOPE")))
        .toBeLessThan(lines.findIndex((line) => line.includes("DRONES")));
    }
    if (process.env["UPDATE_DASHBOARD_CAPTURES"] === "1") {
      const directory = join(import.meta.dirname, "fixtures/dashboard-command");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${columns}x${rows}.ansi`), frame + "\n");
      writeFileSync(join(directory, `${columns}x${rows}.html`), captureHtml(frame, `${columns}×${rows}`));
    }
  });
});

// Interpret the cursor/erase/SGR operations emitted by the real Ink path. The
// fixtures use single-cell characters; this is not a general terminal emulator.
function replayTerminal(writes: readonly { value: string; columns: number; rows: number }[], defaultBackground: string): {
  text: string; backgrounds: string[];
} {
  let width = 0, height = 0, x = 0, y = 0, background = defaultBackground;
  let cells: { text: string; background: string }[][] = [];
  const blank = () => ({ text: " ", background });
  const newline = () => {
    x = 0; y += 1;
    if (y >= height) { cells.shift(); cells.push(Array.from({ length: width }, blank)); y = height - 1; }
  };
  for (const write of writes) {
    if (write.columns !== width || write.rows !== height) {
      width = write.columns; height = write.rows;
      cells = Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, column) =>
        cells[row]?.[column] ?? { text: " ", background: defaultBackground }));
      x = Math.min(x, width - 1); y = Math.min(y, height - 1);
    }
    for (const match of write.value.matchAll(/\u001b\[[0-?]*[ -/]*[@-~]|[^\u001b]/gu)) {
      const token = match[0];
      if (token.startsWith("\u001b[")) {
        const command = token.at(-1), raw = token.slice(2, -1);
        if (raw.startsWith("?")) continue;
        const values = raw.split(";").map(Number), amount = values[0] || 1;
        if (command === "m") {
          for (let index = 0; index < values.length; index += 1) {
            const code = values[index];
            if (code === 0 || code === 49) background = defaultBackground;
            if (code === 48 && values[index + 1] === 2) { background = values.slice(index + 2, index + 5).join(","); index += 4; }
            else if (code === 48 && values[index + 1] === 5) { background = `palette:${values[index + 2]}`; index += 2; }
            else if (code === 38) index += values[index + 1] === 2 ? 4 : 2;
            else if (code !== undefined && ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))) background = `ansi:${code}`;
          }
        } else if (command === "H" || command === "f") { y = Math.max(0, (values[0] || 1) - 1); x = Math.max(0, (values[1] || 1) - 1); }
        else if (command === "G") x = amount - 1;
        else if (command === "A") y = Math.max(0, y - amount);
        else if (command === "B") y = Math.min(height - 1, y + amount);
        else if (command === "C") x = Math.min(width - 1, x + amount);
        else if (command === "D") x = Math.max(0, x - amount);
        else if (command === "J" || command === "K") {
          const position = y * width + x;
          for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
            const cell = row * width + column;
            if ((command === "J" || row === y) && (values[0] === 2 || (values[0] === 1 ? cell <= position : cell >= position))) cells[row]![column] = blank();
          }
        }
      } else if (token === "\n") newline();
      else if (token === "\r") x = 0;
      else if (token >= " ") {
        if (x >= width) newline();
        cells[y]![x] = { text: token, background }; x += 1;
      }
    }
  }
  return { text: cells.map((row) => row.map((cell) => cell.text).join("")).join("\n"), backgrounds: cells.flat().map((cell) => cell.background) };
}

function captureHtml(frame: string, title: string): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  let foreground = "#111", background = "#fff";
  const parts = frame.split(/(\u001b\[[0-9;]*m)/u);
  const body = parts.map((part) => {
    if (!part.startsWith("\u001b[")) return `<span style="color:${foreground};background:${background}">${escape(part)}</span>`;
    const codes = part.slice(2, -1).split(";").map(Number);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 0) { foreground = "#111"; background = "#fff"; }
      if (code === 39) foreground = "#111";
      if (code === 49) background = "#fff";
      if ((code === 38 || code === 48) && codes[index + 1] === 2) {
        const color = `rgb(${codes.slice(index + 2, index + 5).join(",")})`;
        if (code === 38) foreground = color; else background = color;
        index += 4;
      }
    }
    return "";
  }).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Dashboard ${title}</title><style>body{margin:24px;background:#eee}pre{font:14px/1.2 ui-monospace,monospace;white-space:pre;width:max-content;background:#060c09}</style><h1>Dashboard ${title}</h1><p>Synthetic fixture through the production renderer. Terminal default: light.</p><pre>${body}</pre></html>\n`;
}
