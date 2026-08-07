import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "borgmcp-server";
const REPOSITORY = "Byte-Ventures/borg-mcp-server";
const WORKFLOW_PATH = ".github/workflows/release.yml";
const ALLOWLIST_PATH = "scripts/release-identity-allowlist.json";
const RECORDS_PATH = "docs/release-records.json";
const PACKAGE_PATH = "package.json";
const LOCK_PATH = "npm-shrinkwrap.json";
const VERSION_CONSTANT_PATH = "src/runtime-identity.ts";
const RUNNER_SETUP_STEP_COUNT = 1;
const RELEASE_WORKFLOW_ATTEMPT = 1;
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const registryVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const sriPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const releaseHeadPattern = /^release\/[A-Za-z0-9._/-]+$/u;

function fail(message) {
  throw new Error(message);
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    maxBuffer: 10 * 1024 * 1024,
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  }).trim();
}

function git(root, args, options = {}) {
  return command("git", args, { cwd: root, ...options });
}

function gitRaw(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function resolveExactCommit(root, input, description) {
  if (!shaPattern.test(input)) fail(`${description} must be an exact 40-character commit SHA.`);
  const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${input}^{commit}`]);
  if (commit !== input) fail(`${description} did not resolve to the exact requested commit.`);
  return commit;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(raw, description) {
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${description} is not valid JSON.`);
  }
}

function requireStableVersion(value, description) {
  if (!stableVersionPattern.test(value) ||
      value.split(".").some((part) => !Number.isSafeInteger(Number(part)))) {
    fail(`${description} must be a stable x.y.z version with safe integer components.`);
  }
  return value;
}

