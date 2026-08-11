import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyReleasePullRequest,
  prepareRelease,
  verifyReleaseProvenance,
  verifyReleaseIdentity,
  type ReleaseAuthorities,
  type ReleaseRecord,
} from "../scripts/release-identity.mjs";

// Synthetic versions exercise the verifier without coupling fixtures to the live package identity.
const oldVersion = "1.2.3";
const newVersion = "1.3.0";
const integrity = `sha512-${"A".repeat(86)}==`;
const fixturePinPath = "test/version-pin.test.ts";
const failedRunId = 456;
const failedVerifyJobId = 789;
const failedPublishJobId = 790;
const directories: string[] = [];
const authoredReleaseStepNames = [
  "Check out tagged source",
  "Reject immutable release reruns and repository npm configuration",
  "Set up exact Node.js",
  "Verify immutable release source and readiness boundaries",
  "Verify source lock before dependency installation",
  "Install locked dependencies without lifecycle scripts",
  "Audit locked dependency tree",
  "Check, test, and build once",
  "Build exact release tarball once",
  "Verify exact release tarball once",
  "Exercise exact tarball once",
  "Upload same-run release artifact",
] as const;
const fixtureUsesStepNames = new Set([
  "Check out tagged source",
  "Set up exact Node.js",
  "Upload same-run release artifact",
]);
const fixtureReleaseWorkflow = [
  "name: Verify and publish npm release",
  "jobs:",
  "  verify:",
  "    steps:",
  ...authoredReleaseStepNames.flatMap((name) => [
    `      - name: ${name}`,
    fixtureUsesStepNames.has(name) ? "        uses: example/action@v1" : "        run: true",
  ]),
  "  publish:",
  "    needs: verify",
  "    steps:",
  "      - name: Publish package",
  "        run: true",
  "",
].join("\n");

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

  it("keeps the authored verify-step names synchronized with the release workflow", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain("\n  verify:\n");
    expect(workflow).toContain("\n  publish:\n");
    for (const name of authoredReleaseStepNames) {
      expect(workflow).toContain(`      - name: ${name}`);
    }
  });

  it("keeps the visitor-first README unpinned and release-safe", async () => {
    const readme = await readFile("README.md", "utf8");
    const headings = [...readme.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);

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

  it.each([
    ["during checkout", "checkout"],
    ["during source verification", "source"],
    ["during source lock verification", "lock"],
    ["during dependency audit", "audit"],
    ["before the release phases", "check"],
    ["during tarball build", "build"],
    ["during tarball verification", "verify"],
    ["during tarball exercise", "exercise"],
    ["during artifact upload", "upload"],
  ] as const)("prepares failed-superseded recovery %s", async (_description, failurePhase) => {
    const fixture = await createFailedFixture(failurePhase);
    const prepared = await prepareRelease(
      fixture.root,
      newVersion,
      fixture.evidence,
      fixture.authorities,
    );

    expect(prepared.record).toMatchObject({
      outcome: "failed-superseded",
      version: oldVersion,
      workflow_conclusion: "failure",
      verify_job_id: failedVerifyJobId,
      publish_job_id: failedPublishJobId,
      artifact_integrity: null,
    });
    expect(prepared.provenanceAnchor).toMatchObject({
      outcome: "published",
      version: fixture.anchorRecord.version,
    });
    expect(new Set(fixture.artifactRequests)).toEqual(new Set([fixture.anchorRecord.version]));

    const candidate = commitAll(fixture.root, "prepare recovery release");
    expect(verifyReleaseIdentity(
      fixture.root,
      fixture.base,
      candidate,
      fixture.authorities,
    )).toMatchObject({ oldVersion, newVersion, candidate });
    expect(new Set(fixture.artifactRequests)).toEqual(new Set([fixture.anchorRecord.version]));
  });

  it("rejects an otherwise-valid failed-superseded rerun attempt", async () => {
    const fixture = await createFailedFixture();
    const attemptTwoAuthorities: ReleaseAuthorities = {
      ...fixture.authorities,
      githubRun: (root, runId, attempt) => ({
        ...fixture.authorities.githubRun(root, runId, attempt),
        run_attempt: 2,
      }),
      githubRunJobs: (root, runId, attempt) => {
        const response = fixture.authorities.githubRunJobs(root, runId, attempt) as {
          jobs: Array<Record<string, unknown>>;
        };
        return {
          ...response,
          jobs: response.jobs.map((job) => ({ ...job, run_attempt: 2 })),
        };
      },
    };

    const attemptTwoRecord: ReleaseRecord = {
      outcome: "failed-superseded",
      version: oldVersion,
      tag: `v${oldVersion}`,
      tag_object: git(fixture.root, ["rev-parse", `v${oldVersion}^{tag}`]),
      commit: fixture.base,
      tree: git(fixture.root, ["rev-parse", `${fixture.base}^{tree}`]),
      workflow_run_id: failedRunId,
      workflow_run_attempt: 2,
      workflow_conclusion: "failure",
      verify_job_id: failedVerifyJobId,
      publish_job_id: failedPublishJobId,
      artifact_integrity: null,
    };
    expect(() => verifyReleaseProvenance(
      fixture.root,
      attemptTwoRecord,
      attemptTwoAuthorities,
    )).toThrow(/exactly workflow attempt 1/);

    await expect(prepareRelease(fixture.root, newVersion, {
      ...fixture.evidence,
      workflowRunAttempt: 2,
    }, attemptTwoAuthorities)).rejects.toThrow(/exactly workflow attempt 1/);
  });

  it("rejects failed recovery when artifact or publication phases were reached", async () => {
    const fixture = await createFailedFixture();
    const jobs = failedRunJobs(fixture.base) as {
      jobs: Array<{
        name: string;
        conclusion: string;
        steps: Array<{ name: string; number: number; status: string; conclusion: string }>;
      }>;
    };
    jobs.jobs[0]!.steps.find((step) => step.name === "Upload same-run release artifact")!.conclusion = "success";
    await expect(prepareRelease(fixture.root, newVersion, fixture.evidence, {
      ...fixture.authorities,
      githubRunJobs: () => jobs,
    })).rejects.toThrow(
      "Failed-superseded release step was not skipped: Upload same-run release artifact",
    );

    const publishedJobs = failedRunJobs(fixture.base) as typeof jobs;
    publishedJobs.jobs[1]!.conclusion = "success";
    publishedJobs.jobs[1]!.steps = [{
      name: "Publish package",
      number: 1,
      status: "completed",
      conclusion: "success",
    }];
    await expect(prepareRelease(fixture.root, newVersion, fixture.evidence, {
      ...fixture.authorities,
      githubRunJobs: () => publishedJobs,
    })).rejects.toThrow(/pre-publication job evidence/);
  });

  it("rejects multiple authored failures and failures outside the authored chain", async () => {
    const doubleFailureFixture = await createFailedFixture("verify");
    const doubleFailureJobs = failedRunJobs(doubleFailureFixture.base, "verify") as {
      jobs: Array<{
        steps: Array<{ name: string; number: number; status: string; conclusion: string }>;
      }>;
    };
    doubleFailureJobs.jobs[0]!.steps.find((step) => step.name === "Check, test, and build once")!.conclusion = "failure";
    await expect(prepareRelease(
      doubleFailureFixture.root,
      newVersion,
      doubleFailureFixture.evidence,
      { ...doubleFailureFixture.authorities, githubRunJobs: () => doubleFailureJobs },
    )).rejects.toThrow("Failed-superseded release requires exactly one authored failure.");

    const wrongIdentityFixture = await createFailedFixture("verify");
    const wrongIdentityJobs = failedRunJobs(wrongIdentityFixture.base, "verify") as typeof doubleFailureJobs;
    wrongIdentityJobs.jobs[0]!.steps.push({
      name: "Unexpected failed step",
      number: 11,
      status: "completed",
      conclusion: "failure",
    });
    await expect(prepareRelease(
      wrongIdentityFixture.root,
      newVersion,
      wrongIdentityFixture.evidence,
      { ...wrongIdentityFixture.authorities, githubRunJobs: () => wrongIdentityJobs },
    )).rejects.toThrow("Failed-superseded release requires exactly one authored failure.");

    const conflictingCleanupFixture = await createFailedFixture("verify");
    const conflictingCleanupJobs = failedRunJobs(conflictingCleanupFixture.base, "verify") as typeof doubleFailureJobs;
    conflictingCleanupJobs.jobs[0]!.steps.push({
      name: "Post Check out tagged source",
      number: 11,
      status: "completed",
      conclusion: "failure",
    });
    await expect(prepareRelease(
      conflictingCleanupFixture.root,
      newVersion,
      conflictingCleanupFixture.evidence,
      { ...conflictingCleanupFixture.authorities, githubRunJobs: () => conflictingCleanupJobs },
    )).rejects.toThrow("Failed-superseded release requires exactly one authored failure.");

    const conflictingCompleteFixture = await createFailedFixture("verify");
    const conflictingCompleteJobs = failedRunJobs(conflictingCompleteFixture.base, "verify") as typeof doubleFailureJobs;
    conflictingCompleteJobs.jobs[0]!.steps.push({
      name: "Complete job",
      number: 9,
      status: "completed",
      conclusion: "failure",
    });
    await expect(prepareRelease(
      conflictingCompleteFixture.root,
      newVersion,
      conflictingCompleteFixture.evidence,
      { ...conflictingCompleteFixture.authorities, githubRunJobs: () => conflictingCompleteJobs },
    )).rejects.toThrow("Failed-superseded release requires exactly one authored failure.");

    const conflictingUploadFixture = await createFailedFixture("verify");
    const conflictingUploadJobs = failedRunJobs(conflictingUploadFixture.base, "verify") as typeof doubleFailureJobs;
    conflictingUploadJobs.jobs[0]!.steps.push({
      name: "Post Upload same-run release artifact",
      number: 11,
      status: "completed",
      conclusion: "failure",
    });
    await expect(prepareRelease(
      conflictingUploadFixture.root,
      newVersion,
      conflictingUploadFixture.evidence,
      { ...conflictingUploadFixture.authorities, githubRunJobs: () => conflictingUploadJobs },
    )).rejects.toThrow("Failed-superseded release requires exactly one authored failure.");

    const residualCleanupFixture = await createFailedFixture("verify");
    const residualCleanupJobs = failedRunJobs(residualCleanupFixture.base, "verify") as typeof doubleFailureJobs;
    residualCleanupJobs.jobs[0]!.steps.push({
      name: "Complete job",
      number: 20,
      status: "completed",
      conclusion: "failure",
    });
    const residualPrepared = await prepareRelease(
      residualCleanupFixture.root,
      newVersion,
      residualCleanupFixture.evidence,
      { ...residualCleanupFixture.authorities, githubRunJobs: () => residualCleanupJobs },
    );
    expect(residualPrepared.record.outcome).toBe("failed-superseded");

    const renumberedTailFixture = await createFailedFixture("verify");
    const renumberedTailJobs = failedRunJobs(renumberedTailFixture.base, "verify") as typeof doubleFailureJobs;
    renumberedTailJobs.jobs[0]!.steps.find((step) => step.name === "Post Set up exact Node.js")!.number = 30;
    const renumberedFailure = renumberedTailJobs.jobs[0]!.steps.find(
      (step) => step.name === "Post Check out tagged source",
    )!;
    renumberedFailure.number = 31;
    renumberedFailure.conclusion = "failure";
    renumberedTailJobs.jobs[0]!.steps.find((step) => step.name === "Complete job")!.number = 32;
    const renumberedPrepared = await prepareRelease(
      renumberedTailFixture.root,
      newVersion,
      renumberedTailFixture.evidence,
      { ...renumberedTailFixture.authorities, githubRunJobs: () => renumberedTailJobs },
    );
    expect(renumberedPrepared.record.outcome).toBe("failed-superseded");

    const unknownNumberFixture = await createFailedFixture("verify");
    const unknownNumberJobs = failedRunJobs(unknownNumberFixture.base, "verify") as typeof doubleFailureJobs;
    unknownNumberJobs.jobs[0]!.steps.push({
      name: "Unexpected failed step",
      number: 20,
      status: "completed",
      conclusion: "failure",
    });
    await expect(prepareRelease(
      unknownNumberFixture.root,
      newVersion,
      unknownNumberFixture.evidence,
      { ...unknownNumberFixture.authorities, githubRunJobs: () => unknownNumberJobs },
    )).rejects.toThrow("Failed-superseded release requires exactly one authored failure.");

    const unknownTailFixture = await createFailedFixture("verify");
    const unknownTailJobs = failedRunJobs(unknownTailFixture.base, "verify") as typeof doubleFailureJobs;
    unknownTailJobs.jobs[0]!.steps.push({
      name: "Unexpected failed step",
      number: 26,
      status: "completed",
      conclusion: "failure",
    });
    await expect(prepareRelease(
      unknownTailFixture.root,
      newVersion,
      unknownTailFixture.evidence,
      { ...unknownTailFixture.authorities, githubRunJobs: () => unknownTailJobs },
    )).rejects.toThrow("Failed-superseded release requires exactly one authored failure.");

    const unknownFailureFixture = await createFailedFixture("check");
    const unknownFailureJobs = failedRunJobs(unknownFailureFixture.base, "check") as typeof doubleFailureJobs;
    const authoredCheck = unknownFailureJobs.jobs[0]!.steps.find(
      (step) => step.name === "Check, test, and build once",
    )!;
    authoredCheck.status = "completed";
    authoredCheck.conclusion = "skipped";
    unknownFailureJobs.jobs[0]!.steps.unshift({
      name: "Set up job",
      number: 1,
      status: "completed",
      conclusion: "failure",
    });
    await expect(prepareRelease(
      unknownFailureFixture.root,
      newVersion,
      unknownFailureFixture.evidence,
      { ...unknownFailureFixture.authorities, githubRunJobs: () => unknownFailureJobs },
    )).rejects.toThrow("Failed-superseded release has no failed authored step.");

    const mixedFailureFixture = await createFailedFixture("verify");
    const mixedFailureJobs = failedRunJobs(mixedFailureFixture.base, "verify") as typeof doubleFailureJobs;
    mixedFailureJobs.jobs[0]!.steps.unshift({
      name: "Set up job",
      number: 1,
      status: "completed",
      conclusion: "failure",
    });
    await expect(prepareRelease(
      mixedFailureFixture.root,
      newVersion,
      mixedFailureFixture.evidence,
      { ...mixedFailureFixture.authorities, githubRunJobs: () => mixedFailureJobs },
    )).rejects.toThrow("Failed-superseded release requires exactly one authored failure.");
  });

  it("ignores a runner cleanup failure after a valid authored burn", async () => {
    const fixture = await createFailedFixture("verify");
    const jobs = failedRunJobs(fixture.base, "verify") as {
      jobs: Array<{
        steps: Array<{ name: string; number: number; status: string; conclusion: string }>;
      }>;
    };
    jobs.jobs[0]!.steps.find((step) => step.name === "Post Check out tagged source")!.conclusion = "failure";

    const prepared = await prepareRelease(fixture.root, newVersion, fixture.evidence, {
      ...fixture.authorities,
      githubRunJobs: () => jobs,
    });
    expect(prepared.record.outcome).toBe("failed-superseded");
  });

  it("rejects a failed record with an SRI or a registry-present version", async () => {
    const fixture = await createFailedFixture();
    await expect(prepareRelease(fixture.root, newVersion, {
      ...fixture.evidence,
      artifactIntegrity: integrity,
    }, fixture.authorities)).rejects.toThrow(/invalid or non-canonical shape/);

    await expect(prepareRelease(fixture.root, newVersion, fixture.evidence, {
      ...fixture.authorities,
      publishedVersions: () => [fixture.anchorRecord.version, oldVersion],
    })).rejects.toThrow(/version exists in the npm registry/);
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
  outcome?: "published" | "failed-superseded";
  version: string;
  tag: string;
  tag_object: string;
  commit: string;
  tree: string;
  workflow_run_id: number;
  workflow_run_attempt: number;
  workflow_conclusion?: "success" | "failure";
  verify_job_id?: number | null;
  publish_job_id?: number | null;
  artifact_integrity: string | null;
}

interface Fixture {
  readonly root: string;
  readonly base: string;
  readonly candidate: string;
  readonly authorities: ReleaseAuthorities;
}

interface FailedFixture {
  readonly root: string;
  readonly base: string;
  readonly evidence: {
    readonly workflowRunId: number;
    readonly workflowRunAttempt: number;
    readonly workflowConclusion: "failure";
  };
  readonly authorities: ReleaseAuthorities;
  readonly anchorRecord: ReleaseRecordFixture;
  readonly artifactRequests: string[];
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
  await writeFixture(root, ".github/workflows/release.yml", fixtureReleaseWorkflow);
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
    githubRunJobs: () => ({ jobs: [] }),
    publishedVersions: () => [],
  };
  return { root, base, authorities };
}

type FailedPhase = "checkout" | "source" | "lock" | "audit" | "check" | "build" | "verify" | "exercise" | "upload";

async function createFailedFixture(failurePhase: FailedPhase = "check"): Promise<FailedFixture> {
  const root = await mkdtemp(join(tmpdir(), "borg-release-identity-failed-"));
  directories.push(root);
  const anchorVersion = "1.0.0";
  await writeFixture(root, "scripts/release-identity-allowlist.json", `${JSON.stringify({
    versionPins: [fixturePinPath],
  }, null, 2)}\n`);
  await writeFixture(root, "docs/release-records.json", "[]\n");
  await writeFixture(root, "README.md", "# Server fixture\n");
  await writeFixture(root, ".github/workflows/release.yml", fixtureReleaseWorkflow);
  await writeFixture(root, "package.json", `${JSON.stringify({
    name: "borgmcp-server",
    version: anchorVersion,
    private: false,
    scripts: { "verify:release-identity": "node scripts/release-identity.mjs verify" },
  }, null, 2)}\n`);
  await writeFixture(root, "npm-shrinkwrap.json", `${JSON.stringify({
    name: "borgmcp-server",
    version: anchorVersion,
    lockfileVersion: 3,
    packages: { "": { name: "borgmcp-server", version: anchorVersion } },
  }, null, 2)}\n`);
  await writeFixture(root, "src/runtime-identity.ts", `export const SERVER_PACKAGE_VERSION = "${anchorVersion}";\n`);
  await writeFixture(root, fixturePinPath, `expect(packageVersion).toBe("${anchorVersion}");\n`);
  await writeFixture(root, ".github/workflows/release-identity.yml", "name: trusted fixture classifier\n");
  await writeFixture(root, "scripts/release-identity.mjs", "// trusted fixture verifier\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release-test@example.invalid"]);
  const anchorCommit = commitAll(root, "published anchor");
  git(root, ["tag", "-a", `v${anchorVersion}`, "-m", `release ${anchorVersion}`]);
  const anchorRecord: ReleaseRecordFixture = {
    version: anchorVersion,
    tag: `v${anchorVersion}`,
    tag_object: git(root, ["rev-parse", `v${anchorVersion}^{tag}`]),
    commit: anchorCommit,
    tree: git(root, ["rev-parse", `${anchorCommit}^{tree}`]),
    workflow_run_id: 122,
    workflow_run_attempt: 1,
    artifact_integrity: integrity,
  };
  await writeFixture(root, "docs/release-records.json", `${JSON.stringify([anchorRecord], null, 2)}\n`);
  await writeFixture(root, "package.json", `${JSON.stringify({
    name: "borgmcp-server",
    version: oldVersion,
    private: false,
    scripts: { "verify:release-identity": "node scripts/release-identity.mjs verify" },
  }, null, 2)}\n`);
  await writeFixture(root, "npm-shrinkwrap.json", `${JSON.stringify({
    name: "borgmcp-server",
    version: oldVersion,
    lockfileVersion: 3,
    packages: { "": { name: "borgmcp-server", version: oldVersion } },
  }, null, 2)}\n`);
  await writeFixture(root, "src/runtime-identity.ts", `export const SERVER_PACKAGE_VERSION = "${oldVersion}";\n`);
  await writeFixture(root, fixturePinPath, `expect(packageVersion).toBe("${oldVersion}");\n`);
  const base = commitAll(root, "failed release base");
  git(root, ["tag", "-a", `v${oldVersion}`, "-m", `release ${oldVersion}`]);
  const artifactRequests: string[] = [];
  const authorities: ReleaseAuthorities = {
    githubRun: (_root, runId) => runId === anchorRecord.workflow_run_id
      ? {
          id: anchorRecord.workflow_run_id,
          run_attempt: 1,
          head_sha: anchorRecord.commit,
          head_branch: anchorRecord.tag,
          event: "push",
          status: "completed",
          conclusion: "success",
          path: ".github/workflows/release.yml",
        }
      : {
          id: failedRunId,
          run_attempt: 1,
          head_sha: base,
          head_branch: `v${oldVersion}`,
          event: "push",
          status: "completed",
          conclusion: "failure",
          path: ".github/workflows/release.yml",
        },
    githubRunJobs: () => failedRunJobs(base, failurePhase),
    artifactIntegrity: (_root, version) => {
      artifactRequests.push(version);
      return integrity;
    },
    publishedVersions: () => [anchorVersion],
  };
  return {
    root,
    base,
    evidence: {
      workflowRunId: failedRunId,
      workflowRunAttempt: 1,
      workflowConclusion: "failure",
    },
    authorities,
    anchorRecord,
    artifactRequests,
  };
}

function failedRunJobs(commit: string, failurePhase: FailedPhase = "check"): Record<string, unknown> {
  const phaseByName = new Map([
    ["Check out tagged source", "checkout"],
    ["Verify immutable release source and readiness boundaries", "source"],
    ["Verify source lock before dependency installation", "lock"],
    ["Audit locked dependency tree", "audit"],
    ["Check, test, and build once", "check"],
    ["Build exact release tarball once", "build"],
    ["Verify exact release tarball once", "verify"],
    ["Exercise exact tarball once", "exercise"],
    ["Upload same-run release artifact", "upload"],
  ]);
  const failureIndex = authoredReleaseStepNames.findIndex((name) =>
    phaseByName.get(name) === failurePhase);
  const steps = [
    ...authoredReleaseStepNames.map((name, index) => ({
      name,
      number: index + 2,
      status: "completed",
      conclusion: index < failureIndex ? "success" : index === failureIndex ? "failure" : "skipped",
    })),
    { name: "Post Set up exact Node.js", number: 25, status: "completed", conclusion: "skipped" },
    { name: "Post Check out tagged source", number: 26, status: "completed", conclusion: "success" },
    { name: "Complete job", number: 27, status: "completed", conclusion: "success" },
  ];
  return {
    total_count: 2,
    jobs: [
      {
        id: failedVerifyJobId,
        run_id: failedRunId,
        run_attempt: 1,
        head_sha: commit,
        name: "verify",
        status: "completed",
        conclusion: "failure",
        steps,
      },
      {
        id: failedPublishJobId,
        run_id: failedRunId,
        run_attempt: 1,
        head_sha: commit,
        name: "publish",
        status: "completed",
        conclusion: "skipped",
        steps: [],
      },
    ],
  };
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
