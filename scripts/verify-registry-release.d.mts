export interface PropagationResponse {
  status: number;
}

export interface PropagationRetryOptions {
  attempts?: number;
  maxDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export function readWithPropagationRetry<T extends PropagationResponse>(
  read: () => Promise<T>,
  description: string,
  options?: PropagationRetryOptions,
): Promise<T>;

export function postpublish(
  name: string,
  version: string,
  integrity: string,
  retryOptions?: PropagationRetryOptions,
): Promise<{
  name: string;
  version: string;
  integrity: string;
  registryState: "verified";
}>;

export function verifyProvenanceStatement(
  statement: unknown,
  payloadType: string,
  name: string,
  version: string,
  integrity: string,
  commit: string,
): void;
