import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { exercisePackedArtifact } from "../scripts/exercise-packed-artifact.mjs";
import { verifyPackedArtifact } from "../scripts/verify-packed-artifact.mjs";

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("packed release artifact", () => {
  it("delegates npm compatibility solely to the packed engine boundary", async () => {
    const probe = await readFile("scripts/exercise-packed-artifact.mjs", "utf8");
    expect(probe.match(/--engine-strict/gu)).toHaveLength(2);
    expect(probe).not.toContain("expectedNpmVersion");
    expect(probe).not.toContain("11.18.0");
    expect(probe).not.toMatch(/npm@[0-9]/u);
  });

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

  it("binds the published npm compatibility boundary used by runtime staging", async () => {
    const fixture = await packageFixture();
    const manifest = JSON.parse(await readFile(join(fixture, "package.json"), "utf8")) as {
      engines: unknown;
    };
    expect(manifest.engines).toEqual({ node: ">=22.12.0", npm: ">=10.0.0" });
    await expect(verifyPackedArtifact(await pack(fixture))).resolves.toBeDefined();
  });

  it("rejects a packed artifact that drifts from the reviewed npm compatibility boundary", async () => {
    const fixture = await packageFixture({
      engines: { node: ">=22.12.0", npm: ">=10.0.0 <12" },
    });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "Package engines must match the reviewed Node and npm compatibility boundary.",
    );
  });

  it("accepts the artifact with trusted npm config isolated outside the workspace", async () => {
    const fixture = await packageFixture();
    const configDirectory = await mkdtemp(join(tmpdir(), "borg-release-npm-config-"));
    directories.push(configDirectory);
    const config = join(configDirectory, "user.npmrc");
    await writeFile(config, "registry=https://registry.npmjs.org/\n");
    const previous = process.env["NPM_CONFIG_USERCONFIG"];
    process.env["NPM_CONFIG_USERCONFIG"] = config;
    try {
      await expect(verifyPackedArtifact(await pack(fixture))).resolves.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env["NPM_CONFIG_USERCONFIG"];
      else process.env["NPM_CONFIG_USERCONFIG"] = previous;
    }
  });

  it("installs, imports, and executes the exact packed artifact", async () => {
    const fixture = await packageFixture();
    await expect(exercisePackedArtifact(await pack(fixture))).resolves.toBeUndefined();
  });

  it("rejects an npm runtime excluded by the packed artifact engine", async () => {
    const fixture = await packageFixture({
      engines: { node: ">=22.12.0", npm: ">=999.0.0" },
    });
    await expect(exercisePackedArtifact(await pack(fixture))).rejects.toMatchObject({
      stderr: expect.stringContaining("EBADENGINE"),
    });
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
      sources: ["../src/missing.ts"],
      names: [],
      mappings: "",
    }));
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "Source map target is not shipped",
    );
  });

  it.each([
    [{ sourcesContent: ["private source"] }, "Indexed source maps are forbidden"],
    [{ sources: ["/Users/operator/private.ts"] }, "local absolute path"],
  ])("rejects indexed source maps with nested private sources", async (nestedMap, expected) => {
    const fixture = await packageFixture();
    await writeFile(join(fixture, "dist", "index.js.map"), JSON.stringify({
      version: 3,
      sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, ...nestedMap } }],
    }));
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(expected);
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

  it("allows an install script only in a development-only dependency", async () => {
    const fixture = await packageFixture();
    await mutateShrinkwrapRoot(fixture, (_root, shrinkwrap) => {
      shrinkwrap.packages["node_modules/dev-tool"] = {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/dev-tool/-/dev-tool-1.0.0.tgz",
        integrity: VALID_INTEGRITY,
        dev: true,
        hasInstallScript: true,
      };
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      dist: {
        tarball: "https://registry.npmjs.org/dev-tool/-/dev-tool-1.0.0.tgz",
        integrity: VALID_INTEGRITY,
      },
    }), { status: 200 })));
    await expect(verifyPackedArtifact(await pack(fixture))).resolves.toBeDefined();
  });

  it("rejects a root dependency mismatch", async () => {
    const fixture = await packageFixture({ dependencies: { safe: "1.0.0" } });
    await mutateShrinkwrapRoot(fixture, (root) => {
      root["dependencies"] = { safe: "2.0.0" };
    });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "root dependencies do not match package.json",
    );
  });

  it("rejects third-party notices that do not match production dependencies", async () => {
    const fixture = await packageFixture();
    await writeFile(
      join(fixture, "THIRD_PARTY_NOTICES.md"),
      "| Package | Version | License |\n| --- | --- | --- |\n| `extra` | 1.0.0 | MIT |\n",
    );
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "does not match the locked production dependency tree",
    );
  });

  it("rejects an optional dependency override omitted from the shrinkwrap root", async () => {
    const fixture = await packageFixture({
      dependencies: { safe: "1.0.0" },
      optionalDependencies: { safe: "2.0.0" },
    });
    await mutateShrinkwrapRoot(fixture, (root) => {
      root["dependencies"] = { safe: "1.0.0" };
    });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "root optionalDependencies do not match package.json",
    );
  });

  it("rejects a peer dependency metadata mismatch", async () => {
    const fixture = await packageFixture({
      peerDependencies: { safe: "1.0.0" },
      peerDependenciesMeta: { safe: { optional: true } },
    });
    await mutateShrinkwrapRoot(fixture, (root) => {
      root["peerDependencies"] = { safe: "1.0.0" };
      root["peerDependenciesMeta"] = { safe: { optional: false } };
    });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "root peerDependenciesMeta do not match package.json",
    );
  });

  it.each([
    ["bundleDependencies", ["safe"]],
    ["bundleDependencies", true],
    ["bundleDependencies", { safe: true }],
    ["bundledDependencies", ["safe"]],
    ["bundledDependencies", true],
    ["bundledDependencies", { safe: true }],
  ])("rejects the %s bundle alias regardless of value shape", async (field, value) => {
    const fixture = await packageFixture({ [field]: value });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      `Bundled dependencies are forbidden: ${field}`,
    );
  });

  it.each([
    ["wrong package", "https://registry.npmjs.org/other/-/other-1.0.0.tgz", VALID_INTEGRITY],
    ["wrong version", "https://registry.npmjs.org/trusted/-/trusted-2.0.0.tgz", VALID_INTEGRITY],
    ["userinfo", "https://user@registry.npmjs.org/trusted/-/trusted-1.0.0.tgz", VALID_INTEGRITY],
    ["host prefix", "https://registry.npmjs.org.attacker.invalid/trusted/-/trusted-1.0.0.tgz", VALID_INTEGRITY],
    ["query", "https://registry.npmjs.org/trusted/-/trusted-1.0.0.tgz?x=1", VALID_INTEGRITY],
    ["fragment", "https://registry.npmjs.org/trusted/-/trusted-1.0.0.tgz#x", VALID_INTEGRITY],
    ["malformed integrity", "https://registry.npmjs.org/trusted/-/trusted-1.0.0.tgz", "sha512-short"],
  ])("rejects an untrusted shrinkwrap entry with %s", async (_case, resolved, integrity) => {
    const fixture = await packageFixture();
    await mutateShrinkwrapRoot(fixture, (_root, shrinkwrap) => {
      shrinkwrap.packages["node_modules/trusted"] = { version: "1.0.0", resolved, integrity };
    });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow("untrusted dependency entry");
  });

  it("verifies canonical packed lock entries without network access", async () => {
    const fixture = await packageFixture({ dependencies: { trusted: "1.0.0" } });
    await mutateShrinkwrapRoot(fixture, (root, shrinkwrap) => {
      root["dependencies"] = { trusted: "1.0.0" };
      shrinkwrap.packages["node_modules/trusted"] = {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/trusted/-/trusted-1.0.0.tgz",
        integrity: VALID_INTEGRITY,
        license: "MIT",
      };
    });
    await writeFile(
      join(fixture, "THIRD_PARTY_NOTICES.md"),
      "# Fixture notices\n\n| Package | Version | License |\n| --- | --- | --- |\n| `trusted` | 1.0.0 | MIT |\n",
    );
    const fetchImpl = vi.fn(() => {
      throw new Error("network access is forbidden during packed-artifact verification");
    });
    vi.stubGlobal("fetch", fetchImpl);
    await expect(verifyPackedArtifact(await pack(fixture))).resolves.toMatchObject({
      name: "borgmcp-server",
      version: "1.2.3",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects divergent integrity for duplicate package identities", async () => {
    const fixture = await packageFixture();
    await mutateShrinkwrapRoot(fixture, (_root, shrinkwrap) => {
      shrinkwrap.packages["node_modules/trusted"] = {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/trusted/-/trusted-1.0.0.tgz",
        integrity: VALID_INTEGRITY,
      };
      shrinkwrap.packages["node_modules/parent/node_modules/trusted"] = {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/trusted/-/trusted-1.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      };
    });
    await expect(verifyPackedArtifact(await pack(fixture))).rejects.toThrow(
      "divergent duplicate metadata: trusted@1.0.0",
    );
  });

  it("rejects a broken export from an installed packed artifact", async () => {
    const fixture = await packageFixture({
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/missing.js" } },
    });
    await expect(exercisePackedArtifact(await pack(fixture))).rejects.toMatchObject({
      stderr: expect.stringContaining("ERR_MODULE_NOT_FOUND"),
    });
  });
});