function requireInitialWorkflowAttempt(value, description) {
  if (value !== RELEASE_WORKFLOW_ATTEMPT) {
    fail(`${description} must be exactly workflow attempt 1; release workflow reruns are not release authority.`);
  }
  return value;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function countLiteral(raw, literal) {
  return raw.split(literal).length - 1;
}

function replaceVersionPins(raw, oldVersion, newVersion, path) {
  const oldCount = countLiteral(raw, oldVersion);
  if (oldCount === 0) fail(`Version-pin allowlist entry has no ${oldVersion} assertion: ${path}`);
  const replaced = raw.replaceAll(oldVersion, newVersion);
  const newCount = countLiteral(replaced, newVersion);
  if (countLiteral(replaced, oldVersion) !== 0 || newCount < oldCount) {
    fail(`Version-pin assertion count decreased: ${path}`);
  }
  return replaced;
}

function decodeAllowlist(raw) {
  const parsed = parseJson(raw, ALLOWLIST_PATH);
  const pins = parsed?.versionPins;
  if (!Array.isArray(pins) || pins.length === 0 ||
      pins.some((path) => typeof path !== "string" || path.length === 0 ||
        path.startsWith("-") || path.startsWith("/") || path.includes("\\") ||
        path.split("/").some((part) => part === "" || part === "." || part === "..") ||
        /[\u0000-\u001f\u007f]/u.test(path)) ||
      new Set(pins).size !== pins.length ||
      JSON.stringify([...pins].sort()) !== JSON.stringify(pins)) {
    fail(`${ALLOWLIST_PATH} must contain a unique, sorted, non-empty versionPins array.`);
  }
  return pins;
}

function decodeRecords(raw) {
  const parsed = parseJson(raw, RECORDS_PATH);
  if (!Array.isArray(parsed)) fail(`${RECORDS_PATH} must be an array.`);
  parsed.forEach((record) => decodeRecord(record));
  return parsed;
}

function transformPackage(raw, oldVersion, newVersion) {
  const manifest = parseJson(raw, PACKAGE_PATH);
  if (manifest.name !== PACKAGE_NAME || manifest.version !== oldVersion) {
    fail(`${PACKAGE_PATH} does not have the expected package identity.`);
  }
  manifest.version = newVersion;
  return canonicalJson(manifest);
}

function transformLock(raw, oldVersion, newVersion) {
  const lock = parseJson(raw, LOCK_PATH);
  if (lock.name !== PACKAGE_NAME || lock.version !== oldVersion ||
      lock.packages?.[""]?.name !== PACKAGE_NAME ||
      lock.packages?.[""]?.version !== oldVersion) {
    fail(`${LOCK_PATH} does not have the expected root identity.`);
  }
  lock.version = newVersion;
  lock.packages[""].version = newVersion;
  return canonicalJson(lock);
}

function transformVersionConstant(raw, oldVersion, newVersion) {
  const expected = `export const SERVER_PACKAGE_VERSION = "${oldVersion}";`;
  if (countLiteral(raw, expected) !== 1) {
    fail(`${VERSION_CONSTANT_PATH} must contain exactly one package-version literal.`);
  }
  return raw.replace(expected, `export const SERVER_PACKAGE_VERSION = "${newVersion}";`);
}

function decodeRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    fail("Release record is not an object.");
  }
  const legacyKeys = [
    "version", "tag", "tag_object", "commit", "tree",
    "workflow_run_id", "workflow_run_attempt", "artifact_integrity",
  ];
  const canonicalKeys = [
    "outcome", "version", "tag", "tag_object", "commit", "tree",
    "workflow_run_id", "workflow_run_attempt", "workflow_conclusion",
    "verify_job_id", "publish_job_id", "artifact_integrity",
  ];
  const keys = JSON.stringify(Object.keys(record));
  const isLegacy = keys === JSON.stringify(legacyKeys);
  const isCanonical = keys === JSON.stringify(canonicalKeys);
  const decoded = isLegacy
    ? {
        outcome: "published",
        version: record.version,
        tag: record.tag,
        tag_object: record.tag_object,
        commit: record.commit,
        tree: record.tree,
        workflow_run_id: record.workflow_run_id,
        workflow_run_attempt: record.workflow_run_attempt,
        workflow_conclusion: "success",
        verify_job_id: null,
        publish_job_id: null,
        artifact_integrity: record.artifact_integrity,
      }
    : {
        outcome: record.outcome,
        version: record.version,
        tag: record.tag,
        tag_object: record.tag_object,
        commit: record.commit,
        tree: record.tree,
        workflow_run_id: record.workflow_run_id,
        workflow_run_attempt: record.workflow_run_attempt,
        workflow_conclusion: record.workflow_conclusion,
        verify_job_id: record.verify_job_id,
        publish_job_id: record.publish_job_id,
        artifact_integrity: record.artifact_integrity,
      };
  const published = decoded.outcome === "published" &&
    decoded.workflow_conclusion === "success" &&
    decoded.verify_job_id === null && decoded.publish_job_id === null &&
    sriPattern.test(decoded.artifact_integrity);
  const failedSuperseded = decoded.outcome === "failed-superseded" &&
    decoded.workflow_conclusion === "failure" &&
    Number.isSafeInteger(decoded.verify_job_id) && decoded.verify_job_id > 0 &&
    Number.isSafeInteger(decoded.publish_job_id) && decoded.publish_job_id > 0 &&
    decoded.artifact_integrity === null;
  if (Number.isSafeInteger(decoded.workflow_run_attempt)) {
    requireInitialWorkflowAttempt(
      decoded.workflow_run_attempt,
      "Release record workflow run attempt",
    );
  }
  if ((!isLegacy && !isCanonical) || (!published && !failedSuperseded) ||
      typeof decoded.version !== "string" ||
      !stableVersionPattern.test(decoded.version) ||
      decoded.version.split(".").some((part) => !Number.isSafeInteger(Number(part))) ||
      decoded.tag !== `v${decoded.version}` ||
      !shaPattern.test(decoded.tag_object) ||
      !shaPattern.test(decoded.commit) ||
      !shaPattern.test(decoded.tree) ||
      !Number.isSafeInteger(decoded.workflow_run_id) || decoded.workflow_run_id <= 0 ||
      !Number.isSafeInteger(decoded.workflow_run_attempt) ||
      (isCanonical && JSON.stringify(Object.keys(record)) !== JSON.stringify(canonicalKeys)) ||
      (isLegacy && JSON.stringify(Object.keys(record)) !== JSON.stringify(legacyKeys))) {
    fail("Release record has an invalid or non-canonical shape.");
  }
  return Object.freeze(decoded);
}

export function deriveGitProvenance(root, version) {
  const tag = `v${requireStableVersion(version, "Released version")}`;
  const ref = `refs/tags/${tag}`;
  let type;
  try {
    type = git(root, ["cat-file", "-t", ref]);
  } catch {
    fail(`Annotated release tag is missing: ${tag}`);
  }
  if (type !== "tag") fail(`Release tag is not annotated: ${tag}`);
  return Object.freeze({
    version,
    tag,
    tag_object: git(root, ["rev-parse", `${ref}^{tag}`]),
    commit: git(root, ["rev-parse", `${ref}^{commit}`]),
    tree: git(root, ["rev-parse", `${ref}^{commit}^{tree}`]),
  });
}

