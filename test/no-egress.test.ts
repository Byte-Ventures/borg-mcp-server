import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("runtime egress boundary", () => {
  it("contains no outbound network client calls or cloud endpoints", async () => {
    const sourceDirectory = new URL("../src/", import.meta.url);
    const runtimeFiles = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    const sources = await Promise.all(
      runtimeFiles.map((file) => readFile(new URL(file, sourceDirectory), "utf8")),
    );
    const runtimeSource = sources.join("\n");

    expect(runtimeSource).not.toMatch(/\bfetch\s*\(/u);
    expect(runtimeSource).not.toMatch(/\b(?:request|connect)\s*\(/u);
    expect(runtimeSource).not.toMatch(/borgmcp\.ai|googleapis\.com/u);
  });

  it("contains no discovery, remote-tool, dynamic-code, or subprocess execution surface", async () => {
    const sourceDirectory = new URL("../src/", import.meta.url);
    const runtimeFiles = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    const sources = await Promise.all(
      runtimeFiles.map((file) => readFile(new URL(file, sourceDirectory), "utf8")),
    );
    const runtimeSource = sources.join("\n");

    expect(runtimeSource).not.toMatch(/node:child_process|\b(?:spawn|execFile|execSync|fork)\s*\(/u);
    expect(runtimeSource).not.toMatch(/\beval\s*\(|new Function\s*\(/u);
    expect(runtimeSource).not.toMatch(/\b(?:mdns|bonjour|zeroconf|multicast|service-discovery)\b/iu);
    expect(runtimeSource).not.toMatch(/remote[_-]?tool|tool[_-]?execution/iu);
  });
});
