// Deterministic fixture snapshot for dashboard render gate.
// No clock, no randomness, no I/O: every value is a literal.
export const SERVER = {
  name: "borg-mcp-server",
  version: "0.10.1",
  endpoint: "https://127.0.0.1:7091",
  state: "online",
  started_at: "2026-08-06T09:00:00.000Z",
};

const drone = (id, label, role, last_seen, sent, received) =>
  ({ id, label, role, last_seen, sent, received });

export const DATA = {
  captured_at: "2026-08-06T13:45:00.000Z",
  cubes: [
    {
      id: "cube-borg-mcp", name: "borg-mcp",
      posts_15m: 47, distinct_posting_drones_15m: 6,
      drones_total: 11, drones_seen_15m: 8,
      last_post_at: "2026-08-06T13:44:52.000Z",
      drones: [
        drone("d-coord", "coordinator-83513ccf", "Coordinator", "2026-08-06T13:44:52.000Z", 21, 3),
        drone("d-rq", "builder-f9200281", "Release Quality", "2026-08-06T13:37:48.000Z", 4, 19),
        drone("d-pd", "product-design-70d7c374", "Product Design", "2026-08-06T13:37:14.000Z", 6, 18),
        drone("d-sa", "security-auditor-44da7f58", "Security Auditor", "2026-08-06T13:36:24.000Z", 2, 17),
        drone("d-idle", "builder-a076b44a", "Builder", "2026-08-06T07:10:00.000Z", 0, 12),
      ],
    },
    {
      id: "cube-quiet", name: "quiet-cube",
      posts_15m: 2, distinct_posting_drones_15m: 1,
      drones_total: 3, drones_seen_15m: 1,
      last_post_at: "2026-08-06T13:31:00.000Z",
      drones: [drone("q-1", "builder-11111111", "Builder", "2026-08-06T13:31:00.000Z", 2, 0)],
    },
    {
      id: "cube-asleep", name: "asleep-cube",
      posts_15m: 0, distinct_posting_drones_15m: 0,
      drones_total: 4, drones_seen_15m: 0,
      last_post_at: "2026-08-06T07:12:00.000Z",
      drones: [drone("a-1", "builder-22222222", "Builder", "2026-08-06T07:12:00.000Z", 0, 0)],
    },
    {
      id: "cube-never", name: "never-posted",
      posts_15m: 0, distinct_posting_drones_15m: 0,
      drones_total: 1, drones_seen_15m: 0,
      last_post_at: null,
      drones: [],
    },
  ],
};

export const PREVIOUS_RANKS = new Map([
  ["cube-borg-mcp", 2], ["cube-quiet", 1], ["cube-asleep", 3], ["cube-never", 4],
]);

export const VIEW = {
  autoFollow: true,
  focusedCubeId: null,
  pulseCubeIds: new Set(["cube-borg-mcp"]),
  pulsePhase: 2,
  activity: new Map([
    ["d-coord", [
      { capturedAt: "2026-08-06T13:35:00.000Z", sentRate: 3 },
      { capturedAt: "2026-08-06T13:40:00.000Z", sentRate: 9 },
      { capturedAt: "2026-08-06T13:45:00.000Z", sentRate: 6 },
    ]],
    ["d-rq", [
      { capturedAt: "2026-08-06T13:35:00.000Z", sentRate: 0 },
      { capturedAt: "2026-08-06T13:40:00.000Z", sentRate: 1 },
      { capturedAt: "2026-08-06T13:45:00.000Z", sentRate: 2 },
    ]],
  ]),
  activityWindowMs: 15 * 60000,
  page: 0,
};
