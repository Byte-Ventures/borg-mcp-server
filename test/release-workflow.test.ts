import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("server release lane", () => {
  it("keeps verification unprivileged and publication exact-artifact gated", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const [verification, publication] = workflow.split("\n  publish:\n");

    expect(workflow).toContain("tags: ['v*.*.*']");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(verification).not.toContain("id-token: write");
    expect(verification).not.toContain("environment:");
    expect(verification).not.toContain("NODE_AUTH_TOKEN");
    expect(publication).toContain("needs: verify");
    expect(publication).toContain("environment:\n      name: npm-publish");
    expect(publication).toContain("id-token: write");
    expect(workflow).toContain("SERVER_1016_APPROVED_SHA");
    expect(workflow).toContain("SERVER_FSL_COUNSEL_LICENSE_SHA256");
    expect(workflow).toContain("SERVER_PUBLIC_REVIEW_APPROVED_SHA");
    expect(workflow).toContain("SERVER_RELEASE_AUTHORIZATION");
    expect(publication).toContain("ARTIFACT_SR_SHA512");
    expect(workflow).toContain("git cat-file -t \"${release_ref}\"");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("Download security-audited artifact");
    expect(workflow).toContain("npm publish \"./release/${{ needs.verify.outputs.tarball }}\"");
    expect(workflow.match(/npm publish \"\.\/release\//g)).toHaveLength(2);
    expect(workflow.match(/NODE_AUTH_TOKEN/g)).toHaveLength(1);
    expect(workflow).not.toContain("npm install --global");
    expect(workflow).not.toMatch(/uses: [^\n]+@(v|main|master)\b/u);
  });

  it("documents every external release blocker and immutable failure procedure", async () => {
    const runbook = await readFile("docs/releasing.md", "utf8");

    for (const gate of [
      "#1016",
      "#1026",
      "SERVER_FSL_COUNSEL_LICENSE_SHA256",
      "public-boundary CR, SR, Release Quality",
      "ARTIFACT_SR_SHA512",
      "separate release authorization",
      "Never move, reuse, force-update, or rerun a failed release tag",
    ]) {
      expect(runbook).toContain(gate);
    }
  });
});
