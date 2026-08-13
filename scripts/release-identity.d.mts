export function prepareRelease(root: string, targetVersion: string): Promise<Readonly<{
  oldVersion: string;
  newVersion: string;
  paths: readonly string[];
}>>;

export function verifyReleaseIdentity(root: string, base: string, candidate: string): Readonly<{
  base: string;
  candidate: string;
  oldVersion: string;
  newVersion: string;
}>;

export function classifyReleasePullRequest(root: string, input: Readonly<{
  base: string;
  candidate: string;
  repository: string;
  headRepository: string;
  headRef: string;
}>): ReturnType<typeof verifyReleaseIdentity>;
