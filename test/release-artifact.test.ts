import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { verifyPackedArtifact } from "../scripts/verify-packed-artifact.mjs";

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("packed release artifact", () => {
  it("accepts a bounded public server package", async () => {
    const fixture = await packageFixture();
    const tarball = await pack(fixture);
    const report = await verifyPackedArtifact(tarball);

    expect(report).toMatchObject({ name: "borgmcp-server", version: "1.2.3" });
    expect(report.integrity).toMatch(/^sha512-/u);
    await expect(execute("npm", [
      "publish",
      `./${basename(tarball)}`,
      "--dry-run",
      "--ignore-scripts",
      "--access",
      "public",
      "--registry=https://registry.npmjs.org",
    ], { cwd: fixture })).resolves.toBeDefined();
  });

  it("rejects consumer lifecycle hooks", async () => {
    const fixture = await packageFixture({ scripts: { install: "node unsafe.js" } });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "Forbidden consumer lifecycle hook: install",
    );
  });

  it("rejects the dependencies lifecycle hook", async () => {
    const fixture = await packageFixture({ scripts: { dependencies: "node unsafe.js" } });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "Forbidden consumer lifecycle hook: dependencies",
    );
  });

  it("scans generated output for credential material", async () => {
    const fixture = await packageFixture();
    await writeFile(join(fixture, "dist", "leak.js"), "const key = '-----BEGIN PRIVATE KEY-----';\n");
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "private key material",
    );
  });

  it("rejects source maps whose source is not shipped", async () => {
    const fixture = await packageFixture();
    await writeFile(join(fixture, "dist", "index.js.map"), JSON.stringify({
      version: 3,
      file: "index.js",
      sources: ["../src/index.ts"],
      names: [],
      mappings: "",
    }));
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "Source map target is not shipped",
    );
  });

  it("rejects install-script or non-registry entries in the published shrinkwrap", async () => {
    const fixture = await packageFixture();
    const path = join(fixture, "npm-shrinkwrap.json");
    const shrinkwrap = JSON.parse(await readFile(path, "utf8")) as {
      packages: Record<string, unknown>;
    };
    shrinkwrap.packages["node_modules/unsafe"] = {
      version: "1.0.0",
      resolved: "git+ssh://git@github.com/example/unsafe.git",
      integrity: "sha512-invalid",
      hasInstallScript: true,
    };
    await writeFile(path, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "untrusted dependency entry",
    );
  });
});

async function packageFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "borg-release-fixture-"));
  directories.push(directory);
  await execute("mkdir", ["-p", join(directory, "dist")]);
  const manifest = {
    name: "borgmcp-server",
    version: "1.2.3",
    private: false,
    type: "module",
    license: "SEE LICENSE IN LICENSE",
    repository: {
      type: "git",
      url: "git+https://github.com/Byte-Ventures/borg-mcp-server.git",
    },
    publishConfig: { access: "public" },
    files: ["dist", "LICENSE", "README.md", "npm-shrinkwrap.json"],
    bin: { "borg-mcp-server": "./dist/index.js" },
    dependencies: {},
    ...overrides,
  };
  await Promise.all([
    writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(directory, "LICENSE"), "Reviewed FSL fixture.\n"),
    writeFile(join(directory, "README.md"), "# Server fixture\n"),
    writeFile(join(directory, "npm-shrinkwrap.json"), `${JSON.stringify({
      name: "borgmcp-server",
      version: "1.2.3",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "borgmcp-server", version: "1.2.3", dependencies: {} } },
    }, null, 2)}\n`),
    writeFile(join(directory, "dist", "index.js"), "export const ready = true;\n"),
  ]);
  return directory;
}

async function pack(directory: string): Promise<string> {
  const { stdout } = await execute("npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", directory,
  ], { cwd: directory });
  const [result] = JSON.parse(stdout) as Array<{ filename: string }>;
  return join(directory, result!.filename);
}
