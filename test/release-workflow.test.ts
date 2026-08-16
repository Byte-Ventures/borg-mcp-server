import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function expectStagedPublicationLane(workflow: string): void {
  const stageCommand = 'npm stage publish "./release/${{ needs.verify.outputs.tarball }}" --ignore-scripts --access public --provenance --registry=https://registry.npmjs.org';
  expect(workflow.match(/^\s*npm stage publish\b.*$/gmu)).toEqual([
    `          ${stageCommand}`,
  ]);
  expect(workflow).not.toMatch(/^\s*npm publish\b/mu);
  expect(workflow).not.toContain("--tag staging");
  expect(workflow).not.toContain("npm dist-tag");
  expect(workflow).not.toContain("secrets.NPM_TOKEN");
  expect(workflow).not.toContain("NPM_TOKEN_PRESENT");

  const exercise = workflow.indexOf("Exercise exact tarball once");
  const preflight = workflow.indexOf("verify-registry-release.mjs prepublish release/artifact-report.json");
  const stage = workflow.indexOf(stageCommand);
  expect(exercise).toBeGreaterThan(-1);
  expect(preflight).toBeGreaterThan(exercise);
  expect(stage).toBeGreaterThan(preflight);
}

describe("server release lane", () => {
  it("uses one package authority and one protected publish with no post-publish readback", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
    const [verification = "", afterVerify = ""] = workflow.split("\n  publish:\n");
    const publication = afterVerify;

    expect(workflow).toContain("tags: ['v*.*.*']");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(verification).not.toContain("environment:");
    expect(verification).not.toContain("id-token: write");
    expect(publication).toContain("needs: verify");
    expect(publication).toContain("environment:\n      name: npm-publish");
    expect(publication).toContain("id-token: write");
    expect(workflow).not.toContain("\n  registry-verification:\n");

    expect(workflow.match(/npm ci --ignore-scripts/g)).toHaveLength(1);
    expect(workflow.match(/npm audit --audit-level=high/g)).toHaveLength(1);
    expect(workflow.match(/npm run typecheck && npm run build/g)).toHaveLength(1);
    expect(workflow.match(/npm pack --ignore-scripts/g)).toHaveLength(1);
    expect(workflow.match(/verify-packed-artifact\.mjs/g)).toHaveLength(1);
    expect(workflow.match(/exercise-packed-artifact\.mjs/g)).toHaveLength(1);
    expectStagedPublicationLane(workflow);
    expect(workflow.match(/npm install --prefix "\$\{npm_prefix\}"/g)).toHaveLength(1);

    expect(verification).toContain("Upload same-run release artifact");
    expect(verification).toContain("release/${{ steps.pack.outputs.tarball }}");
    expect(verification).toContain("release/artifact-report.json");
    expect(publication).toContain("Download same-run release artifact");
    expect(publication).toContain("npm-release-${{ needs.verify.outputs.version }}");
    expect(publication).toContain("verify-registry-release.mjs prepublish release/artifact-report.json");
    expect(publication).toContain("NPM_EXPECTED_OWNER: ${{ vars.NPM_EXPECTED_OWNER }}");
    expect(publication).toContain("--ignore-scripts --access public --provenance");
    expect(publication).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}"');
    expect(publication).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"');
    expect(publication).toContain('test -z "${NODE_AUTH_TOKEN:-}"');

    expect(workflow).not.toContain("verify-registry-release.mjs postpublish");
    expect(workflow).not.toContain("npm audit signatures");

    for (const removed of [
      "ARTIFACT_SR_SHA512",
      "SERVER_1016_APPROVED_SHA",
      "SERVER_PUBLIC_REVIEW_APPROVED_SHA",
      "SERVER_RELEASE_AUTHORIZATION",
      "ALLOW_UNCLAIMED_FIRST_PUBLISH",
      "NPM_TOKEN_PRESENT",
      "SHA512SUMS",
      "sha512sum --check",
      "run-evidence.txt",
      "npm sbom",
      "normalize-release-sbom",
      "verify-release-sbom",
      "dsseEnvelope",
      "in-toto",
      "SLSA",
    ]) {
      expect(workflow).not.toContain(removed);
    }

    expect(workflow).toContain(
      'test "$(sha256sum LICENSE | cut -d \' \' -f1)" = "9535abd9881dc5af88523e24e0bed77df8dddd0f255bb74710533ac71140d2a1"',
    );
    expect(workflow).toContain("node scripts/verify-source-lock.mjs");
    expect(workflow).toContain('git cat-file -t "${release_ref}"');
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("registry-url:");
    expect(notices).toContain(
      "Deterministic CycloneDX SBOM tooling and tests validate the locked dependency\ngraph independently of publication.",
    );
    expect(notices).toContain(
      "The Trusted Publishing workflow neither\ngenerates nor ships an SBOM.",
    );
    expect(notices).not.toContain("The release workflow generates a CycloneDX SBOM");

    for (const line of workflow.split("\n").filter((value) => value.trim().startsWith("uses:"))) {
      expect(line).toMatch(/@[0-9a-f]{40}(?:\s+#.*)?$/u);
    }
  });

  it("rejects replacing staged publication with bare npm publish", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const mutant = workflow.replace("npm stage publish", "npm publish");

    expect(() => expectStagedPublicationLane(mutant)).toThrow();
  });

});
