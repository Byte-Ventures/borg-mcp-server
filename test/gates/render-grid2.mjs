import { render as inkRender } from "ink";
import { createDashboardRenderer, rankDashboardSnapshot, EMBEDDED_DASHBOARD_FOOTER } from "../../src/dashboard.ts";
import { createInkDashboardElement, normalizeInkFrame } from "../../src/dashboard-ink.js";
import { SERVER, DATA, PREVIOUS_RANKS, VIEW } from "./fixture2.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
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
mkdirSync(new URL("../../frames-f2/", import.meta.url), { recursive: true });
for (const columns of [100, 80, 60, 48]) {
  for (const color of [true, false]) {
    for (const glyphMode of ["box", "ascii"]) {
      const render = createDashboardRenderer({ glyphMode, color, footer: EMBEDDED_DASHBOARD_FOOTER, navigation: true });
      const frame = await capture(render, columns, 44);
      const tag = `${columns}x44-${color ? "color" : "mono"}-${glyphMode}`;
      writeFileSync(new URL(`../../frames-f2/${tag}.txt`, import.meta.url), frame + "\n");
      const hash = createHash("sha256").update(frame).digest("hex").slice(0, 16);
      if (hashes.has(hash)) throw new Error(`Fixture-2 frame hash collision at ${tag}: ${hash}`);
      hashes.add(hash);
      out.push(`${columns}x44 ${color ? "color" : "mono"} ${glyphMode} ${hash}`);
    }
  }
}

const compact = createDashboardRenderer({ glyphMode: "box", color: false, footer: EMBEDDED_DASHBOARD_FOOTER, navigation: true });
const compactFrame = await capture(compact, 100, 24);
writeFileSync(new URL("../../frames-f2/100x24-mono-box.txt", import.meta.url), compactFrame + "\n");
const compactHash = createHash("sha256").update(compactFrame).digest("hex").slice(0, 16);
if (hashes.has(compactHash)) throw new Error(`Fixture-2 frame hash collision at 100x24-mono-box: ${compactHash}`);
hashes.add(compactHash);
out.push(`100x24 mono box ${compactHash}`);

if (hashes.size !== 17) throw new Error(`Fixture-2 expected 17 distinct frame hashes, got ${hashes.size}`);

process.stdout.write(out.join("\n") + "\n");
};

await run();
