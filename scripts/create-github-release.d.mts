export interface ReleasePullRequest {
  readonly number: number;
  readonly state: string;
  readonly merged_at: string | null;
  readonly base: { readonly ref: string };
  readonly head: { readonly ref: string };
  readonly merge_commit_sha: string;
  readonly html_url: string;
  readonly body: string;
}

export interface GithubReleaseAuthorities {
  readonly git: (root: string, args: string[]) => string;
  readonly githubApi: (root: string, endpoint: string) => unknown;
  readonly artifactReport: (root: string, runId: number, version: string) => Promise<unknown>;
  readonly verifyPostpublish: (report: unknown, options: { expectedVersion: string }) => Promise<{
    name: string;
    version: string;
    integrity: string;
    registryState: string;
  }>;
  readonly request: (url: string, options: RequestInit) => Promise<Response>;
}

export function assertReleasePullRequest(
  pullRequests: readonly ReleasePullRequest[],
  version: string,
  commit: string,
  mergeSubject: string,
): ReleasePullRequest;

export function assembleReleaseBody(input: Readonly<{
  packageName: string;
  version: string;
  integrity: string;
  tag: string;
  commit: string;
  pullRequest: ReleasePullRequest;
}>): string;

export function createGithubRelease(version: string, options?: Readonly<{
  root?: string;
  token?: string;
  authorities?: GithubReleaseAuthorities;
}>): Promise<unknown>;
