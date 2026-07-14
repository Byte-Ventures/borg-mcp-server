export interface VerifyLockfileOptions {
  readonly lockName?: string;
  readonly rootFields?: readonly string[];
  readonly dependencyFields?: readonly string[];
  readonly rejectInstallScripts?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export function isExactVersion(value: unknown): value is string;
export function verifyLockfile(
  manifest: Record<string, unknown>,
  lockfile: Record<string, unknown>,
  options?: VerifyLockfileOptions,
): Promise<void>;
