import { PROTOCOL_VERSION } from "borgmcp-shared/protocol";
import { lstat, readFile } from "node:fs/promises";

export const SERVER_PACKAGE_VERSION = "0.1.14";
export const RUNTIME_INFO_PATH = "/api/runtime";

export interface RuntimeBuildIdentity {
  readonly package_version: string;
  readonly source_sha: string | null;
  readonly artifact_integrity: string | null;
  readonly protocol_version: string;
  readonly started_at: string;
}

export interface RuntimeBuildIdentityInput {
  readonly sourceSha?: string;
  readonly artifactIntegrity?: string;
  readonly startedAt?: Date;
}

export interface LoadRuntimeBuildIdentityInput extends RuntimeBuildIdentityInput {
  readonly artifactDescriptorPath?: string;
}

const sourceShaPattern = /^[0-9a-f]{40}$/u;
const artifactIntegrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;

export function createRuntimeBuildIdentity(
  input: RuntimeBuildIdentityInput = {},
): RuntimeBuildIdentity {
  const sourceSha = input.sourceSha;
  const artifactIntegrity = input.artifactIntegrity;
  if (sourceSha !== undefined && !sourceShaPattern.test(sourceSha)) {
    throw new Error("Server source identity is invalid.");
  }
  if (artifactIntegrity !== undefined && !artifactIntegrityPattern.test(artifactIntegrity)) {
    throw new Error("Server artifact identity is invalid.");
  }
  const startedAt = input.startedAt ?? new Date();
  if (!Number.isFinite(startedAt.getTime())) throw new Error("Server start time is invalid.");
  return Object.freeze({
    package_version: SERVER_PACKAGE_VERSION,
    source_sha: sourceSha ?? null,
    artifact_integrity: artifactIntegrity ?? null,
    protocol_version: PROTOCOL_VERSION,
    started_at: startedAt.toISOString(),
  });
}

export async function loadRuntimeBuildIdentity(
  input: LoadRuntimeBuildIdentityInput = {},
): Promise<RuntimeBuildIdentity> {
  if (input.artifactDescriptorPath === undefined) return createRuntimeBuildIdentity(input);
  let descriptor: { version?: unknown; integrity?: unknown; source_sha?: unknown };
  try {
    const metadata = await lstat(input.artifactDescriptorPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024) {
      throw new Error("invalid descriptor");
    }
    descriptor = JSON.parse(await readFile(input.artifactDescriptorPath, "utf8")) as typeof descriptor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createRuntimeBuildIdentity(input);
    throw new Error("Runtime artifact descriptor is invalid.");
  }
  if (descriptor.version !== SERVER_PACKAGE_VERSION ||
      typeof descriptor.integrity !== "string" || !artifactIntegrityPattern.test(descriptor.integrity) ||
      (descriptor.source_sha !== null &&
        (typeof descriptor.source_sha !== "string" || !sourceShaPattern.test(descriptor.source_sha)))) {
    throw new Error("Runtime artifact descriptor is invalid.");
  }
  if (input.artifactIntegrity !== undefined && input.artifactIntegrity !== descriptor.integrity) {
    throw new Error("Runtime artifact identity conflicts with the activated artifact.");
  }
  if (input.sourceSha !== undefined && input.sourceSha !== descriptor.source_sha) {
    throw new Error("Runtime source identity conflicts with the activated artifact.");
  }
  return createRuntimeBuildIdentity({
    artifactIntegrity: descriptor.integrity,
    ...(descriptor.source_sha === null ? {} : { sourceSha: descriptor.source_sha }),
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
  });
}
