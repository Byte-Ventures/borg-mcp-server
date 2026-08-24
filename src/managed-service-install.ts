import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ManagedServiceDefinition } from "./managed-service.js";
import type { RuntimeBuildIdentity } from "./runtime-identity.js";
import type { VerifiedRuntimeArtifact } from "./runtime-lifecycle.js";
import { operatorErrors } from "./operator-error.js";

export interface ManagedServiceRuntimeState {
  readonly running: boolean;
  readonly mode?: "foreground" | "managed";
  readonly identity?: RuntimeBuildIdentity | null;
  readonly stale?: boolean;
}

export interface ManagedServiceProbeState {
  readonly state: "active" | "inactive" | "absent";
  readonly recoveryCommand: readonly [string, ...string[]] | null;
}

export interface ManagedServiceInstallInput {
  readonly definition: ManagedServiceDefinition;
  readonly artifact: VerifiedRuntimeArtifact;
  readonly dataDirectory: string;
  readonly assertInstallation: () => Promise<void>;
  readonly inspectRuntime: () => Promise<ManagedServiceRuntimeState>;
  readonly inspectService: () => Promise<ManagedServiceProbeState>;
  readonly run: (
    command: readonly [string, ...string[]],
    signal: AbortSignal,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly probe: (signal: AbortSignal) => Promise<RuntimeBuildIdentity>;
  readonly timeoutMs: number;
  readonly uid?: number;
}

export interface ManagedServiceInstallResult {
  readonly outcome: "installed" | "already-installed";
  readonly adapter: "launchd" | "systemd";
  readonly artifact: VerifiedRuntimeArtifact;
  readonly runningIdentity: RuntimeBuildIdentity;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export class ManagedServiceInstallError extends Error {
  readonly recovery: "restored" | "stopped" | "failed";

  constructor(recovery: "restored" | "stopped" | "failed") {
    super("Managed service installation did not complete.");
    this.name = "ManagedServiceInstallError";
    this.recovery = recovery;
  }
}

export type ManagedServiceDefinitionState =
  | { readonly kind: "absent" }
  | {
      readonly kind: "current" | "stale";
      readonly content: string;
      readonly device: number;
      readonly inode: number;
    };

export async function installManagedService(
  input: ManagedServiceInstallInput,
): Promise<ManagedServiceInstallResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 300_000) {
    throw new Error("Managed service install timeout is invalid.");
  }
  await input.assertInstallation();
  const installLock = await acquireManagedServiceLock(input.dataDirectory);
  try {
    const [definitionState, runtime, service] = await Promise.all([
      inspectManagedServiceDefinition(input.definition, input.uid),
      input.inspectRuntime(),
      input.inspectService(),
      assertExistingPrivateSink(input.definition.stdoutPath, input.uid),
      assertExistingPrivateSink(input.definition.stderrPath, input.uid),
    ]);
    if (runtime.stale === true) throw operatorErrors.RUNTIME_LOCK_STALE;
    if (runtime.running && runtime.mode !== "managed") {
      throw operatorErrors.MANAGED_SERVICE_FOREGROUND_ACTIVE;
    }
    if (service.state === "active" && definitionState.kind === "absent") {
      throw operatorErrors.MANAGED_SERVICE_DEFINITION_FOREIGN;
    }
    if (runtime.running && runtime.identity === null) throw operatorErrors.RUNTIME_LOCK_INVALID;
    if (runtime.running && service.state !== "active") throw operatorErrors.RUNTIME_LOCK_LIVE_UNRECOGNIZED;
    if (runtime.running && definitionState.kind === "current" &&
        runtime.identity !== undefined && runtime.identity !== null &&
        runtimeMatchesArtifact(runtime.identity, input.artifact)) {
      await ensurePrivateSink(input.definition.stdoutPath, input.uid);
      await ensurePrivateSink(input.definition.stderrPath, input.uid);
      return result("already-installed", input, runtime.identity);
    }

    const previousActive = service.state === "active";
    const previousIdentity = previousActive && runtime.running
      ? runtime.identity ?? null
      : null;
    const previousContent = definitionState.kind === "absent" ? null : definitionState.content;
    const mustUnload = previousActive || (definitionState.kind === "stale" &&
      service.recoveryCommand === input.definition.recoverLoaded);
    let mutationStarted = false;
    try {
      if (mustUnload) {
        mutationStarted = true;
        await runManagedServiceWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.unload, signal));
        await waitForStopped(input, input.timeoutMs);
      }
      await ensurePrivateSink(input.definition.stdoutPath, input.uid);
      await ensurePrivateSink(input.definition.stderrPath, input.uid);
      if (definitionState.kind !== "current") {
        mutationStarted = true;
        await writeManagedServicePrivateFile(
          input.definition.definitionPath,
          input.definition.content,
          input.uid,
          previousContent,
        );
      }
      if (input.definition.reload !== null) {
        mutationStarted = true;
        await runManagedServiceWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.reload!, signal));
      }
      mutationStarted = true;
      const startCommand = input.definition.platform === "launchd" &&
          definitionState.kind === "current" && service.state === "inactive" &&
          service.recoveryCommand !== null
        ? service.recoveryCommand
        : input.definition.install;
      await runManagedServiceWithDeadline(input.timeoutMs, (signal) => input.run(startCommand, signal));
      const identity = await runManagedServiceWithDeadline(input.timeoutMs, input.probe);
      if (!runtimeMatchesArtifact(identity, input.artifact)) {
        throw new Error("Managed service started an unexpected runtime artifact.");
      }
      return result("installed", input, identity);
    } catch {
      if (!mutationStarted) throw new ManagedServiceInstallError("stopped");
      throw new ManagedServiceInstallError(await rollback(
        input,
        previousContent,
        previousActive,
        previousIdentity,
      ));
    }
  } finally {
    await installLock.release();
  }
}

