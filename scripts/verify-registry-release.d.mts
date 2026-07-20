export interface ReleaseArtifactReport {
  name: string;
  version: string;
  integrity: string;
  [key: string]: unknown;
}

export interface PropagationResponse {
  status: number;
}

export interface PropagationRetryOptions {
  attempts?: number;
  maxDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface RegistryAssuranceOptions extends PropagationRetryOptions {
  expectedVersion?: string;
  expectedOwner?: string;
  request?: (path: string) => Promise<Response>;
}

export function verifyArtifactReport(
  report: ReleaseArtifactReport,
  expectedVersion: string,
): ReleaseArtifactReport;

export function verifyOwner(packument: unknown, expectedOwner?: string): void;

export function verifyPrepublish(
  report: ReleaseArtifactReport,
  options?: RegistryAssuranceOptions,
): Promise<{
  name: string;
  version: string;
  registryState: "owned";
}>;

export function readWithPropagationRetry<T extends PropagationResponse>(
  read: () => Promise<T>,
  description: string,
  options?: PropagationRetryOptions,
): Promise<T>;

export function verifyPostpublish(
  report: ReleaseArtifactReport,
  options?: RegistryAssuranceOptions,
): Promise<{
  name: string;
  version: string;
  integrity: string;
  registryState: "verified";
}>;
