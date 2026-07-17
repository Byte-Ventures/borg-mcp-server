import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

const extractPreflightScript = (workflow: string): string => {
  const script = workflow.match(/          node <<'NODE'\n([\s\S]*?)\n          NODE/u)?.[1];
  return script?.replace(/^ {10}/gmu, "") ?? "";
};

describe("server release lane", () => {
  it("keeps verification unprivileged and publication exact-artifact gated", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const [, preflightAndRelease = ""] = workflow.split("\n  oidc-preflight:\n");
    const [preflight = "", releaseJobs = ""] = preflightAndRelease.split("\n  verify:\n");
    const [verification = "", publication = ""] = releaseJobs.split("\n  publish:\n");

    expect(workflow).toContain("tags: ['v*.*.*']");
    expect(workflow).toContain("workflow_dispatch:");
    expect(preflight).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(preflight).toContain("environment:\n      name: npm-publish");
    expect(preflight).toContain("id-token: write");
    expect(preflight).toContain('test "${GITHUB_RUN_ATTEMPT}" = "1"');
    expect(preflight).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(preflight).toContain('test "${GITHUB_REF_TYPE}" = "branch"');
    expect(preflight).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}"');
    expect(preflight).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"');
    expect(preflight).toContain('test -z "${NODE_AUTH_TOKEN:-}"');
    expect(preflight).toContain('const audience = "npm:registry.npmjs.org";');
    expect(preflight).toContain("/-/npm/v1/oidc/token/exchange/package/borgmcp-server");
    expect(preflight).toContain("diagnostics.idStatus = idResponse.status");
    expect(preflight).toContain("diagnostics.exchangeStatus = exchangeResponse.status");
    expect(preflight).toContain("diagnostics.exchangeBody = JSON.stringify(redactTokenFields(exchange))");
    expect(preflight).toContain('key !== "token_type" && /token|authorization|credential|secret/i.test(key)');
    expect(preflight).toContain('assertClaim(claims, "event_name", "workflow_dispatch")');
    expect(preflight).toContain('assertClaim(claims, "ref", "refs/heads/main")');
    expect(preflight).toContain("Date.parse(exchange.expires) > Date.now()");
    expect(preflight).toContain("Trusted-publisher exchange validation failed: ${message}");
    expect(preflight).toContain("GitHub OIDC response status: ${diagnostics.idStatus}");
    expect(preflight).toContain("npm exchange response status: ${diagnostics.exchangeStatus}");
    expect(preflight).toContain("npm exchange response body: ${diagnostics.exchangeBody}");
    expect(preflight).not.toContain("console.error(error)");
    expect(preflight).not.toContain("console.error(exchangeText)");
    expect(preflight).not.toContain("GITHUB_OUTPUT");
    expect(preflight).not.toContain("GITHUB_ENV");
    expect(preflight).not.toContain("actions/upload-artifact");
    expect(preflight).not.toContain("npm publish");
    expect(preflight).not.toContain("npm stage");
    expect(verification).toContain("if: github.event_name == 'push'");
    expect(verification).not.toContain("id-token: write");
    expect(verification).not.toContain("environment:");
    expect(verification).not.toContain("NODE_AUTH_TOKEN");
    expect(publication).toContain("needs: verify");
    expect(publication).toContain("if: github.event_name == 'push'");
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
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(publication).toContain('NPM_TOKEN_PRESENT: "false"');
    expect(workflow).not.toContain("npm-publish-auth.npmrc");
    expect(publication).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}"');
    expect(publication).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"');
    expect(publication).toContain('test -z "${NODE_AUTH_TOKEN:-}"');
    const publishCommand = publication.indexOf('npm publish "./release/${{ needs.verify.outputs.tarball }}"');
    expect(publishCommand).toBeGreaterThan(publication.indexOf('test -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}"'));
    expect(publishCommand).toBeGreaterThan(publication.indexOf('test -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"'));
    expect(publishCommand).toBeGreaterThan(publication.indexOf('test -z "${NODE_AUTH_TOKEN:-}"'));
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

  it("reports exchange failures without exposing either OIDC token", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const preflightScript = extractPreflightScript(workflow);
    expect(preflightScript).not.toBe("");
    const mockFetch = `
      const claims = {
        aud: "npm:registry.npmjs.org",
        repository: "Byte-Ventures/borg-mcp-server",
        environment: "npm-publish",
        runner_environment: "github-hosted",
        event_name: "workflow_dispatch",
        ref: "refs/heads/main",
        workflow_ref: "Byte-Ventures/borg-mcp-server/.github/workflows/release.yml@refs/heads/main",
      };
      const jwt = ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");
      const responses = [
        { status: 200, text: async () => JSON.stringify({ value: jwt }) },
        { status: 403, text: async () => JSON.stringify({
          message: "publisher mismatch",
          token: "npm-sensitive-token",
          nested: { authorization: "nested-sensitive-authorization" },
        }) },
      ];
      global.fetch = async () => responses.shift();
    `;
    let failure: { stderr?: string; stdout?: string } | undefined;

    try {
      await execute(process.execPath, ["-e", `${mockFetch}\n${preflightScript}`], {
        env: {
          ...process.env,
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-sensitive-token",
        },
      });
    } catch (error) {
      failure = error as { stderr?: string; stdout?: string };
    }

    expect(failure).toBeDefined();
    expect(failure?.stderr).toContain(
      "Trusted-publisher exchange validation failed: npm rejected the trusted-publisher exchange with status 403",
    );
    expect(failure?.stderr).toContain("GitHub OIDC response status: 200");
    expect(failure?.stderr).toContain("npm exchange response status: 403");
    expect(failure?.stderr).toContain(
      'npm exchange response body: {"message":"publisher mismatch","token":"[REDACTED]",' +
      '"nested":{"authorization":"[REDACTED]"}}',
    );
    expect(failure?.stderr).not.toContain("npm-sensitive-token");
    expect(failure?.stderr).not.toContain("nested-sensitive-authorization");
    expect(failure?.stderr).not.toContain("github-request-sensitive-token");
    expect(failure?.stdout).toBe("");
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
      "first-attempt preflight from protected `main`",
      "29573450568",
      'GITHUB_TOKEN="$(gh auth token)" node scripts/verify-main-ruleset.mjs',
      "tag authorization record must name the reviewed verifier commit",
    ]) {
      expect(runbook).toContain(gate);
    }
    expect(runbook).toContain("The repository is public; visibility is complete");
    expect(runbook).not.toContain("The repository remains private");
  });
});
