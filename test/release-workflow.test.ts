import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function expectStagedPublicationLane(workflow: string): void {
  const stageCommand = 'npm stage publish "./release/${{ needs.verify.outputs.tarball }}" --ignore-scripts --access public --provenance --registry=https://registry.npmjs.org';
  expect(workflow).toContain(stageCommand);
  expect(workflow).not.toMatch(/^\s*npm publish\b/mu);
  expect(workflow).not.toContain("--tag staging");
  expect(workflow).not.toContain("npm dist-tag");
  expect(workflow).not.toContain("secrets.NPM_TOKEN");

  const exercise = workflow.indexOf("node scripts/exercise-packed-artifact.mjs");
  const preflight = workflow.indexOf("verify-registry-release.mjs prepublish release/artifact-report.json");
  const stage = workflow.indexOf(stageCommand);
  expect(exercise).toBeGreaterThan(-1);
  expect(preflight).toBeGreaterThan(exercise);
  expect(stage).toBeGreaterThan(preflight);
}

describe("server release lane", () => {
  it("verifies the release artifact before protected staged publication", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const [verification = "", afterVerify = ""] = workflow.split(/\n\s*publish:\s*\n/u);
    const publication = afterVerify;

    expect(workflow).not.toContain("workflow_dispatch:");
    expect(verification).not.toContain("environment:");
    expect(verification).not.toContain("id-token: write");
    expect(publication).toContain("needs: verify");
    expect(publication).toMatch(/environment:\s+name: npm-publish/u);
    expect(publication).toContain("id-token: write");

    expect(verification).toContain("npm pack --ignore-scripts");
    expect(verification).toContain("node scripts/verify-packed-artifact.mjs");
    expectStagedPublicationLane(workflow);

    expect(verification).toContain("release/${{ steps.pack.outputs.tarball }}");
    expect(verification).toContain("release/artifact-report.json");
    expect(publication).toContain("npm-release-${{ needs.verify.outputs.version }}");
    expect(publication).toContain("verify-registry-release.mjs prepublish release/artifact-report.json");
    expect(publication).toContain("NPM_EXPECTED_OWNER: ${{ vars.NPM_EXPECTED_OWNER }}");
    expect(publication).toContain("--ignore-scripts --access public --provenance");
    expect(publication).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}"');
    expect(publication).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"');
    expect(publication).toContain('test -z "${NODE_AUTH_TOKEN:-}"');

    expect(workflow).toContain("node scripts/verify-source-lock.mjs");
    expect(workflow).toContain('git cat-file -t "${release_ref}"');
    expect(workflow).toContain('test "${GITHUB_REF_NAME}" = "v${version}"');
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).not.toContain("registry-url:");

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