async function rollback(
  input: ManagedServiceInstallInput,
  previousContent: string | null,
  previousActive: boolean,
  previousIdentity: RuntimeBuildIdentity | null,
): Promise<"restored" | "stopped" | "failed"> {
  try {
    await runManagedServiceWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.rollbackRemove, signal))
      .catch(() => undefined);
    await waitForStopped(input, input.timeoutMs);
    if (previousContent === null) {
      await removeCurrentDefinition(input.definition);
    } else {
      await writeManagedServicePrivateFile(
        input.definition.definitionPath,
        previousContent,
        input.uid,
        input.definition.content,
      );
    }
    if (input.definition.reload !== null) {
      await runManagedServiceWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.reload!, signal));
    }
    if (!previousActive) return "stopped";
    await runManagedServiceWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.install, signal));
    const restoredIdentity = await runManagedServiceWithDeadline(input.timeoutMs, input.probe);
    if (previousIdentity === null || !managedRuntimeIdentitiesMatch(restoredIdentity, previousIdentity)) {
      return "failed";
    }
    return "restored";
  } catch {
    return "failed";
  }
}

export async function inspectManagedServiceDefinition(
  definition: ManagedServiceDefinition,
  uid = process.getuid?.(),
): Promise<ManagedServiceDefinitionState> {
  try {
    const metadata = await lstat(definition.definitionPath);
    await assertCanonicalDirectory(dirname(definition.definitionPath), uid);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
        metadata.size > 64 * 1024 || (uid !== undefined && metadata.uid !== uid) ||
        (metadata.mode & 0o077) !== 0) {
      throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
    }
    const content = await readFile(definition.definitionPath, "utf8");
    const identity = { device: metadata.dev, inode: metadata.ino };
    if (content === definition.content) return { kind: "current", content, ...identity };
    if (hasCanonicalOwnershipMarker(definition, content)) return { kind: "stale", content, ...identity };
    throw operatorErrors.MANAGED_SERVICE_DEFINITION_FOREIGN;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

function hasCanonicalOwnershipMarker(
  definition: ManagedServiceDefinition,
  content: string,
): boolean {
  return definition.platform === "launchd"
    ? content.startsWith(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${definition.ownershipMarker} -->\n` +
      "<!DOCTYPE plist PUBLIC",
    )
    : content.startsWith(`# ${definition.ownershipMarker}\n[Unit]\n`);
}

async function ensurePrivateSink(path: string, uid = process.getuid?.()): Promise<void> {
  await ensurePrivateDirectory(dirname(path), uid);
  try {
    const metadata = await lstat(path);
    if (!privateSinkMetadata(metadata, uid)) {
      throw operatorErrors.MANAGED_SERVICE_LOG_UNSAFE;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
}

async function assertExistingPrivateSink(path: string, uid = process.getuid?.()): Promise<void> {
  try {
    if (!privateSinkMetadata(await lstat(path), uid)) {
      throw operatorErrors.MANAGED_SERVICE_LOG_UNSAFE;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function privateSinkMetadata(
  metadata: Stats,
  uid: number | undefined,
): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 &&
    (metadata.mode & 0o077) === 0 && (uid === undefined || metadata.uid === uid);
}

export async function writeManagedServicePrivateFile(
  path: string,
  content: string,
  uid = process.getuid?.(),
  expectedCurrent?: string | null,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path), uid);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (expectedCurrent !== undefined) {
      let current: string | null;
      try {
        current = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        current = null;
      }
      if (current !== expectedCurrent) {
        throw new Error("Managed service definition changed during installation.");
      }
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removeManagedServiceDefinition(
  definition: ManagedServiceDefinition,
  expected: Exclude<ManagedServiceDefinitionState, { readonly kind: "absent" }>,
  uid = process.getuid?.(),
): Promise<void> {
  const current = await inspectManagedServiceDefinition(definition, uid);
  if (current.kind === "absent" || current.content !== expected.content ||
      current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error("Managed service definition changed during removal.");
  }
  await unlink(definition.definitionPath);
}

async function ensurePrivateDirectory(path: string, uid = process.getuid?.()): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertCanonicalDirectory(path, uid);
  await chmod(path, 0o700);
}

async function assertCanonicalDirectory(path: string, uid = process.getuid?.()): Promise<void> {
  const metadata = await lstat(path);
  if (await realpath(path) !== resolve(path) || !metadata.isDirectory() || metadata.isSymbolicLink() ||
      (uid !== undefined && metadata.uid !== uid)) {
    throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
  }
}

async function removeCurrentDefinition(definition: ManagedServiceDefinition): Promise<void> {
  try {
    const content = await readFile(definition.definitionPath, "utf8");
    if (content !== definition.content) throw new Error("Managed service definition changed during rollback.");
    await unlink(definition.definitionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function waitForStopped(input: ManagedServiceInstallInput, timeoutMs: number): Promise<void> {
  await runManagedServiceWithDeadline(timeoutMs, async (signal) => {
    while (!signal.aborted) {
      if (!(await input.inspectRuntime()).running) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    throw new Error("Managed runtime stop timed out.");
  });
}

export async function acquireManagedServiceLock(
  directory: string,
  busyError: Error = operatorErrors.MANAGED_SERVICE_INSTALL_BUSY,
): Promise<{ readonly release: () => Promise<void> }> {
  const path = join(directory, "service-install.lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw busyError;
    }
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return {
    release: async () => {
      await handle.close();
      await unlink(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    },
  };
}

export async function runManagedServiceWithDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function runtimeMatchesArtifact(identity: RuntimeBuildIdentity, artifact: VerifiedRuntimeArtifact): boolean {
  return identity.package_version === artifact.version &&
    identity.artifact_integrity === artifact.integrity &&
    identity.source_sha === artifact.sourceSha;
}

export function managedRuntimeIdentitiesMatch(
  left: RuntimeBuildIdentity,
  right: RuntimeBuildIdentity,
): boolean {
  return left.package_version === right.package_version &&
    left.artifact_integrity === right.artifact_integrity &&
    left.source_sha === right.source_sha;
}

function result(
  outcome: ManagedServiceInstallResult["outcome"],
  input: ManagedServiceInstallInput,
  runningIdentity: RuntimeBuildIdentity,
): ManagedServiceInstallResult {
  return Object.freeze({
    outcome,
    adapter: input.definition.platform,
    artifact: input.artifact,
    runningIdentity,
    stdoutPath: input.definition.stdoutPath,
    stderrPath: input.definition.stderrPath,
  });
}
