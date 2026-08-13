import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assembleReleaseBody,
  assertReleasePullRequest,
  createGithubRelease,
  readTaggedReleaseNotes,
} from "../scripts/create-github-release.mjs";

const commit = "a".repeat(40);
const pullRequest = {
  number: 42,
  state: "closed",
  merged_at: "2026-08-12T00:00:00Z",
  base: { ref: "main" },
  head: { ref: "release/1.2.3" },
  merge_commit_sha: commit,
  html_url: "https://github.com/Byte-Ventures/borg-mcp-server/pull/42",
  body: "## Summary\n\nShipped exactly this.",
};

describe("GitHub Release operator", () => {
  it("accepts the release PR bound to the tagged merge commit", () => {
    expect(assertReleasePullRequest(
      [pullRequest],
      "1.2.3",
      commit,
      "Merge pull request #42 from Byte-Ventures/release/1.2.3",
    )).toBe(pullRequest);
  });

  it.each([
    ["multiple PRs", [pullRequest, { ...pullRequest, number: 43 }], "exactly one"],
    ["open PR", [{ ...pullRequest, state: "open" }], "closed and merged"],
    ["unmerged PR", [{ ...pullRequest, merged_at: null }], "closed and merged"],
    ["wrong base", [{ ...pullRequest, base: { ref: "develop" } }], "base main"],
    ["wrong head", [{ ...pullRequest, head: { ref: "release/1.2.4" } }], "head release/1.2.3"],
    ["wrong merge commit", [{ ...pullRequest, merge_commit_sha: "b".repeat(40) }], "tagged commit"],
  ])("rejects %s", (_case, pullRequests, message) => {
    expect(() => assertReleasePullRequest(
      pullRequests,
      "1.2.3",
      commit,
      "Merge pull request #42 from Byte-Ventures/release/1.2.3",
    )).toThrow(message);
  });

  it("rejects a local merge subject that names another PR", () => {
    expect(() => assertReleasePullRequest(
      [pullRequest],
      "1.2.3",
      commit,
      "Merge pull request #41 from Byte-Ventures/release/1.2.3",
    )).toThrow("local merge subject");
  });

  it("assembles framed evidence from exact tagged notes without the PR body", () => {
    const integrity = `sha512-${createHash("sha512").update("release").digest("base64")}`;
    const body = assembleReleaseBody({
      packageName: "borgmcp-server",
      version: "1.2.3",
      integrity,
      tag: "v1.2.3",
      commit,
      pullRequest,
      releaseNotes: "TAGGED-NOTES-SENTINEL",
    });

    expect(body).toBe([
      "## Package",
      "",
      "- Registry: https://www.npmjs.com/package/borgmcp-server/v/1.2.3",
      `- Live integrity: \`${integrity}\``,
      "- Published through npm Trusted Publishing with provenance.",
      "",
      "## Source",
      "",
      "- Tag: https://github.com/Byte-Ventures/borg-mcp-server/releases/tag/v1.2.3",
      `- Commit: https://github.com/Byte-Ventures/borg-mcp-server/commit/${commit}`,
      "- Pull request: https://github.com/Byte-Ventures/borg-mcp-server/pull/42",
      "",
      "## News and fixes",
      "",
      "TAGGED-NOTES-SENTINEL",
    ].join("\n"));
    expect(body).not.toContain(pullRequest.body);
  });

  it("verifies the workflow artifact against npm-live before creating the release", async () => {
    const integrity = `sha512-${createHash("sha512").update("release").digest("base64")}`;
    const requests: Array<{ url: string; options: RequestInit }> = [];
    let postpublishReport: unknown;
    const authorities = {
      git: (_root: string, args: string[]) => {
        if (args[0] === "cat-file") return "tag";
        if (args[0] === "rev-parse") return commit;
        if (args[0] === "for-each-ref") return "borgmcp-server 1.2.3";
        if (args[0] === "show" && args.includes("--format=%s")) {
          return "Merge pull request #42 from Byte-Ventures/release/1.2.3";
        }
        return "TAGGED-NOTES-SENTINEL";
      },
      gitFile: () => "TAGGED-NOTES-SENTINEL",
      githubApi: (_root: string, endpoint: string) => endpoint.includes("/pulls")
        ? [pullRequest]
        : { workflow_runs: [{
            id: 123,
            path: ".github/workflows/release.yml",
            head_sha: commit,
            head_branch: "v1.2.3",
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
          }] },
      artifactReport: async () => ({ name: "borgmcp-server", version: "1.2.3", integrity }),
      verifyPostpublish: async (report: unknown) => {
        postpublishReport = report;
        return { name: "borgmcp-server", version: "1.2.3", integrity, registryState: "verified" };
      },
      request: async (url: string, options: RequestInit) => {
        requests.push({ url, options });
        return requests.length === 1
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify({ html_url: "https://example.test/release" }), { status: 201 });
      },
    };

    await expect(createGithubRelease("1.2.3", {
      token: "test-token",
      authorities,
    })).resolves.toEqual({ html_url: "https://example.test/release" });
    expect(postpublishReport).toEqual({ name: "borgmcp-server", version: "1.2.3", integrity });
    expect(requests).toHaveLength(2);
    expect(requests.at(0)?.url).toContain("/releases/tags/v1.2.3");
    expect(JSON.parse(requests.at(1)?.options.body as string)).toMatchObject({
      tag_name: "v1.2.3",
      name: "borgmcp-server 1.2.3",
      make_latest: "true",
    });
    const createdBody = JSON.parse(requests.at(1)?.options.body as string).body as string;
    expect(createdBody).toContain("TAGGED-NOTES-SENTINEL");
    expect(createdBody).not.toContain(pullRequest.body);
  });

  it.each([
    ["missing", () => { throw new Error("missing"); }, "missing"],
    ["blank", () => "  \n", "blank"],
  ])("refuses %s tagged release notes before external verification", async (_case, notes, message) => {
    let artifactCalls = 0;
    const authorities = {
      git: (_root: string, args: string[]) => {
        if (args[0] === "cat-file") return "tag";
        if (args[0] === "rev-parse") return commit;
        if (args[0] === "for-each-ref") return "borgmcp-server 1.2.3";
        if (args[0] === "show" && args.includes("--format=%s")) {
          return "Merge pull request #42 from Byte-Ventures/release/1.2.3";
        }
        return notes();
      },
      gitFile: () => notes(),
      githubApi: () => { throw new Error("must not reach GitHub"); },
      artifactReport: async () => { artifactCalls += 1; return {}; },
      verifyPostpublish: async () => { throw new Error("must not verify"); },
      request: async () => { throw new Error("must not request"); },
    };
    await expect(createGithubRelease("1.2.3", {
      token: "test-token",
      authorities,
    })).rejects.toThrow(message);
    expect(artifactCalls).toBe(0);
  });

  it("refuses to post when the GitHub Release already exists", async () => {
    let requests = 0;
    const authorities = {
      git: (_root: string, args: string[]) => {
        if (args[0] === "cat-file") return "tag";
        if (args[0] === "rev-parse") return commit;
        if (args[0] === "for-each-ref") return "borgmcp-server 1.2.3";
        if (args[0] === "show" && args.includes("--format=%s")) {
          return "Merge pull request #42 from Byte-Ventures/release/1.2.3";
        }
        return "TAGGED-NOTES-SENTINEL";
      },
      gitFile: () => "TAGGED-NOTES-SENTINEL",
      githubApi: (_root: string, endpoint: string) => endpoint.includes("/pulls")
        ? [pullRequest]
        : { workflow_runs: [{
            id: 123,
            path: ".github/workflows/release.yml",
            head_sha: commit,
            head_branch: "v1.2.3",
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
          }] },
      artifactReport: async () => ({ name: "borgmcp-server", version: "1.2.3", integrity: "unused" }),
      verifyPostpublish: async () => ({
        name: "borgmcp-server",
        version: "1.2.3",
        integrity: `sha512-${"A".repeat(86)}==`,
        registryState: "verified",
      }),
      request: async () => {
        requests += 1;
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      },
    };

    await expect(createGithubRelease("1.2.3", {
      token: "test-token",
      authorities,
    })).rejects.toThrow("already exists");
    expect(requests).toBe(1);
  });

  it("pins the exact post-approval operator command in the runbook", async () => {
    const runbook = await readFile("docs/releasing.md", "utf8");
    expect(runbook).toContain(
      'GITHUB_TOKEN="$(gh auth token)" node scripts/create-github-release.mjs <version>',
    );
  });

  it("preserves tagged release-note whitespace through the default Git authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-release-notes-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
      await writeFile(join(root, "package.json"), "{\"private\":true}\n");
      await writeFile(join(root, "notes.md"), "first line  \nsecond line\n");
      execFileSync("git", ["add", "package.json", "notes.md"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      expect(readTaggedReleaseNotes(root, commit, "1.2.3", (_root, refPath) =>
        execFileSync("git", ["show", refPath.replace("docs/releases/1.2.3.md", "notes.md")], {
          cwd: root,
          encoding: "utf8",
        })
      )).toBe("first line  \nsecond line\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
