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
});