const VALID_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;

async function mutateShrinkwrapRoot(
  directory: string,
  mutate: (
    root: Record<string, unknown>,
    shrinkwrap: { packages: Record<string, Record<string, unknown>> },
  ) => void,
): Promise<void> {
  const path = join(directory, "npm-shrinkwrap.json");
  const shrinkwrap = JSON.parse(await readFile(path, "utf8")) as {
    packages: Record<string, Record<string, unknown>>;
  };
  mutate(shrinkwrap.packages[""]!, shrinkwrap);
  await writeFile(path, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
}

async function packageFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "borg-release-fixture-"));
  directories.push(directory);
  await execute("mkdir", ["-p", join(directory, "dist")]);
  await execute("mkdir", ["-p", join(directory, "src")]);
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
    engines: { node: ">=22.12.0", npm: ">=10.0.0" },
    files: [
      "dist",
      "src",
      "LICENSE",
      "NOTICE",
      "README.md",
      "SECURITY.md",
      "THIRD_PARTY_NOTICES.md",
      "npm-shrinkwrap.json",
    ],
    bin: { "borg-mcp-server": "./dist/main.js" },
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    dependencies: {},
    ...overrides,
  };
  await Promise.all([
    writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(directory, "LICENSE"), "Reviewed FSL fixture.\n"),
    writeFile(join(directory, "NOTICE"), "Fixture copyright notice.\n"),
    writeFile(join(directory, "README.md"), "# Server fixture\n"),
    writeFile(join(directory, "SECURITY.md"), "# Fixture security policy\n"),
    writeFile(join(directory, "THIRD_PARTY_NOTICES.md"), "# Fixture notices\n"),
    writeFile(join(directory, "npm-shrinkwrap.json"), `${JSON.stringify({
      name: "borgmcp-server",
      version: "1.2.3",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "borgmcp-server", version: "1.2.3", dependencies: {} } },
    }, null, 2)}\n`),
    writeFile(join(directory, "dist", "index.js"), "export const ready = true;\n"),
    writeFile(join(directory, "dist", "index.d.ts"), "export declare const ready: true;\n"),
    writeFile(join(directory, "dist", "main.js"), "#!/usr/bin/env node\nconsole.log('Usage: borg-mcp-server');\n"),
    writeFile(join(directory, "src", "index.ts"), "export const ready = true;\n"),
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
