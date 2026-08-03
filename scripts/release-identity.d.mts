export interface ReleaseEvidence {
  readonly workflowRunId: number;
  readonly workflowRunAttempt: number;
  readonly workflowConclusion?: "success" | "failure";
  readonly artifactIntegrity?: string;
}

export interface ReleaseRecord {
  readonly outcome: "published" | "failed-superseded";
  readonly version: string;
  readonly tag: string;
  readonly tag_object: string;
  readonly commit: string;
  readonly tree: string;
  readonly workflow_run_id: number;
  readonly workflow_run_attempt: number;
  readonly workflow_conclusion: "success" | "failure";
  readonly verify_job_id: number | null;
  readonly publish_job_id: number | null;
  readonly artifact_integrity: string | null;
}

export interface ReleaseAuthorities {
  readonly githubRun: (
    root: string,
    runId: number,
    attempt: number,
  ) => Record<string, unknown>;
  readonly githubRunJobs: (
    root: string,
    runId: number,
    attempt: number,
  ) => Record<string, unknown>;
  readonly artifactIntegrity: (root: string, version: string) => unknown;
  readonly publishedVersions: (root: string) => unknown;
}

export function deriveGitProvenance(root: string, version: string): Readonly<{
  version: string;
  tag: string;
  tag_object: string;
  commit: string;
  tree: string;
}>;

export function createReleaseRecord(
  root: string,
  input: Readonly<{
    version: string;
    workflowRunId: number;
    workflowRunAttempt: number;
    workflowConclusion?: "success" | "failure";
    artifactIntegrity?: string;
  }>,
  authorities?: ReleaseAuthorities,
): ReleaseRecord;

export function verifyReleaseProvenance(
  root: string,
  record: ReleaseRecord,
  authorities?: ReleaseAuthorities,
): ReleaseRecord;

export function buildReleaseTransform(
  baseFiles: ReadonlyMap<string, string>,
  oldVersion: string,
  newVersion: string,
  record: ReleaseRecord,
): Map<string, string>;

export function prepareRelease(
  root: string,
  targetVersion: string,
  evidence: ReleaseEvidence,
  authorities?: ReleaseAuthorities,
): Promise<Readonly<{
  oldVersion: string;
  newVersion: string;
  provenanceAnchor: ReleaseRecord;
  record: ReleaseRecord;
  paths: readonly string[];
}>>;

export function verifyReleaseIdentity(
  root: string,
  base: string,
  candidate: string,
  authorities?: ReleaseAuthorities,
): Readonly<{
  base: string;
  candidate: string;
  tree: string;
  oldVersion: string;
  newVersion: string;
  paths: readonly string[];
}>;

export function classifyReleasePullRequest(
  root: string,
  input: Readonly<{
    base: string;
    candidate: string;
    repository: string;
    headRepository: string;
    headRef: string;
  }>,
  authorities?: ReleaseAuthorities,
): ReturnType<typeof verifyReleaseIdentity>;
