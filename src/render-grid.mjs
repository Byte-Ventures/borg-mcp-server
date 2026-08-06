import { createDashboardRenderer, rankDashboardSnapshot, EMBEDDED_DASHBOARD_FOOTER } from "./dashboard.ts";
import { SERVER, DATA, PREVIOUS_RANKS, VIEW } from "./fixture.mjs";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const snapshot = rankDashboardSnapshot(DATA, SERVER, PREVIOUS_RANKS);
const out = [];
for (const columns of [100, 80, 60, 48]) {
  for (const color of [true, false]) {
    for (const glyphMode of ["box", "ascii"]) {
      const render = createDashboardRenderer({ glyphMode, color, footer: EMBEDDED_DASHBOARD_FOOTER, navigation: true });
      const frame = render(snapshot, columns, 24, VIEW);
      const tag = `${columns}-${color ? "color" : "mono"}-${glyphMode}`;
      writeFileSync(new URL(`../frames/${tag}.txt`, import.meta.url), frame + "\n");
      out.push(`${tag}\t${createHash("sha256").update(frame).digest("hex").slice(0, 16)}\t${frame.split("\n").length}L`);
    }
  }
}
process.stdout.write(out.join("\n") + "\n");
