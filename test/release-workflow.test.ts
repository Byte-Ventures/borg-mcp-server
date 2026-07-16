import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("server release lane", () => {
  it("keeps verification unprivileged and publication exact-artifact gated", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const [verification = "", publication = ""] = workflow.split("\n  publish:\n");

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
    expect(workflow).toContain('test "${REPOSITORY_PRIVATE}" = "false"');
    expect(workflow).toContain('test "${GITHUB_RUN_ATTEMPT}" = "1"');
    expect(workflow).toContain("release/run-evidence.txt");
    expect(publication).toContain("ARTIFACT_SR_SHA512");
    expect(workflow).toContain("git cat-file -t \"${release_ref}\"");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("Download security-audited artifact");
    expect(workflow).toContain('node scripts/exercise-packed-artifact.mjs "./release/${{ steps.pack.outputs.tarball }}"');
    const rawSbom = verification.indexOf("npm sbom --sbom-format cyclonedx");
    const normalizeSbom = verification.indexOf("node scripts/normalize-release-sbom.mjs");
    const verifySbom = verification.indexOf("node scripts/verify-release-sbom.mjs");
    const uploadSbom = verification.lastIndexOf("release/sbom-report.json");
    expect(rawSbom).toBeGreaterThan(-1);
    expect(normalizeSbom).toBeGreaterThan(rawSbom);
    expect(verifySbom).toBeGreaterThan(normalizeSbom);
    expect(uploadSbom).toBeGreaterThan(verifySbom);
    const sourceLockVerification = verification.indexOf("node scripts/verify-source-lock.mjs");
    const dependencyInstall = verification.indexOf("npm ci --ignore-scripts");
    expect(sourceLockVerification).toBeGreaterThan(-1);
    expect(dependencyInstall).toBeGreaterThan(sourceLockVerification);
    expect(workflow).toContain("npm publish \"./release/${{ needs.verify.outputs.tarball }}\"");
    expect(workflow.match(/npm publish \"\.\/release\//g)).toHaveLength(2);
    expect(verification).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow.match(/NODE_AUTH_TOKEN/g)).toHaveLength(1);
    expect(publication).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).not.toContain("registry-url:");
    expect(workflow).not.toContain("npm install --global");
    expect(workflow).not.toContain("verify-main-ruleset.mjs");
    expect(workflow).not.toMatch(/uses: [^\n]+@(v|main|master)\b/u);
    for (const job of [verification, publication]) {
      const attemptGuard = job.indexOf('test "${GITHUB_RUN_ATTEMPT}" = "1"');
      const guard = job.indexOf("test ! -e .npmrc");
      const setupNode = job.indexOf("uses: actions/setup-node@");
      const bootstrap = job.indexOf('npm install --prefix "${npm_prefix}"');
      expect(attemptGuard).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(attemptGuard);
      expect(setupNode).toBeGreaterThan(attemptGuard);
      expect(setupNode).toBeGreaterThan(guard);
      expect(bootstrap).toBeGreaterThan(setupNode);
      expect(job.slice(bootstrap, job.indexOf("\n", bootstrap))).toContain(
        "--registry=https://registry.npmjs.org npm@11.18.0",
      );
      expect(job).toContain('NPM_CONFIG_USERCONFIG="${bootstrap_config}/user.npmrc"');
      expect(job).toContain('NPM_CONFIG_GLOBALCONFIG="${bootstrap_config}/global.npmrc"');
      expect(job).toContain('"NPM_CONFIG_USERCONFIG=${NPM_CONFIG_USERCONFIG}"');
      expect(job).toContain('"NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}" >> "${GITHUB_ENV}"');
      expect(job).toContain('config get registry)" = "https://registry.npmjs.org/"');
    }
  });

  it("keeps pre-install source-lock verification builtin-only", async () => {
    for (const path of ["scripts/verify-source-lock.mjs", "scripts/verify-lock-registry.mjs"]) {
      const source = await readFile(path, "utf8");
      const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"];$/gmu)].map((match) => match[1]);
      expect(imports.every((specifier) => specifier?.startsWith("node:") || specifier === "./verify-lock-registry.mjs"))
        .toBe(true);
    }
  });

  it("rejects reruns of an immutable release tag", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const guard = workflow.match(/test "\$\{GITHUB_RUN_ATTEMPT\}" = "1"/u)?.[0];
    expect(guard).toBeDefined();
    const environment = { ...process.env, GITHUB_RUN_ATTEMPT: "1" };

    await expect(execute("bash", ["-c", guard!], { env: environment })).resolves.toBeDefined();
    environment.GITHUB_RUN_ATTEMPT = "2";
    await expect(execute("bash", ["-c", guard!], { env: environment })).rejects.toBeDefined();
  });

  it("rejects hostile source config and keeps trusted bootstrap config outside the workspace", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const guard = workflow.match(/test ! -e \.npmrc/u)?.[0];
    expect(guard).toBeDefined();
    const directory = await mkdtemp(join(tmpdir(), "borg-hostile-npmrc-"));
    const marker = join(directory, "bootstrap-reached");
    await writeFile(join(directory, ".npmrc"), "registry=https://attacker.invalid/\n");

    try {
      await expect(execute("bash", ["-c", `set -e\n${guard}\nprintf reached > bootstrap-reached`], {
        cwd: directory,
      })).rejects.toBeDefined();
      await expect(access(marker)).rejects.toBeDefined();

      await rm(join(directory, ".npmrc"));
      await expect(execute("bash", ["-c", [
        "set -e",
        guard,
        'mkdir -p "${RUNNER_TEMP}/config"',
        'printf trusted > "${RUNNER_TEMP}/config/user.npmrc"',
        "test ! -e .npmrc",
        "printf reached > bootstrap-reached",
      ].join("\n")], {
        cwd: directory,
        env: { ...process.env, RUNNER_TEMP: join(directory, "runner") },
      })).resolves.toBeDefined();
      await expect(access(join(directory, ".npmrc"))).rejects.toBeDefined();
      await expect(readFile(join(directory, "runner", "config", "user.npmrc"), "utf8")).resolves.toBe("trusted");
      await expect(readFile(marker, "utf8")).resolves.toBe("reached");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      'GITHUB_TOKEN="$(gh auth token)" node scripts/verify-main-ruleset.mjs',
      "tag authorization record must name the reviewed verifier commit",
    ]) {
      expect(runbook).toContain(gate);
    }
    expect(runbook).toContain("The repository is public; visibility is complete");
    expect(runbook).not.toContain("The repository remains private");
  });
});
