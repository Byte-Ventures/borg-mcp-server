import { createDashboardRenderer, rankDashboardSnapshot, EMBEDDED_DASHBOARD_FOOTER } from "./dashboard.ts";
import { SERVER, DATA, PREVIOUS_RANKS, VIEW } from "./fixture2.mjs";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const snapshot = rankDashboardSnapshot(DATA, SERVER, PREVIOUS_RANKS);
const out = [];
for (const columns of [100, 80, 60, 48]) {
  for (const color of [true, false]) {
    for (const glyphMode of ["box", "ascii"]) {
      const render = createDashboardRenderer({ glyphMode, color, footer: EMBEDDED_DASHBOARD_FOOTER, navigation: true });
      const frame = render(snapshot, columns, 44, VIEW);
      const tag = `${columns}x44-${color ? "color" : "mono"}-${glyphMode}`;
      writeFileSync(new URL(`../frames-f2/${tag}.txt`, import.meta.url), frame + "\n");
      out.push(`${columns}x44 ${color ? "color" : "mono"} ${glyphMode} ${createHash("sha256").update(frame).digest("hex").slice(0, 16)}`);
    }
  }
}

const compact = createDashboardRenderer({ glyphMode: "box", color: false, footer: EMBEDDED_DASHBOARD_FOOTER, navigation: true });
const compactFrame = compact(snapshot, 100, 24, VIEW);
writeFileSync(new URL("../frames-f2/100x24-mono-box.txt", import.meta.url), compactFrame + "\n");
out.push(`100x24 mono box ${createHash("sha256").update(compactFrame).digest("hex").slice(0, 16)}`);

process.stdout.write(out.join("\n") + "\n");
