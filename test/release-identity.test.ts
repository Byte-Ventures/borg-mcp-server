import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  prepareRelease,
  verifyReleaseIdentity,
  type ReleaseAuthorities,
} from "../scripts/release-identity.mjs";

const oldVersion = "0.2.0";
const newVersion = "0.3.0";
const integrity = `sha512-${"A".repeat(86)}==`;
const fixturePinPath = "test/version-pin.test.ts";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("release identity automation", () => {
  it("runs the classifier on release branches in protected CI", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("- 'release/**'");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("npm run verify:release-identity -- --base origin/main");
  });

  it("keeps every production version pin explicit and live", async () => {
    const allowlist = JSON.parse(
      await readFile("scripts/release-identity-allowlist.json", "utf8"),
    ) as { versionPins: string[] };
    expect(allowlist.versionPins).toEqual([...allowlist.versionPins].sort());
    for (const path of allowlist.versionPins) {
      expect((await readFile(path, "utf8")).split(oldVersion).length - 1).toBeGreaterThan(0);
    }
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
    commitAll(fixture.root, "prepare release");

    expect(verifyReleaseIdentity(fixture.root, fixture.base, fixture.authorities)).toMatchObject({
      base: fixture.base,
      oldVersion,
      newVersion,
    });
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
    commitAll(fixture.root, "mutate provenance");

    expect(() => verifyReleaseIdentity(fixture.root, fixture.base, fixture.authorities)).toThrow();
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
    ["a hand edit outside the transform", async (fixture: Fixture) => {
      await writeFile(join(fixture.root, "manual-edit.txt"), "not release identity\n");
    }],
  ])("rejects %s", async (_description, mutate) => {
    const fixture = await preparedFixture();
    await mutate(fixture);
    commitAll(fixture.root, "mutate release shape");

    expect(() => verifyReleaseIdentity(fixture.root, fixture.base, fixture.authorities)).toThrow();
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
  readonly authorities: ReleaseAuthorities;
}

async function preparedFixture(): Promise<Fixture> {
  const fixture = await createFixture();
  await prepareRelease(fixture.root, newVersion, {
    workflowRunId: 123,
    workflowRunAttempt: 1,
    artifactIntegrity: integrity,
  }, fixture.authorities);
  commitAll(fixture.root, "prepare release");
  expect(() => verifyReleaseIdentity(fixture.root, fixture.base, fixture.authorities)).not.toThrow();
  return fixture;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "borg-release-identity-"));
  directories.push(root);
  const allowlist = { versionPins: [fixturePinPath] };
  await writeFixture(root, "scripts/release-identity-allowlist.json", `${JSON.stringify(allowlist, null, 2)}\n`);
  await writeFixture(root, "docs/release-records.json", "[]\n");
  await writeFixture(root, "package.json", `${JSON.stringify({
    name: "borgmcp-server",
    version: oldVersion,
    private: false,
  }, null, 2)}\n`);
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

async function writeFixture(root: string, path: string, value: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", message]);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
