// Fixture 2 — carries the #170 (saturation) and #186 (normalisation) conditions
// that fixture 1 deliberately omits. Separate file; fixture 1 is never edited.
// Deterministic: no clock, no randomness. Sample series are built by a pure
// function of the slot index rather than written out as 180 literals per drone.
//
// Window mechanics this fixture is built against (dashboard.ts:770-782):
//   slots = ceil(windowMs / DASHBOARD_IDLE_REFRESH_MS) = ceil(900000/5000) = 180
//   a sample counts only if start <= t <= end, where start = captured_at - windowMs
// Fixture 1 has 3 samples over 180 slots, so its graphs are almost all blank and
// its coverage line reads 0%. This one fills every slot.

const CAPTURED_AT = "2026-08-06T14:00:00.000Z";
const WINDOW_MS = 15 * 60000;
const SLOT_MS = 5000;
const SLOTS = Math.ceil(WINDOW_MS / SLOT_MS); // 180
const END = Date.parse(CAPTURED_AT);
const START = END - WINDOW_MS;

// series(rateFn) -> one sample per slot, timestamps derived from CAPTURED_AT.
const series = (rateFn) =>
  Array.from({ length: SLOTS }, (_u, slot) => ({
    capturedAt: new Date(START + slot * SLOT_MS).toISOString(),
    sentRate: rateFn(slot),
  }));

// Base shape, 1..20. HEAVY is exactly 20x LIGHT, so the two rows are
// proportionally identical: per-drone normalisation must render them the same
// despite a 20:1 volume difference. That is #186, made visible.
const base = (slot) => 1 + (slot % 20);
const LIGHT = series(base);              // max 20
const HEAVY = series((s) => 20 * base(s)); // max 400
// MID has a DIFFERENT shape, not a different scale. It is the in-fixture control:
// if MID also rendered identically to LIGHT, the graph renderer would be flat for
// a reason unrelated to normalisation and the fixture would prove nothing.
const MID = series((s) => 1 + ((s * 7) % 20));
const SILENT = series(() => 0);
const OBSERVATION = series(base);

export const SERVER = {
  name: "borg-mcp-server",
  version: "0.10.1",
  endpoint: "https://127.0.0.1:7091",
  state: "online",
  started_at: "2026-08-06T09:00:00.000Z",
};

const drone = (id, label, role, last_seen, sent, received) =>
  ({ id, label, role, last_seen, sent, received });

// Focused cube (rank 1, autoFollow) carries the 20:1 drone pair so the activity
// panel renders it. Everything below feeds the heat ramp.
const alphaDrones = [
  drone("a-heavy",  "drone-heavy",  "Builder",         "2026-08-06T13:59:58.000Z", 1240, 88),
  drone("a-light",  "drone-light",  "Builder",         "2026-08-06T13:59:57.000Z",   62, 74),
  drone("a-mid",    "drone-mid",    "Code Reviewer",   "2026-08-06T13:59:55.000Z",  310, 91),
  drone("a-silent", "drone-silent", "Security Auditor","2026-08-06T13:12:00.000Z",    0, 55),
];

const cube = (id, name, posts, posters, seen, total, last, drones = []) =>
  ({ id, name, posts_15m: posts, distinct_posting_drones_15m: posters,
     drones_total: total, drones_seen_15m: seen, last_post_at: last, drones });

export const DATA = {
  captured_at: CAPTURED_AT,
  cubes: [
    // Five cubes spanning 9..213 posts. heatGlyph's top bucket is `posts > 8`
    // and unbounded (dashboard.ts:821-826), so all five render the SAME glyph.
    cube("c-alpha",   "hive-alpha",   213, 9, 9, 11, "2026-08-06T13:59:58.000Z", alphaDrones),
    cube("c-beta",    "hive-beta",     88, 7, 7,  9, "2026-08-06T13:59:41.000Z"),
    cube("c-gamma",   "hive-gamma",    47, 6, 6,  8, "2026-08-06T13:59:12.000Z"),
    cube("c-delta",   "hive-delta",    12, 4, 4,  6, "2026-08-06T13:58:30.000Z"),
    cube("c-epsilon", "hive-epsilon",   9, 3, 3,  5, "2026-08-06T13:57:44.000Z"),
    // Bucket boundaries: 8 and 3 -> third bucket, 2 and 1 -> second, 0 -> first.
    cube("c-zeta",    "hive-zeta",      8, 3, 3,  5, "2026-08-06T13:56:10.000Z"),
    cube("c-eta",     "hive-eta",       3, 2, 2,  4, "2026-08-06T13:54:02.000Z"),
    cube("c-theta",   "hive-theta",     2, 1, 1,  3, "2026-08-06T13:51:33.000Z"),
    cube("c-iota",    "hive-iota",      1, 1, 1,  3, "2026-08-06T13:47:20.000Z"),
    cube("c-kappa",   "hive-kappa",     0, 0, 0,  4, "2026-08-06T13:05:00.000Z"),
    cube("c-lambda",  "hive-lambda",    0, 0, 0,  2, "2026-08-06T09:30:00.000Z"),
    cube("c-mu",      "hive-mu",        0, 0, 0,  1, null),
  ],
};

// hive-alpha is BOTH pulsing and rank-changed (3 -> 1). renderSummaryRow:802-804
// picks pulse OR rank marker into one shared cell, so the rank move is withheld
// exactly on the cube that just posted. That is #171 item 1, made visible.
export const PREVIOUS_RANKS = new Map([
  ["c-alpha", 3], ["c-beta", 1], ["c-gamma", 2], ["c-delta", 5], ["c-epsilon", 4],
  ["c-zeta", 6], ["c-eta", 7], ["c-theta", 8], ["c-iota", 9],
  ["c-kappa", 10], ["c-lambda", 11], ["c-mu", 12],
]);

export const VIEW = {
  autoFollow: true,
  focusedCubeId: null,
  pulseCubeIds: new Set(["c-alpha"]),
  pulsePhase: 2,
  // KEYED `${cube.id}:${drone.id}` — that is the lookup renderFocusPanel performs
  // (dashboard.ts:707). Keying by drone id alone silently yields [] and every
  // graph renders blank, which is what fixture 1 does.
  activity: new Map([
    ["c-alpha:a-heavy", HEAVY], ["c-alpha:a-light", LIGHT],
    ["c-alpha:a-mid", MID], ["c-alpha:a-silent", SILENT],
  ]),
  // `observation` drives the coverage note (dashboard.ts:693, `view.observation ?? []`).
  // A full window means coverage === 1, so the "collecting" line is absent and the
  // panel spends its rows on drone bands instead.
  observation: OBSERVATION,
  activityWindowMs: WINDOW_MS,
  page: 0,
};
