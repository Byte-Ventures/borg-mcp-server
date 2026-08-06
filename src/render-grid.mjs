import { render as inkRender } from "ink";
import { createDashboardRenderer, rankDashboardSnapshot, EMBEDDED_DASHBOARD_FOOTER } from "./dashboard.ts";
import { createInkDashboardElement, normalizeInkFrame } from "./dashboard-ink.ts";
import { SERVER, DATA, PREVIOUS_RANKS, VIEW } from "./fixture.mjs";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const snapshot = rankDashboardSnapshot(DATA, SERVER, PREVIOUS_RANKS);
const out = [];
const hashes = new Set();
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const stdoutFor = (columns, rows) => {
  let value = "";
  return {
    isTTY: true,
    columns,
    rows,
    write: (chunk) => { value += String(chunk); return true; },
    on: () => undefined,
    off: () => undefined,
    get value() { return value; },
  };
};
const capture = async (renderer, columns, rows) => {
  const stdout = stdoutFor(columns, rows);
  const instance = inkRender(
    createInkDashboardElement(snapshot, columns, rows, VIEW, renderer.inkOptions),
    { stdout, debug: true, patchConsole: false, maxFps: 0, exitOnCtrlC: false },
  );
  await nextTick();
  const frame = normalizeInkFrame(stdout.value, columns, rows);
  instance.unmount();
  return frame;
};

const run = async () => {
for (const columns of [100, 80, 60, 48]) {
  for (const color of [true, false]) {
    for (const glyphMode of ["box", "ascii"]) {
      const render = createDashboardRenderer({ glyphMode, color, footer: EMBEDDED_DASHBOARD_FOOTER, navigation: true });
      const frame = await capture(render, columns, 24);
      const tag = `${columns}-${color ? "color" : "mono"}-${glyphMode}`;
      writeFileSync(new URL(`../frames/${tag}.txt`, import.meta.url), frame + "\n");
      const hash = createHash("sha256").update(frame).digest("hex").slice(0, 16);
      if (hashes.has(hash)) throw new Error(`Fixture-1 frame hash collision at ${tag}: ${hash}`);
      hashes.add(hash);
      out.push(`${tag}\t${hash}\t${frame.split("\n").length}L`);
    }
  }
}

if (hashes.size !== 16) throw new Error(`Fixture-1 expected 16 distinct frame hashes, got ${hashes.size}`);
process.stdout.write(out.join("\n") + "\n");
};

await run();
