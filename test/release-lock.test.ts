import { describe, expect, it, vi } from "vitest";

import { verifyLockfile } from "../scripts/verify-lock-registry.mjs";

const VALID_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;
const OTHER_INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

describe("release source lock", () => {
  it("binds every canonical entry to official registry metadata", async () => {
    const { manifest, lockfile } = fixture();
    const fetchImpl = officialFetch("trusted", "1.0.0", VALID_INTEGRITY);

    await expect(verifyLockfile(manifest, lockfile, sourceOptions(fetchImpl))).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/trusted/1.0.0",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("rejects a non-registry root dependency before metadata lookup", async () => {
    const { manifest, lockfile } = fixture();
    manifest["devDependencies"] = { tool: "git+ssh://git@github.com/example/tool.git#deadbeef" };
    lockfile.packages[""]!["devDependencies"] = manifest["devDependencies"];

    await expect(verifyLockfile(manifest, lockfile, sourceOptions(vi.fn()))).rejects.toThrow(
      "Dependency must be an exact registry version",
    );
  });

  it("rejects a root manifest mismatch", async () => {
    const { manifest, lockfile } = fixture();
    lockfile.packages[""]!["dependencies"] = { trusted: "2.0.0" };

    await expect(verifyLockfile(manifest, lockfile, sourceOptions(vi.fn()))).rejects.toThrow(
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

    await expect(verifyLockfile(manifest, lockfile, sourceOptions(vi.fn()))).rejects.toThrow(
      "package-lock.json contains an untrusted dependency entry",
    );
  });

  it("rejects divergent duplicate integrity", async () => {
    const { manifest, lockfile } = fixture();
    lockfile.packages["node_modules/parent/node_modules/trusted"] = {
      ...lockfile.packages["node_modules/trusted"],
      integrity: OTHER_INTEGRITY,
    };

    await expect(verifyLockfile(manifest, lockfile, sourceOptions(vi.fn()))).rejects.toThrow(
      "package-lock.json contains divergent duplicate metadata: trusted@1.0.0",
    );
  });

  it("rejects lock metadata that differs from the official registry", async () => {
    const { manifest, lockfile } = fixture();
    const fetchImpl = officialFetch("other", "1.0.0", VALID_INTEGRITY);

    await expect(verifyLockfile(manifest, lockfile, sourceOptions(fetchImpl))).rejects.toThrow(
      "package-lock.json metadata differs from the official registry",
    );
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

function sourceOptions(fetchImpl: typeof fetch): {
  lockName: string;
  rootFields: string[];
  dependencyFields: string[];
  fetchImpl: typeof fetch;
} {
  return {
    lockName: "package-lock.json",
    rootFields: ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "devDependencies"],
    dependencyFields: ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"],
    fetchImpl,
  };
}

function officialFetch(name: string, version: string, integrity: string): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({
    dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity,
    },
  }), { status: 200 }));
}
