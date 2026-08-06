// Post-split derivation gate, against the TWO-FIELD shape (b037bfab, 77e4da75).
// Drives the real startForegroundDashboard through its injected source/terminal.
// Ratified condition: continuous positive per-tick counts produce NO observed-zero
// marker in ANY slot INCLUDING THE FIRST; a zero-count control produces the marker.
import { startForegroundDashboard, createDashboardRenderer, EMBEDDED_DASHBOARD_FOOTER } from "./dashboard.ts";
const STEPS = 40, TICK_MS = 5000;
const T0 = Date.parse("2026-08-06T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const SERVER = { name:"borg-mcp-server", version:"0.10.1", endpoint:"https://127.0.0.1:7091",
                 state:"online", started_at: iso(T0 - 3600_000) };
// steady : cumulative rises,  per-tick 50   -> must never render the zero marker
// pruned : cumulative FALLS,  per-tick 50   -> the regression guard: a decreasing
//          cumulative counter must no longer reach the graph at all
// silent : cumulative flat,   per-tick 0    -> the zero-count control, must render it
const cumSteady = (i) => 1000 + i * 50;
const cumPruned = (i) => { let s = 1000; for (let k = 1; k <= i; k++) s += (k % 4 === 0) ? -60 : 50; return s; };
const dataAt = (i) => ({
  captured_at: iso(T0 + i * TICK_MS),
  cubes: [{ id:"c1", name:"hive", posts_15m: 40 + i, distinct_posting_drones_15m: 3,
    drones_total: 3, drones_seen_15m: 3, last_post_at: iso(T0 + i * TICK_MS),
    drones: [
      { id:"d-steady", label:"drone-steady", role:"Builder", last_seen: iso(T0+i*TICK_MS), sent: cumSteady(i), sent_5s: 50, received: 10 },
      { id:"d-pruned", label:"drone-pruned", role:"Builder", last_seen: iso(T0+i*TICK_MS), sent: cumPruned(i), sent_5s: 50, received: 10 },
      { id:"d-silent", label:"drone-silent", role:"Builder", last_seen: iso(T0+i*TICK_MS), sent: 1000,        sent_5s:  0, received: 10 },
    ] }],
});
let step = 0, notify = () => {};
const source = { read: () => dataAt(step), subscribe: (l) => { notify = l; return () => { notify = () => {}; }; } };
const frames = [];
const terminal = { write:(v)=>frames.push(v), dimensions:()=>({columns:100,rows:24}), onResize:()=>()=>{} };
const dash = startForegroundDashboard({
  source, server: SERVER, terminal,
  renderer: createDashboardRenderer({ glyphMode:"box", color:false, footer:EMBEDDED_DASHBOARD_FOOTER, navigation:false }),
  fallbackFooter: EMBEDDED_DASHBOARD_FOOTER,
  eventCoalesceMs: 2, idleRefreshMs: 600_000, pulseFrameMs: 600_000,
});
dash.failure.catch((e) => console.log("DASHBOARD FAILURE:", e && e.message));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(30);
for (step = 1; step < STEPS; step++) { notify(); await settle(12); }
dash.close();
const last = [...frames].reverse().find((f) => f.includes("drone-steady"));
if (last === undefined) throw new Error("no frame rendered — harness produced nothing");
const lines = last.split("\n");
const rowFor = (label) => {
  const i = lines.findIndex((l) => l.includes(label));
  if (i < 0) throw new Error(`no drone band for ${label}`);
  if (lines[i + 1] === undefined) throw new Error(`no graph row under ${label}`);
  return lines[i + 1].slice(1, -1);
};
const BAR = "▁▂▃▄▅▆▇█", ZERO = "·";
const bars = (s) => [...s].filter((c) => BAR.includes(c)).length;
const zeros = (s) => [...s].filter((c) => c === ZERO).length;
const firstMark = (s) => [...s].findIndex((c) => c === ZERO || BAR.includes(c));
const steady = rowFor("drone-steady"), pruned = rowFor("drone-pruned"), silent = rowFor("drone-silent");
let failed = 0;
const check = (kind, label, ok, detail) => { if (!ok) failed++; console.log(`${ok?"PASS":"FAIL"}  ${kind.padEnd(17)} ${label}${detail?"  - "+detail:""}`); };
check("POSITIVE CONTROL", "steady draws bars", bars(steady) > 0, `${bars(steady)} bars`);
check("ZERO CONTROL", "zero per-tick count renders the zero marker", zeros(silent) > 0 && bars(silent) === 0,
  `${zeros(silent)} zero markers, ${bars(silent)} bars`);
check("RATIFIED 77e4da75", "steady has NO zero marker in ANY slot, incl. first", zeros(steady) === 0,
  `${zeros(steady)} zero markers; leading glyph ${JSON.stringify(steady[firstMark(steady)])}`);
check("BASELINE (INVERTED)", "leading slot silent for NEITHER poster",
  steady[firstMark(steady)] !== ZERO && pruned[firstMark(pruned)] !== ZERO,
  "was 'silent for BOTH' pre-split (d194e340)");
check("REGRESSION GUARD", "falling cumulative no longer reaches the graph", zeros(pruned) === 0,
  `${zeros(pruned)} zero markers on a drone whose cumulative sent DECREASES every 4th tick`);
console.log("\nsteady: " + steady.slice(70).replace(/\s+$/, ""));
console.log("pruned: " + pruned.slice(70).replace(/\s+$/, ""));
console.log("silent: " + silent.slice(70).replace(/\s+$/, ""));
console.log(`\n${failed === 0 ? "ALL ASSERTIONS HELD" : `${failed} ASSERTION(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
