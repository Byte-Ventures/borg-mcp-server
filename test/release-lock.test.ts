import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyLockfile } from "../scripts/verify-lock-registry.mjs";

const VALID_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;
const OTHER_INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const execute = promisify(execFile);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("release source lock", () => {
  it("validates every canonical entry without network access", async () => {
    const { manifest, lockfile } = fixture();
    const fetchImpl = vi.fn(() => {
      throw new Error("network access is forbidden during source-lock verification");
    });
    vi.stubGlobal("fetch", fetchImpl);

    await expect(verifyLockfile(manifest, lockfile, sourceOptions())).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-registry root dependency before lock-entry validation", async () => {
    const { manifest, lockfile } = fixture();
    manifest["devDependencies"] = { tool: "git+ssh://git@github.com/example/tool.git#deadbeef" };
    lockfile.packages[""]!["devDependencies"] = manifest["devDependencies"];

    await expect(verifyLockfile(manifest, lockfile, sourceOptions())).rejects.toThrow(
      "Dependency must be an exact registry version",
    );
  });

  it("rejects a root manifest mismatch", async () => {
    const { manifest, lockfile } = fixture();
    lockfile.packages[""]!["dependencies"] = { trusted: "2.0.0" };

    await expect(verifyLockfile(manifest, lockfile, sourceOptions())).rejects.toThrow(
      "package-lock.json root dependencies do not match package.json",
    );
  });

  it.each([
    ["git", { resolved: "git+ssh://git@github.com/example/trusted.git" }],
    ["file", { resolved: "file:../trusted" }],
    ["host prefix", { resolved: "https://registry.npmjs.org.attacker.invalid/trusted/-/trusted-1.0.0.tgz" }],
    ["malformed integrity", { integrity: "sha512-short" }],
    ["link", { link: true }],
  ])("rejects a hostile %s lock entry", async (_case, override) => {
    const { manifest, lockfile } = fixture();
    Object.assign(lockfile.packages["node_modules/trusted"]!, override);

    await expect(verifyLockfile(manifest, lockfile, sourceOptions())).rejects.toThrow(
      "package-lock.json contains an untrusted dependency entry",
    );
  });

  it("rejects divergent duplicate integrity", async () => {
    const { manifest, lockfile } = fixture();
    lockfile.packages["node_modules/parent/node_modules/trusted"] = {
      ...lockfile.packages["node_modules/trusted"],
      integrity: OTHER_INTEGRITY,
    };

    await expect(verifyLockfile(manifest, lockfile, sourceOptions())).rejects.toThrow(
      "package-lock.json contains divergent duplicate metadata: trusted@1.0.0",
    );
  });

  it.each([
    "node_modules/../node_modules/evil",
    "node_modules/./node_modules/evil",
    "node_modules/@../x/node_modules/evil",
    "node_modules/@scope/../node_modules/evil",
    "node_modules//evil",
    "node_modules\\evil",
    "/node_modules/evil",
    "C:/node_modules/evil",
    "node_modules/@scope",
    "node_modules/@scope/.pkg",
    "node_modules/@scope/..pkg",
  ])("rejects malformed or traversing package path %s", async (path) => {
    const { manifest, lockfile } = fixture();
    lockfile.packages[path] = {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
      integrity: VALID_INTEGRITY,
    };

    await expect(verifyLockfile(manifest, lockfile, sourceOptions())).rejects.toThrow(
      `Invalid package-lock.json package path: ${path}`,
    );
  });

  it("accepts repeated valid nested scoped and unscoped package paths", async () => {
    const { manifest, lockfile } = fixture();
    lockfile.packages["node_modules/@scope/parent/node_modules/child/node_modules/trusted"] = {
      ...lockfile.packages["node_modules/trusted"],
    };
    await expect(verifyLockfile(manifest, lockfile, sourceOptions())).resolves.toBeUndefined();
  });

  it.each([
    "node_modules/@.scope/pkg/node_modules/trusted",
    "node_modules/@scope/_pkg/node_modules/trusted",
  ])("preserves npm-valid scoped ancestor path %s", async (path) => {
    const { manifest, lockfile } = fixture();
    lockfile.packages[path] = { ...lockfile.packages["node_modules/trusted"] };
    await expect(verifyLockfile(manifest, lockfile, sourceOptions())).resolves.toBeUndefined();
  });

  it("matches the active npm validate-npm-package-name scoped-prefix semantics", async () => {
    const npmCommand = (await execute("sh", ["-c", "command -v npm"])).stdout.trim();
    const npmCli = await realpath(npmCommand);
    const validatorPath = join(dirname(npmCli), "..", "node_modules", "validate-npm-package-name", "lib", "index.js");
    const validatorModule = await import(pathToFileURL(validatorPath).href) as {
      default: (name: string) => { readonly validForNewPackages: boolean };
    };

    expect(validatorModule.default("@scope/.pkg").validForNewPackages).toBe(false);
    expect(validatorModule.default("@scope/..pkg").validForNewPackages).toBe(false);
    expect(validatorModule.default("@.scope/pkg").validForNewPackages).toBe(true);
    expect(validatorModule.default("@scope/_pkg").validForNewPackages).toBe(true);
  });
});

function fixture(): {
  manifest: Record<string, unknown>;
  lockfile: Record<string, unknown> & { packages: Record<string, Record<string, unknown>> };
} {
  const dependencies = { trusted: "1.0.0" };
  return {
    manifest: { name: "borgmcp-server", version: "1.2.3", dependencies },
    lockfile: {
      name: "borgmcp-server",
      version: "1.2.3",
      lockfileVersion: 3,
      packages: {
        "": { name: "borgmcp-server", version: "1.2.3", dependencies },
        "node_modules/trusted": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/trusted/-/trusted-1.0.0.tgz",
          integrity: VALID_INTEGRITY,
        },
      },
    },
  };
}

function sourceOptions(): {
  lockName: string;
  rootFields: string[];
  dependencyFields: string[];
} {
  return {
    lockName: "package-lock.json",
    rootFields: ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "devDependencies"],
    dependencyFields: ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"],
  };
}
