import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const normalizeScript = resolve("scripts/normalize-release-sbom.mjs");
const verifyScript = resolve("scripts/verify-release-sbom.mjs");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("release SBOM", () => {
  it("normalizes and verifies npm output from a differently named checkout", async () => {
    const fixture = await rawFixture();
    const raw = fixture.sbom as { metadata: { component: { name: string } } };
    expect(basename(process.cwd())).not.toBe("borgmcp-server");
    expect(raw.metadata.component.name).toBe(basename(process.cwd()));

    const normalizedPath = join(fixture.directory, "release.cdx.json");
    await execute(process.execPath, [normalizeScript, fixture.rawPath, normalizedPath]);
    const verification = await execute(process.execPath, [verifyScript, normalizedPath]);

    const report = JSON.parse(verification.stdout) as {
      name: string;
      version: string;
      format: string;
      components: number;
      dependencyNodes: number;
    };
    expect(report).toMatchObject({
      name: "borgmcp-server",
      version: "0.1.3",
      format: "CycloneDX-1.5",
    });
    expect(report.components).toBeGreaterThan(0);
    expect(report.dependencyNodes).toBe(report.components + 1);
    const normalized = JSON.parse(await readFile(normalizedPath, "utf8")) as {
      metadata: { component: Record<string, unknown> };
    };
    expect(normalized.metadata.component).toMatchObject({
      name: "borgmcp-server",
      version: "0.1.3",
      "bom-ref": "borgmcp-server@0.1.3",
      purl: "pkg:npm/borgmcp-server@0.1.3",
    });
  });

  it("rejects root, distribution, and dependency-graph drift", async () => {
    const fixture = await rawFixture();
    fixture.sbom.metadata.component.name = "borgmcp-server";

    const rootMismatch = structuredClone(fixture.sbom);
    rootMismatch.metadata.component.name = "checkout-directory";
    await expectRejectedFixture(fixture.directory, rootMismatch, "root component");

    const distributionMismatch = structuredClone(fixture.sbom);
    distributionMismatch.components[0].externalReferences
      .find((reference: { type: string }) => reference.type === "distribution").url =
        "https://registry.npmjs.org/attacker/-/attacker-1.0.0.tgz";
    await expectRejectedFixture(fixture.directory, distributionMismatch, "distribution reference");

    const graphMismatch = structuredClone(fixture.sbom);
    graphMismatch.dependencies.pop();
    await expectRejectedFixture(fixture.directory, graphMismatch, "dependency nodes");
  });
});

async function rawFixture(): Promise<{ directory: string; rawPath: string; sbom: any }> {
  const directory = await mkdtemp(join(tmpdir(), "server-sbom-"));
  directories.push(directory);
  const generated = await execute("npm", [
    "sbom", "--sbom-format", "cyclonedx", "--registry=https://registry.npmjs.org",
  ], { maxBuffer: 10 * 1024 * 1024 });
  const rawPath = join(directory, "raw.cdx.json");
  await writeFile(rawPath, generated.stdout);
  return { directory, rawPath, sbom: JSON.parse(generated.stdout) };
}

async function expectRejectedFixture(directory: string, sbom: unknown, message: string): Promise<void> {
  const path = join(directory, `${crypto.randomUUID()}.cdx.json`);
  await writeFile(path, `${JSON.stringify(sbom)}\n`);
  await expect(execute(process.execPath, [verifyScript, path])).rejects.toThrow(message);
}
