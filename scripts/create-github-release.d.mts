export interface GithubReleaseAuthorities {
  readonly git: (root: string, args: string[], raw?: boolean) => string;
  readonly registryPackage: (name: string, version: string) => Promise<unknown>;
  readonly request: (url: string, options: RequestInit) => Promise<Response>;
}

export function assembleReleaseBody(input: Readonly<{
  version: string;
  integrity: string;
  tag: string;
  commit: string;
  releaseNotes: string;
}>): string;

export function createGithubRelease(version: string, options?: Readonly<{
  root?: string;
  token?: string;
  authorities?: GithubReleaseAuthorities;
}>): Promise<unknown>;
