import { createDashboardRenderer, rankDashboardSnapshot, EMBEDDED_DASHBOARD_FOOTER } from "./dashboard.ts";
import { SERVER, DATA, PREVIOUS_RANKS, VIEW } from "./fixture2.mjs";

const snapshot = rankDashboardSnapshot(DATA, SERVER, PREVIOUS_RANKS);
let failed = 0;

const check = (kind, label, condition, detail = "") => {
  const state = condition ? "PASS" : "FAIL";
  console.log(`${state}  ${kind.padEnd(17)} ${label}${detail === "" ? "" : `  — ${detail}`}`);
  if (!condition) failed += 1;
};

const renderMode = (glyphMode) => {
  const frame = createDashboardRenderer({
    glyphMode,
    color: false,
    footer: EMBEDDED_DASHBOARD_FOOTER,
    navigation: true,
  })(snapshot, 100, 44, VIEW);
  const lines = frame.split("\n");
  const summaryGlyph = (name) => {
    const line = lines.find((candidate) => candidate.includes(name));
    if (line === undefined) throw new Error(`missing summary row: ${name}`);
    return line.trimStart()[0];
  };
  const graphRow = (label) => {
    const index = lines.findIndex((line) => line.includes(label));
    if (index < 0) throw new Error(`missing drone row: ${label}`);
    const graph = lines.slice(index + 1, index + 3).map((line) => line.slice(1, -1)).join("\n");
    if (graph.length === 0) throw new Error(`missing graph for: ${label}`);
    return graph;
  };
  return { summaryGlyph, graphRow };
};

for (const glyphMode of ["box", "ascii"]) {
  const { summaryGlyph, graphRow } = renderMode(glyphMode);
  const nonLevel = new Set([" ", "\n", "·", "."]);
  const heavy = graphRow("drone-heavy");
  const light = graphRow("drone-light");
  const mid = graphRow("drone-mid");
  const silent = graphRow("drone-silent");
  const levelCount = (row) => new Set([...row].filter((char) => !nonLevel.has(char))).size;
  const rampCardinality = glyphMode === "box" ? 8 : 4;
  const suffix = ` [${glyphMode}]`;

  check("CONTROL", `heat ramp is not flat: zeta(8) vs theta(2) differ${suffix}`,
    summaryGlyph("hive-zeta") !== summaryGlyph("hive-theta"),
    `${summaryGlyph("hive-zeta")} vs ${summaryGlyph("hive-theta")}`);
  check("CONTROL", `heat ramp reaches zero: theta(2) vs kappa(0) differ${suffix}`,
    summaryGlyph("hive-theta") !== summaryGlyph("hive-kappa"),
    `${summaryGlyph("hive-theta")} vs ${summaryGlyph("hive-kappa")}`);
  check("CONTROL", `graph renders shape: heavy vs mid differ${suffix}`,
    heavy !== mid);
  check("CONTROL", `graph encodes AMPLITUDE, not just presence${suffix}`,
    levelCount(heavy) > 1,
    `${levelCount(heavy)} distinct bar heights on drone-heavy`);
  check("CONTROL", `graph uses the full activity ramp${suffix}`,
    levelCount(heavy) === rampCardinality,
    `${levelCount(heavy)} of ${rampCardinality} levels on drone-heavy`);
  check("CONTROL", `graph renders zero: heavy vs silent differ${suffix}`,
    heavy !== silent);
  check("CONTROL", `quiet drone remains visible${suffix}`,
    levelCount(light) > 0,
    `${levelCount(light)} non-zero levels on drone-light`);

  const saturated = ["hive-alpha", "hive-beta", "hive-gamma", "hive-delta", "hive-epsilon"];
  check("EXPECTED-TO-FLIP", `#170 five cubes 9..213 posts share one glyph${suffix}`,
    new Set(saturated.map(summaryGlyph)).size === 1,
    `${new Set(saturated.map(summaryGlyph)).size} distinct`);
  check("EXPECTED-TO-FLIP", `#186 heavy(max 400) and light(max 20) render identically${suffix}`,
    heavy === light);
}

process.exit(failed === 0 ? 0 : 1);
