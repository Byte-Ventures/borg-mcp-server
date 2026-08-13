import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { assembleReleaseBody, createGithubRelease } from "../scripts/create-github-release.mjs";

const commit = "a".repeat(40);
const integrity = `sha512-${createHash("sha512").update("release").digest("base64")}`;

function authorities(overrides = {}) {
  return {
    git: (_root: string, args: string[], raw = false) => {
      const value = args[0] === "cat-file" ? "tag"
        : args[0] === "rev-parse" ? commit
        : args[0] === "for-each-ref" ? "borgmcp-server 1.2.3"
        : "Tagged notes.\n";
      return raw ? value : value.trim();
    },
    registryPackage: async () => ({ name: "borgmcp-server", version: "1.2.3", dist: { integrity } }),
    request: async (url: string) => url.endsWith("/releases")
      ? new Response(JSON.stringify({ html_url: "https://example.test/release" }), { status: 201 })
      : new Response(null, { status: 404 }),
    ...overrides,
  };
}

describe("GitHub Release operator", () => {
  it("assembles tagged notes with live package and source identity", () => {
    expect(assembleReleaseBody({
      version: "1.2.3", integrity, tag: "v1.2.3", commit, releaseNotes: "Tagged notes.\n",
    })).toContain("## News and fixes\n\nTagged notes.\n");
  });

  it("creates from annotated tag, tagged notes, and live package integrity", async () => {
    const system = authorities();
    await expect(createGithubRelease("1.2.3", {
      token: "test-token",
      authorities: system,
    })).resolves.toEqual({ html_url: "https://example.test/release" });
  });

  it("refuses missing tagged notes before registry or GitHub access", async () => {
    let registryReads = 0;
    const system = authorities({
      git: (_root: string, args: string[]) => {
        if (args[0] === "cat-file") return "tag";
        if (args[0] === "rev-parse") return commit;
        if (args[0] === "for-each-ref") return "borgmcp-server 1.2.3";
        throw new Error("missing");
      },
      registryPackage: async () => { registryReads += 1; return {}; },
    });
    await expect(createGithubRelease("1.2.3", {
      token: "test-token",
      authorities: system,
    })).rejects.toThrow("Tagged release notes are missing");
    expect(registryReads).toBe(0);
  });

  it("refuses an existing GitHub Release", async () => {
    const system = authorities({ request: async () => new Response("{}", { status: 200 }) });
    await expect(createGithubRelease("1.2.3", {
      token: "test-token",
      authorities: system,
    })).rejects.toThrow("already exists");
  });

  it("pins the operator command in the runbook", async () => {
    expect(await readFile("docs/releasing.md", "utf8")).toContain(
      'GITHUB_TOKEN="$(gh auth token)" node scripts/create-github-release.mjs <version>',
    );
  });
});
