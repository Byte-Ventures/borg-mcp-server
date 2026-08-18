import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { createDashboardRenderer, startForegroundDashboard } = await import(
  pathToFileURL(resolve(process.cwd(), "dist/dashboard.js")).href,
);

const base = Date.parse("2026-07-25T12:00:00.000Z");
const server = {
  name: "borgmcp-server",
  version: "0.14.2",
  endpoint: "https://127.0.0.1:7091",
  state: "online",
  started_at: new Date(base - 3_600_000).toISOString(),
};
let reads = 0;
const source = {
  read: () => {
    reads += 1;
    const capturedAt = new Date(base + reads * 5_000).toISOString();
    return {
      captured_at: capturedAt,
      attention: { unacked_directed: 0, stale_directed: 0, oldest_unacked: null },
      recent_activity: [],
      cubes: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: "cube",
        posts_15m: reads,
        distinct_posting_drones_15m: 1,
        drones_total: 1,
        drones_seen_15m: 1,
        last_post_at: capturedAt,
        attention: { unacked_directed: 0, stale_directed: 0, oldest_unacked: null },
        drones: [{
          id: "10000000-0000-4000-8000-000000000001",
          label: "builder",
          role: "Builder",
          reported_model: "probe-model",
          last_seen: capturedAt,
          sent: reads,
          sent_5s: reads,
          received: reads,
          attention: { unacked_directed: 0, stale_directed: 0, oldest_unacked: null },
        }],
      }],
    };
  },
  subscribe: () => () => undefined,
};
const terminal = {
  isTTY: true,
  write: () => undefined,
  dimensions: () => ({ columns: 80, rows: 24 }),
  onResize: () => () => undefined,
};
const dashboard = startForegroundDashboard({
  source,
  server,
  terminal,
  renderer: createDashboardRenderer({ glyphMode: "ascii", color: false, footer: "^C stop server  |  read-only" }),
  idleRefreshMs: 10,
  pulseFrameMs: 2,
});
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await settle(100);
  if (typeof globalThis.gc !== "function") throw new Error("heap probe requires --expose-gc");
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (reads >= 150) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
  await settle(100);
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  process.stdout.write(`${JSON.stringify({ reads, before, after, delta: after - before })}\n`);
} finally {
  dashboard.close();
}