export const systemAuthorities = Object.freeze({
  githubRun(root, runId, attempt) {
    const response = command("gh", [
      "api",
      `repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`,
    ], { cwd: root });
    return parseJson(response, "GitHub Actions run");
  },
  githubRunJobs(root, runId, attempt) {
    const response = command("gh", [
      "api",
      `repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    ], { cwd: root });
    return parseJson(response, "GitHub Actions run jobs");
  },
  artifactIntegrity(root, version) {
    const response = command("npm", [
      "view",
      `${PACKAGE_NAME}@${version}`,
      "dist.integrity",
      "--json",
      "--registry=https://registry.npmjs.org",
    ], { cwd: root });
    return parseJson(response, "npm artifact integrity");
  },
  publishedVersions(root) {
    const response = command("npm", [
      "view",
      PACKAGE_NAME,
      "versions",
      "--json",
      "--registry=https://registry.npmjs.org",
    ], { cwd: root });
    return parseJson(response, "npm published versions");
  },
});

function decodePublishedVersions(input) {
  const versions = typeof input === "string" ? [input] : input;
  if (!Array.isArray(versions) || versions.some((version) =>
    typeof version !== "string" || !registryVersionPattern.test(version)) ||
    new Set(versions).size !== versions.length) {
    fail("npm published-version authority returned an invalid response.");
  }
  return versions;
}

function deriveReleaseStepIdentities(root, tag) {
  let workflow;
  try {
    workflow = git(root, ["show", `${tag}:${WORKFLOW_PATH}`]);
  } catch {
    fail(`Failed-superseded release workflow is missing at the failed tag: ${WORKFLOW_PATH}`);
  }
  const verifyStart = workflow.indexOf("\n  verify:");
  const stepsStart = workflow.indexOf("\n    steps:", verifyStart);
  const publishStart = workflow.indexOf("\n  publish:", stepsStart);
  if (verifyStart === -1 || stepsStart === -1 || publishStart === -1 || stepsStart > publishStart) {
    fail("Failed-superseded release workflow has no parseable verify job steps.");
  }
  const names = [];
  const postStepNames = [];
  let currentStep = null;
  const finishCurrentStep = () => {
    if (currentStep?.uses === true) postStepNames.push(`Post ${currentStep.name}`);
    currentStep = null;
  };
  for (const line of workflow.slice(stepsStart, publishStart).split("\n")) {
    if (/^ {6}-\s+/u.test(line)) {
      finishCurrentStep();
      const match = line.match(/^ {6}- name:\s*(\S.*)$/u);
      if (match === null) {
        fail("Failed-superseded release workflow has an unnamed verify step.");
      }
      currentStep = { name: match[1].trim(), uses: false };
      names.push(currentStep.name);
      continue;
    }
    if (currentStep !== null && /^ {8}uses:\s*\S/u.test(line)) currentStep.uses = true;
  }
  finishCurrentStep();
  if (names.length === 0 || new Set(names).size !== names.length) {
    fail("Failed-superseded release workflow has no unique authored verify steps.");
  }
  return Object.freeze({
    authoredSteps: Object.freeze(names.map((name, index) => Object.freeze({
      name,
      number: index + RUNNER_SETUP_STEP_COUNT + 1,
    }))),
    runnerStepNames: Object.freeze([
      "Set up job",
      "Complete job",
      ...postStepNames,
    ]),
  });
}

function deriveRunnerCleanupIdentities(steps, runnerStepNames, authoredSteps) {
  const authoredMaxNumber = Math.max(...authoredSteps.map(({ step }) => step.number));
  const stepsByNumber = new Map();
  for (const step of steps) {
    if (!Number.isSafeInteger(step?.number)) continue;
    const matches = stepsByNumber.get(step.number) ?? [];
    matches.push(step);
    stepsByNumber.set(step.number, matches);
  }
  const completeSteps = steps.filter((step) =>
    step?.name === "Complete job" &&
    Number.isSafeInteger(step.number) &&
    step.number > authoredMaxNumber);
  if (completeSteps.length !== 1) return Object.freeze([]);

  const cleanupIdentities = [];
  for (let number = completeSteps[0].number; number > authoredMaxNumber; number -= 1) {
    const matches = stepsByNumber.get(number);
    if (matches?.length !== 1) break;
    const [step] = matches;
    if (number === completeSteps[0].number) {
      if (step.name !== "Complete job") break;
    } else if (step.name === "Set up job" || !runnerStepNames.includes(step.name)) {
      break;
    }
    cleanupIdentities.push(Object.freeze({ name: step.name, number }));
  }
  return Object.freeze(cleanupIdentities);
}

function failedPhaseEvidence(root, record, authorities, requireRecordedIds = true) {
  requireInitialWorkflowAttempt(
    record.workflow_run_attempt,
    "Failed-superseded workflow run attempt",
  );
  const response = authorities.githubRunJobs(
    root,
    record.workflow_run_id,
    record.workflow_run_attempt,
  );
  if (response === null || typeof response !== "object" || !Array.isArray(response.jobs)) {
    fail("Failed-superseded release job authority returned an invalid response.");
  }
  const verifyJobs = response.jobs.filter((job) => job?.name === "verify");
  const publishJobs = response.jobs.filter((job) => job?.name === "publish");
  if (verifyJobs.length !== 1 || publishJobs.length !== 1) {
    fail("Failed-superseded release requires exactly one verify and one publish job.");
  }
  const [verifyJob] = verifyJobs;
  const [publishJob] = publishJobs;
  const commonJobShape = (job) => Number.isSafeInteger(job.id) && job.id > 0 &&
    job.run_id === record.workflow_run_id &&
    job.run_attempt === record.workflow_run_attempt &&
    job.head_sha === record.commit &&
    job.status === "completed";
  if (!commonJobShape(verifyJob) ||
      (requireRecordedIds && verifyJob.id !== record.verify_job_id) ||
      verifyJob.conclusion !== "failure" || !Array.isArray(verifyJob.steps) ||
      !commonJobShape(publishJob) ||
      (requireRecordedIds && publishJob.id !== record.publish_job_id) ||
      publishJob.conclusion !== "skipped" || !Array.isArray(publishJob.steps) ||
      publishJob.steps.length !== 0) {
    fail("Failed-superseded release does not match authoritative pre-publication job evidence.");
  }
  const { authoredSteps: expectedAuthoredSteps, runnerStepNames } = deriveReleaseStepIdentities(root, record.tag);
  const authoredSteps = expectedAuthoredSteps.map((expected) => {
    const matches = verifyJob.steps.filter((step) =>
      step?.name === expected.name && step.number === expected.number);
    if (matches.length !== 1) {
      fail(`Failed-superseded release authored step is missing or duplicated: ${expected.name}`);
    }
    const step = matches[0];
    if (!Number.isSafeInteger(step.number) || step.number <= 0) {
      fail(`Failed-superseded release authored step has no valid runner number: ${expected.name}`);
    }
    return Object.freeze({ ...expected, step });
  });
  for (let index = 1; index < authoredSteps.length; index += 1) {
    if (authoredSteps[index - 1].step.number >= authoredSteps[index].step.number) {
      fail("Failed-superseded release authored steps are out of runner order.");
    }
  }
  const hasAuthoredIdentity = (step) => authoredSteps.some(({ name, step: authoredStep }) =>
    step.name === name && step.number === authoredStep.number);
  const runnerCleanupIdentities = deriveRunnerCleanupIdentities(
    verifyJob.steps,
    runnerStepNames,
    authoredSteps,
  );
  const isRunnerCleanupIdentity = (step) => runnerCleanupIdentities.some(({ name, number }) =>
    step.name === name && step.number === number);
  const authoredFailures = authoredSteps.filter(({ step }) =>
    step.status === "completed" && step.conclusion === "failure");
  const unmatchedFailures = verifyJob.steps.filter((step) =>
    step.status === "completed" &&
    step.conclusion === "failure" &&
    !hasAuthoredIdentity(step) &&
    !isRunnerCleanupIdentity(step));
  if (authoredFailures.length + unmatchedFailures.length > 1) {
    fail("Failed-superseded release requires exactly one authored failure.");
  }
  const failedIndex = authoredSteps.findIndex(({ step }) =>
    step.status === "completed" && step.conclusion === "failure");
  if (failedIndex === -1) {
    fail("Failed-superseded release has no failed authored step.");
  }
  for (let index = 0; index < authoredSteps.length; index += 1) {
    const { name, step } = authoredSteps[index];
    const expectedConclusion = index < failedIndex
      ? "success"
      : index === failedIndex
        ? "failure"
        : "skipped";
    if (step.status !== "completed" || step.conclusion !== expectedConclusion) {
      if (index > failedIndex) {
        fail(`Failed-superseded release step was not skipped: ${name}`);
      }
      if (index < failedIndex) {
        fail(`Failed-superseded release authored step succeeded out of order: ${name}`);
      }
      fail(`Failed-superseded release authored step did not fail: ${name}`);
    }
  }
  return Object.freeze({ verifyJobId: verifyJob.id, publishJobId: publishJob.id });
}

export function verifyReleaseProvenance(root, recordInput, authorities = systemAuthorities) {
  const record = decodeRecord(recordInput);
  const gitProvenance = deriveGitProvenance(root, record.version);
  for (const field of ["tag", "tag_object", "commit", "tree"]) {
    if (record[field] !== gitProvenance[field]) {
      fail(`Release record ${field} does not match the annotated tag authority.`);
    }
  }
  const run = authorities.githubRun(root, record.workflow_run_id, record.workflow_run_attempt);
  if (run.id !== record.workflow_run_id ||
      run.run_attempt !== record.workflow_run_attempt ||
      run.head_sha !== record.commit ||
      run.head_branch !== record.tag ||
      run.event !== "push" ||
      run.status !== "completed" ||
      run.conclusion !== record.workflow_conclusion ||
      run.path !== WORKFLOW_PATH) {
    fail("Release record does not match the tag workflow authority.");
  }
  if (record.outcome === "failed-superseded") {
    failedPhaseEvidence(root, record, authorities);
    if (decodePublishedVersions(authorities.publishedVersions(root)).includes(record.version)) {
      fail("Failed-superseded release version exists in the npm registry.");
    }
  } else if (authorities.artifactIntegrity(root, record.version) !== record.artifact_integrity) {
    fail("Release record integrity does not match the npm artifact authority.");
  }
  return record;
}

export function createReleaseRecord(root, input, authorities = systemAuthorities) {
  requireInitialWorkflowAttempt(input.workflowRunAttempt, "Workflow run attempt");
  const provenance = deriveGitProvenance(root, input.version);
  const workflowConclusion = input.workflowConclusion ?? "success";
  const baseRecord = {
    ...provenance,
    workflow_run_id: input.workflowRunId,
    workflow_run_attempt: input.workflowRunAttempt,
    workflow_conclusion: workflowConclusion,
  };
  const jobEvidence = workflowConclusion === "failure"
    ? failedPhaseEvidence(root, baseRecord, authorities, false)
    : { verifyJobId: null, publishJobId: null };
  return verifyReleaseProvenance(root, {
    outcome: workflowConclusion === "failure" ? "failed-superseded" : "published",
    ...baseRecord,
    verify_job_id: jobEvidence.verifyJobId,
    publish_job_id: jobEvidence.publishJobId,
    artifact_integrity: input.artifactIntegrity ?? null,
  }, authorities);
}

export function buildReleaseTransform(baseFiles, oldVersion, newVersion, recordInput) {
  requireStableVersion(oldVersion, "Base version");
  requireStableVersion(newVersion, "Target version");
  if (compareVersions(newVersion, oldVersion) <= 0) {
    fail(`Target version ${newVersion} must be newer than ${oldVersion}.`);
  }
  const record = decodeRecord(recordInput);
  if (record.version !== oldVersion) fail("Release record does not describe the base version.");
  const allowlistRaw = baseFiles.get(ALLOWLIST_PATH);
  if (allowlistRaw === undefined) fail(`Missing ${ALLOWLIST_PATH}.`);
  const versionPins = decodeAllowlist(allowlistRaw);
  const transformed = new Map();
  transformed.set(PACKAGE_PATH, transformPackage(
    requireFile(baseFiles, PACKAGE_PATH), oldVersion, newVersion,
  ));
  transformed.set(LOCK_PATH, transformLock(
    requireFile(baseFiles, LOCK_PATH), oldVersion, newVersion,
  ));
  transformed.set(VERSION_CONSTANT_PATH, transformVersionConstant(
    requireFile(baseFiles, VERSION_CONSTANT_PATH), oldVersion, newVersion,
  ));
  for (const path of versionPins) {
    transformed.set(path, replaceVersionPins(
      requireFile(baseFiles, path), oldVersion, newVersion, path,
    ));
  }
  const records = decodeRecords(requireFile(baseFiles, RECORDS_PATH));
  if (records.some((existing) => existing?.version === oldVersion)) {
    fail(`Release record already exists for ${oldVersion}.`);
  }
  transformed.set(RECORDS_PATH, canonicalJson([...records, record]));
  return transformed;
}

function requireFile(files, path) {
  const raw = files.get(path);
  if (raw === undefined) fail(`Missing release identity file: ${path}`);
  return raw;
}

function transformPaths(allowlistRaw) {
  return [...new Set([
    PACKAGE_PATH,
    LOCK_PATH,
    VERSION_CONSTANT_PATH,
    RECORDS_PATH,
    ...decodeAllowlist(allowlistRaw),
  ])].sort();
}

function verifyIndependentShapes(baseFiles, candidateFiles, oldVersion, newVersion, record) {
  const baseManifest = parseJson(requireFile(baseFiles, PACKAGE_PATH), PACKAGE_PATH);
  const candidateManifest = parseJson(requireFile(candidateFiles, PACKAGE_PATH), PACKAGE_PATH);
  const expectedManifest = structuredClone(baseManifest);
  expectedManifest.version = newVersion;
  if (baseManifest.version !== oldVersion ||
      canonicalJson(candidateManifest) !== canonicalJson(expectedManifest)) {
    fail(`${PACKAGE_PATH} diff is not exactly the package version.`);
  }

  const baseLock = parseJson(requireFile(baseFiles, LOCK_PATH), LOCK_PATH);
  const candidateLock = parseJson(requireFile(candidateFiles, LOCK_PATH), LOCK_PATH);
  const expectedLock = structuredClone(baseLock);
  if (baseLock.version !== oldVersion || baseLock.packages?.[""]?.version !== oldVersion) {
    fail(`${LOCK_PATH} base root identity is invalid.`);
  }
  expectedLock.version = newVersion;
  expectedLock.packages[""].version = newVersion;
  if (canonicalJson(candidateLock) !== canonicalJson(expectedLock)) {
    fail(`${LOCK_PATH} diff is not exactly the two root identity fields.`);
  }

  const baseConstant = requireFile(baseFiles, VERSION_CONSTANT_PATH);
  const candidateConstant = requireFile(candidateFiles, VERSION_CONSTANT_PATH);
  const oldLiteral = `export const SERVER_PACKAGE_VERSION = "${oldVersion}";`;
  const newLiteral = `export const SERVER_PACKAGE_VERSION = "${newVersion}";`;
  if (countLiteral(baseConstant, oldLiteral) !== 1 ||
      candidateConstant !== baseConstant.replace(oldLiteral, newLiteral) ||
      countLiteral(candidateConstant, newLiteral) !== 1) {
    fail(`${VERSION_CONSTANT_PATH} diff is not exactly one version literal.`);
  }

  const allowlistRaw = requireFile(baseFiles, ALLOWLIST_PATH);
  if (requireFile(candidateFiles, ALLOWLIST_PATH) !== allowlistRaw) {
    fail("Release identity allowlist changed.");
  }
  for (const path of decodeAllowlist(allowlistRaw)) {
    const basePin = requireFile(baseFiles, path);
    const candidatePin = requireFile(candidateFiles, path);
    const oldCount = countLiteral(basePin, oldVersion);
    const newCount = countLiteral(candidatePin, newVersion);
    if (oldCount === 0 || newCount < oldCount ||
        countLiteral(candidatePin, oldVersion) !== 0 ||
        candidatePin !== basePin.replaceAll(oldVersion, newVersion)) {
      fail(`Version-pin assertions did not move old-to-new without loss: ${path}`);
    }
  }

  const baseRecords = decodeRecords(requireFile(baseFiles, RECORDS_PATH));
  const expectedRecords = canonicalJson([...baseRecords, record]);
  if (requireFile(candidateFiles, RECORDS_PATH) !== expectedRecords) {
    fail(`${RECORDS_PATH} is not the canonical generated append.`);
  }
}

async function readWorkingFiles(root) {
  const allowlistRaw = await readFile(join(root, ALLOWLIST_PATH), "utf8");
  const paths = transformPaths(allowlistRaw);
  const files = new Map([[ALLOWLIST_PATH, allowlistRaw]]);
  await Promise.all(paths.map(async (path) => {
    files.set(path, await readFile(join(root, path), "utf8"));
  }));
  return files;
}

function readRefFiles(root, ref) {
  const allowlistRaw = gitRaw(root, ["show", `${ref}:${ALLOWLIST_PATH}`]);
  const paths = transformPaths(allowlistRaw);
  const files = new Map([[ALLOWLIST_PATH, allowlistRaw]]);
  for (const path of paths) files.set(path, gitRaw(root, ["show", `${ref}:${path}`]));
  return files;
}

function readVersion(files) {
  const manifest = parseJson(requireFile(files, PACKAGE_PATH), PACKAGE_PATH);
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== "string") {
    fail(`${PACKAGE_PATH} has an invalid package identity.`);
  }
  return requireStableVersion(manifest.version, "Package version");
}

function publishedAnchorForRecord(root, files, version, record, authorities) {
  if (record.outcome === "published") return { record, anchor: record };
  const records = decodeRecords(requireFile(files, RECORDS_PATH))
    .map((candidate) => decodeRecord(candidate))
    .filter((candidate) => candidate.outcome === "published" &&
      compareVersions(candidate.version, version) < 0);
  if (records.length === 0) {
    fail("Failed-superseded release requires an earlier published provenance anchor.");
  }
  const anchor = records.reduce((latest, candidate) =>
    compareVersions(candidate.version, latest.version) > 0 ? candidate : latest,
  );
  const verifiedAnchor = verifyReleaseProvenance(root, anchor, authorities);
  if (verifiedAnchor.outcome !== "published") {
    fail("Failed-superseded release provenance anchor must be published.");
  }
  return { record, anchor: verifiedAnchor };
}

export async function prepareRelease(root, targetVersion, evidence, authorities = systemAuthorities) {
  const clean = git(root, ["status", "--porcelain"]);
  if (clean !== "") fail("release:prepare requires a clean working tree.");
  const baseFiles = await readWorkingFiles(root);
  const oldVersion = readVersion(baseFiles);
  const record = createReleaseRecord(root, {
    version: oldVersion,
    workflowRunId: evidence.workflowRunId,
    workflowRunAttempt: evidence.workflowRunAttempt,
    workflowConclusion: evidence.workflowConclusion,
    artifactIntegrity: evidence.artifactIntegrity,
  }, authorities);
  const { anchor } = publishedAnchorForRecord(root, baseFiles, oldVersion, record, authorities);
  try {
    git(root, ["merge-base", "--is-ancestor", record.commit, "HEAD"]);
  } catch {
    fail("Released commit is not an ancestor of the preparation base.");
  }
  try {
    git(root, ["merge-base", "--is-ancestor", anchor.commit, "HEAD"]);
  } catch {
    fail("Published provenance anchor is not an ancestor of the preparation base.");
  }
  const transformed = buildReleaseTransform(baseFiles, oldVersion, targetVersion, record);
  await Promise.all([...transformed].map(([path, raw]) => writeFile(join(root, path), raw)));
  return Object.freeze({
    oldVersion,
    newVersion: targetVersion,
    record,
    provenanceAnchor: anchor,
    paths: Object.freeze([...transformed.keys()].sort()),
  });
}

function expectedTree(root, base, transformed) {
  const directory = mkdtempSync(join(tmpdir(), "borg-release-index-"));
  const indexPath = join(directory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    git(root, ["read-tree", `${base}^{tree}`], { env });
    for (const [path, raw] of transformed) {
      const blob = git(root, ["hash-object", "-w", "--stdin"], { input: raw });
      let mode = "100644";
      try {
        const line = git(root, ["ls-tree", base, "--", path]);
        if (line !== "") mode = line.slice(0, line.indexOf(" "));
      } catch {
        // New generated records use the ordinary non-executable file mode.
      }
      git(root, ["update-index", "--add", "--cacheinfo", mode, blob, path], { env });
    }
    return git(root, ["write-tree"], { env });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function verifyReleaseIdentity(
  root,
  baseInput,
  candidateInput,
  authorities = systemAuthorities,
) {
  const base = resolveExactCommit(root, baseInput, "Release identity base");
  const candidate = resolveExactCommit(root, candidateInput, "Release identity candidate");
  try {
    git(root, ["merge-base", "--is-ancestor", base, candidate]);
  } catch {
    fail("Release identity base must be an ancestor of the candidate.");
  }
  const baseFiles = readRefFiles(root, base);
  const candidateFiles = readRefFiles(root, candidate);
  const oldVersion = readVersion(baseFiles);
  const newVersion = readVersion(candidateFiles);
  const baseAllowlist = requireFile(baseFiles, ALLOWLIST_PATH);
  if (requireFile(candidateFiles, ALLOWLIST_PATH) !== baseAllowlist) {
    fail("Release identity allowlist changed.");
  }
  const records = decodeRecords(requireFile(candidateFiles, RECORDS_PATH));
  const record = records.at(-1);
  if (record === undefined || record.version !== oldVersion) {
    fail(`Candidate has no generated release record for ${oldVersion}.`);
  }
  const verifiedRecord = verifyReleaseProvenance(root, record, authorities);
  const { anchor } = publishedAnchorForRecord(root, candidateFiles, oldVersion, verifiedRecord, authorities);
  try {
    git(root, ["merge-base", "--is-ancestor", verifiedRecord.commit, base]);
  } catch {
    fail("Recorded release commit is not an ancestor of the release identity base.");
  }
  try {
    git(root, ["merge-base", "--is-ancestor", anchor.commit, base]);
  } catch {
    fail("Published provenance anchor is not an ancestor of the release identity base.");
  }
  verifyIndependentShapes(baseFiles, candidateFiles, oldVersion, newVersion, verifiedRecord);
  const transformed = buildReleaseTransform(baseFiles, oldVersion, newVersion, verifiedRecord);
  for (const [path, expected] of transformed) {
    if (requireFile(candidateFiles, path) !== expected) {
      fail(`Release identity shape mismatch: ${path}`);
    }
  }
  const changed = git(root, ["diff", "--name-only", base, candidate])
    .split("\n")
    .filter(Boolean)
    .sort();
  const expectedPaths = [...transformed.keys()].sort();
  if (JSON.stringify(changed) !== JSON.stringify(expectedPaths)) {
    fail("Release identity changed files outside the generated allowlist.");
  }
  const generatedTree = expectedTree(root, base, transformed);
  const candidateTree = git(root, ["rev-parse", `${candidate}^{tree}`]);
  if (candidateTree !== generatedTree) fail("Candidate tree is not the deterministic release transform.");
  return Object.freeze({
    base,
    candidate,
    tree: candidateTree,
    oldVersion,
    newVersion,
    paths: Object.freeze(expectedPaths),
  });
}

export function classifyReleasePullRequest(
  root,
  input,
  authorities = systemAuthorities,
) {
  if (input.repository !== REPOSITORY ||
      input.headRepository !== REPOSITORY ||
      typeof input.headRef !== "string" ||
      !releaseHeadPattern.test(input.headRef)) {
    fail("Release identity classification requires a same-repository release/* pull request.");
  }
  const base = resolveExactCommit(root, input.base, "Pull request base");
  const candidate = resolveExactCommit(root, input.candidate, "Pull request candidate");
  const trustedHead = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (trustedHead !== base) {
    fail("Trusted classifier checkout does not match the exact pull request base.");
  }
  if (git(root, ["status", "--porcelain"]) !== "") {
    fail("Trusted classifier checkout must be clean.");
  }
  return verifyReleaseIdentity(root, base, candidate, authorities);
}

function parsePrepareArguments(args, environment) {
  const [version, ...flags] = args;
  if (version === undefined) {
    fail("Usage: release:prepare <version> --workflow-run-id <id> --workflow-run-attempt <n> [--workflow-conclusion <success|failure>] [--artifact-integrity <sha512-SRI>]");
  }
  const values = new Map();
  const acceptedFlags = new Set([
    "--workflow-run-id",
    "--workflow-run-attempt",
    "--workflow-conclusion",
    "--artifact-integrity",
  ]);
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!acceptedFlags.has(flag) || value === undefined || values.has(flag)) {
      fail(`Invalid release:prepare flag: ${flag}`);
    }
    values.set(flag, value);
  }
  const runId = values.get("--workflow-run-id") ?? environment.RELEASE_WORKFLOW_RUN_ID;
  const attempt = values.get("--workflow-run-attempt") ?? environment.RELEASE_WORKFLOW_RUN_ATTEMPT;
  const integrity = values.get("--artifact-integrity") ?? environment.RELEASE_ARTIFACT_INTEGRITY;
  const workflowConclusion = values.get("--workflow-conclusion") ??
    environment.RELEASE_WORKFLOW_CONCLUSION ?? "success";
  const workflowRunId = Number(runId);
  const workflowRunAttempt = Number(attempt);
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0 ||
      !Number.isSafeInteger(workflowRunAttempt) || workflowRunAttempt <= 0) {
    fail("release:prepare requires a positive run id and attempt.");
  }
  requireInitialWorkflowAttempt(workflowRunAttempt, "release:prepare workflow run attempt");
  if (workflowConclusion === "success" &&
      (typeof integrity !== "string" || !sriPattern.test(integrity))) {
    fail("A successful superseded release requires a canonical SHA-512 SRI.");
  }
  if (workflowConclusion === "failure" && integrity !== undefined) {
    fail("A failed-superseded release forbids artifact integrity because no artifact was published.");
  }
  if (workflowConclusion !== "success" && workflowConclusion !== "failure") {
    fail("release:prepare workflow conclusion must be success or failure.");
  }
  return {
    version,
    evidence: {
      workflowRunId,
      workflowRunAttempt,
      workflowConclusion,
      ...(integrity === undefined ? {} : { artifactIntegrity: integrity }),
    },
  };
}

function parseNamedArguments(args, acceptedFlags, usage) {
  if (args.length !== acceptedFlags.size * 2) fail(usage);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!acceptedFlags.has(flag) || value === undefined || values.has(flag)) fail(usage);
    values.set(flag, value);
  }
  return values;
}

function parseVerifyArguments(args) {
  const usage = "Usage: verify:release-identity --base <sha> --candidate <sha>";
  const values = parseNamedArguments(args, new Set(["--base", "--candidate"]), usage);
  return {
    base: values.get("--base"),
    candidate: values.get("--candidate"),
  };
}

function parseClassifyArguments(args) {
  const usage = "Usage: release-identity.mjs classify --base <sha> --candidate <sha> --repository <owner/repo> --head-repository <owner/repo> --head-ref <release/name>";
  const values = parseNamedArguments(args, new Set([
    "--base",
    "--candidate",
    "--repository",
    "--head-repository",
    "--head-ref",
  ]), usage);
  return {
    base: values.get("--base"),
    candidate: values.get("--candidate"),
    repository: values.get("--repository"),
    headRepository: values.get("--head-repository"),
    headRef: values.get("--head-ref"),
  };
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (operation === "prepare") {
    const parsed = parsePrepareArguments(args, process.env);
    console.log(JSON.stringify(await prepareRelease(root, parsed.version, parsed.evidence), null, 2));
    return;
  }
  if (operation === "verify") {
    const parsed = parseVerifyArguments(args);
    console.log(JSON.stringify(
      verifyReleaseIdentity(root, parsed.base, parsed.candidate),
      null,
      2,
    ));
    return;
  }
  if (operation === "classify") {
    console.log(JSON.stringify(classifyReleasePullRequest(
      root,
      parseClassifyArguments(args),
    ), null, 2));
    return;
  }
  fail("Usage: release-identity.mjs <prepare|verify|classify> ...");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
