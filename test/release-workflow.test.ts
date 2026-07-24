import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("server release lane", () => {
  it("uses one package authority and one protected publish with no post-publish readback", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
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
    expect(workflow.match(/npm run check/g)).toHaveLength(1);
    expect(workflow.match(/npm pack --ignore-scripts/g)).toHaveLength(1);
    expect(workflow.match(/verify-packed-artifact\.mjs/g)).toHaveLength(1);
    expect(workflow.match(/exercise-packed-artifact\.mjs/g)).toHaveLength(1);
    expect(workflow.match(/npm publish "\.\/release\//g)).toHaveLength(1);
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

    for (const line of workflow.split("\n").filter((value) => value.trim().startsWith("uses:"))) {
      expect(line).toMatch(/@[0-9a-f]{40}(?:\s+#.*)?$/u);
    }
  });

  it("rejects reruns of an immutable release tag", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const guard = workflow.match(/test "\$\{GITHUB_RUN_ATTEMPT\}" = "1"/u)?.[0];
    expect(guard).toBeDefined();
    expect(workflow.match(/test "\$\{GITHUB_RUN_ATTEMPT\}" = "1"/gu)).toHaveLength(1);
    const environment = { ...process.env, GITHUB_RUN_ATTEMPT: "1" };

    await expect(execute("bash", ["-c", guard!], { env: environment })).resolves.toBeDefined();
    environment.GITHUB_RUN_ATTEMPT = "2";
    await expect(execute("bash", ["-c", guard!], { env: environment })).rejects.toBeDefined();
  });

  it.each([
    ["v1.2.3", "1.2.3", true],
    ["v1.2.4", "1.2.3", false],
    ["latest", "1.2.3", false],
  ])("binds tag %s to package version %s", async (tag, version, accepted) => {
    const guard = 'test "${GITHUB_REF_NAME}" = "v${version}"';
    const execution = execute("bash", ["-c", guard], {
      env: { ...process.env, GITHUB_REF_NAME: tag, version },
    });
    if (accepted) await expect(execution).resolves.toBeDefined();
    else await expect(execution).rejects.toBeDefined();
  });

  it("rejects hostile source npm config before dependency installation", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const guard = workflow.match(/test ! -e \.npmrc/u)?.[0];
    expect(guard).toBeDefined();
    const directory = await mkdtemp(join(tmpdir(), "borg-hostile-npmrc-"));
    const marker = join(directory, "install-reached");
    await writeFile(join(directory, ".npmrc"), "registry=https://attacker.invalid/\n");

    try {
      await expect(execute("bash", ["-c", `set -e\n${guard}\nprintf reached > install-reached`], {
        cwd: directory,
      })).rejects.toBeDefined();
      await expect(access(marker)).rejects.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("documents the minimal lane and every immutable release boundary", async () => {
    const runbook = await readFile("docs/releasing.md", "utf8");

    for (const gate of [
      "server preview threat model",
      "exact-byte audit trail",
      "public-boundary CR, SR, Release Quality",
      "separate release authorization",
      "Never move, reuse, force-update, or rerun a failed release tag",
      "one build, test, package, and artifact-verification authority",
      "same-run tarball and verifier report",
      "npm Trusted Publishing with provenance",
      "terminal release boundary",
      'GITHUB_TOKEN="$(gh auth token)" node scripts/verify-main-ruleset.mjs',
      "tag authorization record must name the reviewed verifier commit",
      "borgmcp-server@0.1.7",
      "`v0.1.6` tag object",
      "29743430282",
      "`v0.1.7` tag object",
      "29746180767",
      "`v0.1.8` tag object",
      "29839429539",
      "`v0.1.9` tag object",
      "29852829882",
      "`v0.1.10` tag object",
      "29926421741",
      "npm continued to return E404 for `borgmcp-server@0.1.10`",
      "`v0.1.11` tag object",
      "e44b79d6259fb460758231320274b8acad4b9e42",
      "71ea6e5add780674c0ec1ee9d5558c96ac473dfe",
      "29931051243",
      "sha512-FhNtO2OC8im4/ZByoG8qMbvYjNh/dTyn2tmnnwDNp6K3GLB2nzDXBlxMAamdYCZhdPPq70+LTri53Byrhre6kA==",
      "`v0.1.12` tag object",
      "2d032c61800eccc385b0b321fe6f5ecd5b975e34",
      "22da161f7491e38a3306069445ac76dd9e7433ca",
      "29941142539",
      "sha512-byOxuZ/QM6iufynaA3f1UCERtUp2uFwxqF4fc5QavEDYgb3RJJSAhjHRJ8ImiXZQYnhnYHWN+YdStx2pGH8y5Q==",
      "`v0.1.13` tag object",
      "8bf820e1d58a7afe9c511868838914dd5d01461d",
      "8d9f4256d007367077aba03467ec25ef36759104",
      "29955068612",
      "npm returns E404 for `borgmcp-server@0.1.13`",
      "`v0.1.14` tag object",
      "af363916e10f20389479b04301c7e9fa0e7b7529",
      "049fd95cd3bea10fba3324b58a31883f5f750954",
      "29955574922",
      "sha512-lMPr6z2ta5j1xa+LHC7UWQ0UYeH66CtGFzHtgdyYhcGxFUk0b/hMoaUGbBS+bVhNDHEHILWKYcbl2DFum7KKjQ==",
      "`v0.1.15` tag object",
      "90dc7a418b5c7a848f01920cda3fa9ca5b44dab9",
      "f9b2748119690044cb28fb0d90177b32b0bfd60f",
      "29988717879",
      "sha512-xaBG29PKa2xEN+e90caMWDs20w75ZH1biyDhLlg3klYrPOWOf+dh1qD1FqkUn9Lk/Y+koxJJjsQrhw/r8+Uo3g==",
      "`v0.1.16` tag object",
      "e7f1bb84a0e011f5aa5a781b1d65179b4d15f975",
      "325f4c80b8ca7e885e6243762d1818d00ecf332d",
      "30019803768",
      "sha512-P+xQVnmrSfQ5AzSoPKGo1H20lpyEEfBt8fEBVutKmeaBt0RbQFgGuYZk5WDbb9ACzQ/95wICTecPBAUQUq4fYA==",
      "live `borgmcp-server@0.1.16` package",
      "Version `0.1.16` remains the install target",
      "`borgmcp-server@0.1.17` candidate",
      "synchronized loopback client bursts",
      "LAN per-address protections",
      "truthful advisory Agent CLI",
      "working-repository seat metadata",
      "borgmcp-shared@0.6.1",
      "github.com/Byte-Ventures/borg-mcp-client",
      "github.com/Byte-Ventures/borg-mcp-shared",
    ]) {
      expect(runbook).toContain(gate);
    }
    expect(runbook).toContain("The server repository is public; visibility is complete");
    expect(runbook).not.toContain("The repository remains private");
    expect(runbook).not.toContain("#1016");
    expect(runbook).not.toContain("#1026");
  });
});
