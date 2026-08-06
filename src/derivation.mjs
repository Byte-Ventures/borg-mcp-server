// Falsification of the DERIVATION path (bebea8b3 ruling 1).
// Drives the REAL startForegroundDashboard through its injected `source` and
// `terminal` seams. NOTHING is exported for testability — both seams already
// exist in production and both entry points already use them.
import {
  startForegroundDashboard, createDashboardRenderer, EMBEDDED_DASHBOARD_FOOTER,
} from "./dashboard.ts";

const STEPS = 40;            // 40 ticks x 5s = 200s of the 15m window
const TICK_MS = 5000;        // one DASHBOARD_IDLE_REFRESH_MS bucket per tick
const T0 = Date.parse("2026-08-06T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const SERVER = { name: "borg-mcp-server", version: "0.10.1", endpoint: "https://127.0.0.1:7091",
                 state: "online", started_at: iso(T0 - 3600_000) };

// Both posting drones report an IDENTICAL, CONSTANT 50 posts per tick.
// The only difference: every 4th tick, #pruneActivity removes 60 of the pruned
// drone's older rows, so its cumulative `sent` goes DOWN while it is posting.
const sentSteady = (i) => 1000 + i * 50;
const sentPruned = (i) => { let s = 1000; for (let k = 1; k <= i; k++) s += (k % 4 === 0) ? -60 : 50; return s; };

const dataAt = (i) => ({
  captured_at: iso(T0 + i * TICK_MS),
  cubes: [{
    id: "c1", name: "hive", posts_15m: 40 + i, distinct_posting_drones_15m: 2,
    drones_total: 3, drones_seen_15m: 3, last_post_at: iso(T0 + i * TICK_MS),
    drones: [
      { id: "d-steady", label: "drone-steady", role: "Builder", last_seen: iso(T0 + i * TICK_MS), sent: sentSteady(i), sent_5s: 50, received: 10 },
      { id: "d-pruned", label: "drone-pruned", role: "Builder", last_seen: iso(T0 + i * TICK_MS), sent: sentPruned(i), sent_5s: 50, received: 10 },
      { id: "d-zero", label: "drone-zero", role: "Builder", last_seen: iso(T0 + i * TICK_MS), sent: 0, sent_5s: 0, received: 10 },
    ],
  }],
});

let step = 0;
let notify = () => {};
const source = { read: () => dataAt(step), subscribe: (listener) => { notify = listener; return () => { notify = () => {}; }; } };
const frames = [];
const terminal = { write: (value) => frames.push(value), dimensions: () => ({ columns: 100, rows: 20 }), onResize: () => () => {} };

const dashboard = startForegroundDashboard({
  source, server: SERVER, terminal,
  renderer: createDashboardRenderer({ glyphMode: "box", color: false, footer: EMBEDDED_DASHBOARD_FOOTER, navigation: false }),
  fallbackFooter: EMBEDDED_DASHBOARD_FOOTER,
  eventCoalesceMs: 2,        // real timers, just short — the loop is unmodified
  idleRefreshMs: 600_000,    // keep the idle tick out of the way
  pulseFrameMs: 600_000,
});
dashboard.failure.catch((error) => console.log("DASHBOARD FAILURE:", error && error.message));
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await settle(30);
for (step = 1; step < STEPS; step += 1) { notify(); await settle(12); }
dashboard.close();

const last = [...frames].reverse().find((frame) => frame.includes("drone-steady"));
if (last === undefined) throw new Error("dashboard produced no frame containing drone-steady");
const lines = last.split("\n");
const rowFor = (label) => {
  const index = lines.findIndex((line) => line.includes(label));
  if (index < 0) throw new Error(`missing drone row: ${label}`);
  if (lines[index + 1] === undefined) throw new Error(`missing graph row: ${label}`);
  return lines.slice(index + 1, index + 3).join("\n");
};
const steady = rowFor("drone-steady");
const pruned = rowFor("drone-pruned");
const zero = rowFor("drone-zero");
const BAR = "▁▂▃▄▅▆▇█";
const bars = (value) => [...value].filter((character) => BAR.includes(character)).length;
const dots = (value) => [...value].filter((character) => character === "·").length;
const firstMark = (value) => [...value].findIndex((character) => character === "·" || BAR.includes(character));
const checks = [];
const check = (label, condition, detail) => {
  checks.push(condition);
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
};

console.log(`sent, steady: ${[0, 1, 2, 3, 4, 5].map(sentSteady).join(" -> ")} ...   (always +50/tick)`);
console.log(`sent, pruned: ${[0, 1, 2, 3, 4, 5].map(sentPruned).join(" -> ")} ...   (+50, but -60 every 4th tick)`);
console.log("Both drones post 50 per tick throughout. Only the cumulative counter differs.\n");
console.log(`steady  bars=${String(bars(steady)).padStart(3)}  silent-marker=${String(dots(steady)).padStart(3)}`);
console.log(`pruned  bars=${String(bars(pruned)).padStart(3)}  silent-marker=${String(dots(pruned)).padStart(3)}`);
console.log(`zero    bars=${String(bars(zero)).padStart(3)}  silent-marker=${String(dots(zero)).padStart(3)}\n`);

check("POSITIVE CONTROL  steady draws bars", bars(steady) > 0, "harness renders observed activity");
check("BASELINE          silent for NEITHER when both are posting",
  firstMark(steady) >= 0 && firstMark(pruned) >= 0 && steady[firstMark(steady)] !== "·" && pruned[firstMark(pruned)] !== "·",
  "the first positive per-tick observation is a bar");
check("NEGATIVE CONTROL  zero-count control draws the zero marker", dots(zero) > 0, "zero-rate samples remain visible");
check("FALSIFICATION     posting drones never read SILENT", dots(steady) === 0 && dots(pruned) === 0,
  "no observed-zero marker in any positive per-tick slot");

console.log("\nsteady: " + steady.slice(60).replace(/\s+$/, ""));
console.log("pruned: " + pruned.slice(60).replace(/\s+$/, ""));
console.log("zero:   " + zero.slice(60).replace(/\s+$/, ""));
process.exit(checks.every(Boolean) ? 0 : 1);
