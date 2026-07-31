import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyReleasePullRequest,
  prepareRelease,
  verifyReleaseIdentity,
  type ReleaseAuthorities,
} from "../scripts/release-identity.mjs";

// Synthetic versions exercise the verifier without coupling fixtures to the live package identity.
const oldVersion = "1.2.3";
const newVersion = "1.3.0";
const integrity = `sha512-${"A".repeat(86)}==`;
const fixturePinPath = "test/version-pin.test.ts";
const directories: string[] = [];

// Git-backed fixture tests are correctness checks, not performance gates on busy dev machines.
vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("release identity automation", () => {
  it("loads the classifier from the pull request base and never executes candidate code", async () => {
    const workflow = await readFile(".github/workflows/release-identity.yml", "utf8");
    const ordinaryCi = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toMatch(/^\s+push:/mu);
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("fetch-tags: true");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('git fetch --no-tags origin "$CANDIDATE_SHA"');
    expect(workflow).toContain("node scripts/release-identity.mjs classify");
    expect(workflow).toContain('--base "$BASE_SHA"');
    expect(workflow).toContain('--candidate "$CANDIDATE_SHA"');
    expect(workflow).not.toMatch(/\bnpm (?:ci|install|run)\b/u);
    expect(workflow.match(/uses: actions\/checkout/gu)).toHaveLength(1);
    expect(workflow).not.toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(ordinaryCi).not.toContain("'release/**'");
    expect(ordinaryCi).not.toContain("verify:release-identity");
  });

  it("keeps every production version pin explicit and live", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const allowlist = JSON.parse(
      await readFile("scripts/release-identity-allowlist.json", "utf8"),
    ) as { versionPins: string[] };
    expect(allowlist.versionPins).toEqual([...allowlist.versionPins].sort());
    for (const path of allowlist.versionPins) {
      expect((await readFile(path, "utf8")).split(manifest.version).length - 1).toBeGreaterThan(0);
    }
  });

  it("keeps the visitor-first README unpinned and release-safe", async () => {
    const readme = await readFile("README.md", "utf8");
    const headings = [...readme.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    const quickstart = readme.slice(0, readme.indexOf("## How it fits together"))
      .replaceAll(/\s+/gu, " ");

    expect(readme).not.toMatch(/sha512-[A-Za-z0-9+/]{86}==/u);
    expect(readme).not.toMatch(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/u);
    expect(headings).toEqual([
      "Install",
      "Requirements",
      "Install and quickstart",
      "How it fits together",
      "Security posture",
      "Reference and support",
    ]);
    expect(quickstart).toContain("borg-mcp-server setup");
    expect(quickstart).toContain("borg-mcp-server start");
    expect(quickstart).toContain("Setup initializes local storage and identity, but does not start the server or create a cube.");
    expect(quickstart).toContain("The server runs in the foreground");
    expect(quickstart).toContain("in another terminal to connect");
    expect(quickstart).toContain("https://127.0.0.1:7091");
    for (const [, path] of readme.matchAll(/\]\(([^):]+\.md)\)/gu)) {
      await expect(access(path!)).resolves.toBeUndefined();
    }
  });

  it("keeps current-state claims out of the historical release record", async () => {
    const releases = await readFile("RELEASES.md", "utf8");

    expectHistoricalReleaseRecord(releases);
  });

  it.each([
    ["current target", "The current public preview and install target is borgmcp-server."],
    ["current lock behavior", "Current lock verification remains entirely offline."],
    ["setup behavior", "Setup prepares local identity and storage and creates no cube."],
  ])("rejects the known %s claim from release history", async (_case, claim) => {
    const releases = await readFile("RELEASES.md", "utf8");

    expect(() => expectHistoricalReleaseRecord(`${releases}\n${claim}\n`)).toThrow();
  });

  it("prepares the exact generated surfaces and verifies their Git tree", async () => {
    const fixture = await createFixture();
    const prepared = await prepareRelease(fixture.root, newVersion, {
      workflowRunId: 123,
      workflowRunAttempt: 1,
      artifactIntegrity: integrity,
    }, fixture.authorities);

    expect(prepared).toMatchObject({ oldVersion, newVersion });
    expect(prepared.paths).toEqual([
      "docs/release-records.json",
      "npm-shrinkwrap.json",
      "package.json",
      "src/runtime-identity.ts",
      fixturePinPath,
    ]);
    expect(await readFile(join(fixture.root, "README.md"), "utf8")).toBe("# Server fixture\n");
    const candidate = commitAll(fixture.root, "prepare release");

    expect(verifyReleaseIdentity(
      fixture.root,
      fixture.base,
      candidate,
      fixture.authorities,
    )).toMatchObject({
      base: fixture.base,
      candidate,
      oldVersion,
      newVersion,
    });
  });

  it("runs trusted-base bytes green on the transform and red on a self-bypassing candidate", async () => {
    const fixture = await preparedFixture();
    git(fixture.root, ["checkout", "--detach", "-q", fixture.base]);

    expect(classifyReleasePullRequest(
      fixture.root,
      classificationInput(fixture, fixture.candidate),
      fixture.authorities,
    )).toMatchObject({ base: fixture.base, candidate: fixture.candidate });

    git(fixture.root, ["checkout", "--detach", "-q", fixture.candidate]);
    const manifestPath = join(fixture.root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["verify:release-identity"] = 'node -e "process.exit(0)" --';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(fixture.root, ".github/workflows/release-identity.yml"),
      "name: bypass\njobs: { classify: { steps: [{ run: 'true' }] } }\n",
    );
    await writeFile(
      join(fixture.root, "scripts/release-identity.mjs"),
      "process.exit(0);\n",
    );
    await writeFile(
      join(fixture.root, "src/unreviewed-payload.ts"),
      "export const unreviewed = true;\n",
    );
    const attack = commitAll(fixture.root, "replace classifier and add payload");

    git(fixture.root, ["checkout", "--detach", "-q", fixture.base]);
    expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.base);
    expect(() => classifyReleasePullRequest(
      fixture.root,
      classificationInput(fixture, attack),
      fixture.authorities,
    )).toThrow("package.json diff is not exactly the package version.");
  });

  it.each([
    ["wrong run id", (record: ReleaseRecordFixture) => { record.workflow_run_id = 999; }],
    ["wrong run attempt", (record: ReleaseRecordFixture) => { record.workflow_run_attempt = 2; }],
    ["wrong artifact SRI", (record: ReleaseRecordFixture) => {
      record.artifact_integrity = `sha512-${"B".repeat(86)}==`;
    }],
    ["wrong annotated tag object", (record: ReleaseRecordFixture) => {
      record.tag_object = "f".repeat(40);
    }],
    ["wrong peeled commit", (record: ReleaseRecordFixture) => {
      record.commit = "e".repeat(40);
    }],
  ])("rejects false provenance: %s", async (_description, mutate) => {
    const fixture = await preparedFixture();
    const recordsPath = join(fixture.root, "docs/release-records.json");
    const records = JSON.parse(await readFile(recordsPath, "utf8")) as ReleaseRecordFixture[];
    mutate(records[0]!);
    await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`);
    const candidate = commitAll(fixture.root, "mutate provenance");

    expect(() => verifyReleaseIdentity(
      fixture.root,
      fixture.base,
      candidate,
      fixture.authorities,
    )).toThrow();
  });

  it.each([
    ["a third shrinkwrap change", async (fixture: Fixture) => {
      const lockPath = join(fixture.root, "npm-shrinkwrap.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        packages: { "": { dependencies: Record<string, string> } };
      };
      lock.packages[""].dependencies["unexpected"] = "1.0.0";
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }],
    ["an extra runtime-constant edit", async (fixture: Fixture) => {
      const path = join(fixture.root, "src/runtime-identity.ts");
      await writeFile(path, `${await readFile(path, "utf8")}export const EXTRA = true;\n`);
    }],
    ["a decreased version assertion count", async (fixture: Fixture) => {
      const path = join(fixture.root, fixturePinPath);
      await writeFile(path, (await readFile(path, "utf8")).replace(newVersion, "fixture-version"));
    }],
    ["a changed release allowlist", async (fixture: Fixture) => {
      const path = join(fixture.root, "scripts/release-identity-allowlist.json");
      await writeFile(path, `${await readFile(path, "utf8")}\n`);
    }],
    ["a README edit outside the transform", async (fixture: Fixture) => {
      await writeFile(join(fixture.root, "README.md"), "# Changed during release prep\n");
    }],
    ["a hand edit outside the transform", async (fixture: Fixture) => {
      await writeFile(join(fixture.root, "manual-edit.txt"), "not release identity\n");
    }],
  ])("rejects %s", async (_description, mutate) => {
    const fixture = await preparedFixture();
    await mutate(fixture);
    const candidate = commitAll(fixture.root, "mutate release shape");

    expect(() => verifyReleaseIdentity(
      fixture.root,
      fixture.base,
      candidate,
      fixture.authorities,
    )).toThrow();
  });
});

interface ReleaseRecordFixture {
  version: string;
  tag: string;
  tag_object: string;
  commit: string;
  tree: string;
  workflow_run_id: number;
  workflow_run_attempt: number;
  artifact_integrity: string;
}

interface Fixture {
  readonly root: string;
  readonly base: string;
  readonly candidate: string;
  readonly authorities: ReleaseAuthorities;
}

async function preparedFixture(): Promise<Fixture> {
  const fixture = await createFixture();
  await prepareRelease(fixture.root, newVersion, {
    workflowRunId: 123,
    workflowRunAttempt: 1,
    artifactIntegrity: integrity,
  }, fixture.authorities);
  const candidate = commitAll(fixture.root, "prepare release");
  expect(() => verifyReleaseIdentity(
    fixture.root,
    fixture.base,
    candidate,
    fixture.authorities,
  )).not.toThrow();
  return { ...fixture, candidate };
}

async function createFixture(): Promise<Omit<Fixture, "candidate">> {
  const root = await mkdtemp(join(tmpdir(), "borg-release-identity-"));
  directories.push(root);
  const allowlist = { versionPins: [fixturePinPath] };
  await writeFixture(root, "scripts/release-identity-allowlist.json", `${JSON.stringify(allowlist, null, 2)}\n`);
  await writeFixture(root, "docs/release-records.json", "[]\n");
  await writeFixture(root, "README.md", "# Server fixture\n");
  await writeFixture(root, "package.json", `${JSON.stringify({
    name: "borgmcp-server",
    version: oldVersion,
    private: false,
    scripts: {
      "verify:release-identity": "node scripts/release-identity.mjs verify",
    },
  }, null, 2)}\n`);
  await writeFixture(
    root,
    ".github/workflows/release-identity.yml",
    "name: trusted fixture classifier\n",
  );
  await writeFixture(
    root,
    "scripts/release-identity.mjs",
    "// trusted fixture verifier\n",
  );
  await writeFixture(root, "npm-shrinkwrap.json", `${JSON.stringify({
    name: "borgmcp-server",
    version: oldVersion,
    lockfileVersion: 3,
    packages: {
      "": {
        name: "borgmcp-server",
        version: oldVersion,
        dependencies: { stable: "1.0.0" },
      },
    },
  }, null, 2)}\n`);
  await writeFixture(
    root,
    "src/runtime-identity.ts",
    `export const SERVER_PACKAGE_VERSION = "${oldVersion}";\n`,
  );
  await writeFixture(
    root,
    fixturePinPath,
    `expect(packageVersion).toBe("${oldVersion}");\n`,
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release-test@example.invalid"]);
  commitAll(root, "base");
  git(root, ["tag", "-a", `v${oldVersion}`, "-m", `release ${oldVersion}`]);
  const base = git(root, ["rev-parse", "HEAD"]);
  const authorities: ReleaseAuthorities = {
    githubRun: () => ({
      id: 123,
      run_attempt: 1,
      head_sha: base,
      head_branch: `v${oldVersion}`,
      event: "push",
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/release.yml",
    }),
    artifactIntegrity: () => integrity,
  };
  return { root, base, authorities };
}

function classificationInput(fixture: Fixture, candidate: string) {
  return {
    base: fixture.base,
    candidate,
    repository: "Byte-Ventures/borg-mcp-server",
    headRepository: "Byte-Ventures/borg-mcp-server",
    headRef: "release/0.3.0",
  };
}

async function writeFixture(root: string, path: string, value: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function expectHistoricalReleaseRecord(releases: string): void {
  expect(releases).not.toMatch(/\bcurrent(?:ly)?\b/iu);
  expect(releases).not.toMatch(/\bis the .*install target\b/iu);
  expect(releases).not.toContain("Setup prepares local identity and storage");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
