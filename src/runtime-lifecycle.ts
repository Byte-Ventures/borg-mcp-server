import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RuntimeBuildIdentity } from "./runtime-identity.js";

const exactVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const sourceSha = /^[0-9a-f]{40}$/u;

export interface VerifiedRuntimeArtifact {
  readonly artifactDirectory: string;
  readonly packageDirectory: string;
  readonly version: string;
  readonly integrity: string;
  readonly sourceSha: string | null;
  readonly treeSha256: string;
}

export interface RuntimeLifecycleDependencies {
  readonly unpack: (
    tarballPath: string,
    stagingDirectory: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly restart: (signal: AbortSignal) => Promise<void>;
  readonly stop: (signal: AbortSignal) => Promise<void>;
  readonly probe: (signal: AbortSignal) => Promise<RuntimeBuildIdentity>;
}

export interface StageRuntimeArtifactInput {
  readonly runtimeRoot: string;
  readonly tarballPath: string;
  readonly expectedIntegrity: string;
  readonly expectedVersion: string;
  readonly sourceSha?: string;
  readonly timeoutMs: number;
}

export interface ActivateRuntimeArtifactInput {
  readonly runtimeRoot: string;
  readonly artifact: VerifiedRuntimeArtifact;
  readonly timeoutMs: number;
}

export interface RuntimeLifecycle {
  readonly stage: (input: StageRuntimeArtifactInput) => Promise<VerifiedRuntimeArtifact>;
  readonly prepare: (input: Omit<ActivateRuntimeArtifactInput, "timeoutMs">) => Promise<VerifiedRuntimeArtifact>;
  readonly activate: (input: ActivateRuntimeArtifactInput) => Promise<RuntimeBuildIdentity>;
}

export type RuntimeRecoveryState = "restored" | "stopped" | "failed";

export class RuntimeActivationError extends Error {
  readonly recovery: RuntimeRecoveryState;

  constructor(recovery: RuntimeRecoveryState) {
    super("Runtime activation did not complete.");
    this.name = "RuntimeActivationError";
    this.recovery = recovery;
  }
}

export function createRuntimeLifecycle(
  dependencies: RuntimeLifecycleDependencies,
): RuntimeLifecycle {
  return {
    stage: (input) => stageRuntimeArtifact(input, dependencies.unpack),
    prepare: async (input) => {
      const root = await prepareRuntimeRoot(input.runtimeRoot);
      const artifact = await revalidateArtifact(root, input.artifact);
      await switchCurrent(root, artifact.artifactDirectory);
      return artifact;
    },
    activate: (input) => activateRuntimeArtifact(input, dependencies),
  };
}

export async function inspectActiveRuntimeArtifact(
  runtimeRoot: string,
): Promise<VerifiedRuntimeArtifact | null> {
  if (!isAbsolute(runtimeRoot)) throw new Error("Runtime root must be absolute.");
  let root: string;
  try {
    root = await realpath(runtimeRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const target = await readCurrentTarget(join(root, "current"), root);
  return target === null ? null : readArtifactDescriptor(target);
}

async function stageRuntimeArtifact(
  input: StageRuntimeArtifactInput,
  unpack: RuntimeLifecycleDependencies["unpack"],
): Promise<VerifiedRuntimeArtifact> {
  validateStageInput(input);
  const root = await prepareRuntimeRoot(input.runtimeRoot);
  const archive = await readRegularFile(input.tarballPath, 2 * 1024 * 1024);
  const actualIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (actualIntegrity !== input.expectedIntegrity) throw new Error("Runtime artifact integrity does not match.");
  const artifactId = createHash("sha256").update(archive).digest("hex");
  const artifactsDirectory = join(root, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  const target = join(artifactsDirectory, artifactId);
  const existing = await existingArtifact(target, input);
  if (existing !== null) return existing;
  const staging = await mkdtemp(join(root, ".staging-"));
  try {
    await withDeadline(input.timeoutMs, (signal) => unpack(input.tarballPath, staging, signal));
    const packageDirectory = await validateUnpackedPackage(staging, input.expectedVersion);
    await makeTreeReadOnly(packageDirectory);
    const treeSha256 = await hashArtifactTree(packageDirectory);
    const manifest = Object.freeze({
      version: input.expectedVersion,
      integrity: input.expectedIntegrity,
      source_sha: input.sourceSha ?? null,
      tree_sha256: treeSha256,
    });
    await writeFile(join(staging, "artifact.json"), `${JSON.stringify(manifest)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(join(staging, "artifact.json"), 0o400);
    await rename(staging, target);
    await chmod(target, 0o500);
    return Object.freeze({
      artifactDirectory: target,
      packageDirectory: join(target, basename(packageDirectory)),
      version: input.expectedVersion,
      integrity: input.expectedIntegrity,
      sourceSha: input.sourceSha ?? null,
      treeSha256,
    });
  } catch (error) {
    await removeOwnedStaging(staging);
    throw error;
  }
}

async function activateRuntimeArtifact(
  input: ActivateRuntimeArtifactInput,
  dependencies: RuntimeLifecycleDependencies,
): Promise<RuntimeBuildIdentity> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120_000) {
    throw new Error("Runtime lifecycle timeout is invalid.");
  }
  const root = await prepareRuntimeRoot(input.runtimeRoot);
  const artifact = await revalidateArtifact(root, input.artifact);
  const current = join(root, "current");
  const previousTarget = await readCurrentTarget(current, root);
  await switchCurrent(root, artifact.artifactDirectory);
  try {
    await withDeadline(input.timeoutMs, dependencies.restart);
    const identity = await withDeadline(input.timeoutMs, dependencies.probe);
    assertIdentity(identity, artifact);
    return identity;
  } catch (activationError) {
    if (previousTarget === null) {
      await rm(current, { force: true });
      try {
        await withDeadline(input.timeoutMs, dependencies.stop);
      } catch {
        throw new RuntimeActivationError("failed");
      }
      throw new RuntimeActivationError("stopped");
    }
    await switchCurrent(root, previousTarget);
    try {
      await withDeadline(input.timeoutMs, dependencies.restart);
      const restored = await withDeadline(input.timeoutMs, dependencies.probe);
      const previous = await readArtifactDescriptor(previousTarget);
      assertIdentity(restored, previous);
    } catch {
      throw new RuntimeActivationError("failed");
    }
    throw new RuntimeActivationError("restored");
  }
}

function validateStageInput(input: StageRuntimeArtifactInput): void {
  if (!exactVersion.test(input.expectedVersion)) throw new Error("Runtime artifact version is invalid.");
  if (!sha512Integrity.test(input.expectedIntegrity)) throw new Error("Runtime artifact integrity is invalid.");
  if (input.sourceSha !== undefined && !sourceSha.test(input.sourceSha)) {
    throw new Error("Runtime artifact source identity is invalid.");
  }
  if (!isAbsolute(input.runtimeRoot) || !isAbsolute(input.tarballPath)) {
    throw new Error("Runtime lifecycle paths must be absolute.");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 300_000) {
    throw new Error("Runtime staging timeout is invalid.");
  }
}

export interface RuntimeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RuntimeCommandRunner {
  (
    executable: string,
    args: readonly string[],
    options: { readonly cwd?: string; readonly signal: AbortSignal },
  ): Promise<RuntimeCommandResult>;
}

export function createUnixNpmArtifactUnpacker(options: {
  readonly tarExecutable?: string;
  readonly npmExecutable?: string;
  readonly run?: RuntimeCommandRunner;
} = {}): RuntimeLifecycleDependencies["unpack"] {
  const tarExecutable = options.tarExecutable ?? "tar";
  const npmExecutable = options.npmExecutable ?? "npm";
  const run = options.run ?? runRuntimeCommand;
  return async (tarballPath, stagingDirectory, signal) => {
    const listing = await run(tarExecutable, ["-tzf", tarballPath], { signal });
    const entries = listing.stdout.trim().split("\n").filter(Boolean);
    if (entries.length === 0 || entries.length > 544 || entries.some((entry) => {
      const segments = entry.split("/");
      return !entry.startsWith("package/") || entry.startsWith("/") || entry.includes("\\") ||
        segments.includes("..") || segments.includes(".") || entry.length > 512;
    })) {
      throw new Error("Runtime artifact archive entries are invalid.");
    }
    await run(tarExecutable, ["-xzf", tarballPath, "-C", stagingDirectory], { signal });
    await hashArtifactTree(join(stagingDirectory, "package"));
    await run(npmExecutable, [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ], { cwd: join(stagingDirectory, "package"), signal });
  };
}

async function runRuntimeCommand(
  executable: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly signal: AbortSignal },
): Promise<RuntimeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const abort = (): void => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 500);
      killTimer.unref();
    };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      options.signal.removeEventListener("abort", abort);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        kill("SIGKILL");
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Runtime artifact command output exceeded its bound."));
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        reject(new Error(`Runtime artifact command failed (${code ?? signal ?? "unknown"}).`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function prepareRuntimeRoot(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error("Runtime root must be absolute.");
  try {
    const existing = await lstat(value);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("Runtime root must be a private directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(value, { recursive: true, mode: 0o700 });
  }
  const root = await realpath(value);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Runtime root must be a private directory.");
  }
  return root;
}

async function readRegularFile(path: string, limit: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit) {
    throw new Error("Runtime artifact must be a bounded regular file.");
  }
  return readFile(path);
}

async function validateUnpackedPackage(staging: string, version: string): Promise<string> {
  const packageDirectory = join(staging, "package");
  const canonical = await realpath(packageDirectory);
  if (dirname(canonical) !== staging) throw new Error("Runtime artifact package escaped staging.");
  const manifest = JSON.parse((await readRegularFile(join(canonical, "package.json"), 64 * 1024))
    .toString("utf8")) as {
    name?: unknown;
    version?: unknown;
    bin?: unknown;
  };
  if (manifest.name !== "borgmcp-server" || manifest.version !== version ||
      JSON.stringify(manifest.bin) !== JSON.stringify({ "borg-mcp-server": "./dist/main.js" })) {
    throw new Error("Runtime artifact package identity does not match.");
  }
  const entrypoint = await realpath(join(canonical, "dist", "main.js"));
  if (!inside(canonical, entrypoint) || !(await lstat(entrypoint)).isFile()) {
    throw new Error("Runtime artifact entrypoint is invalid.");
  }
  return canonical;
}

async function makeTreeReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("Runtime artifact contains a symbolic link.");
    if (metadata.isDirectory()) {
      await makeTreeReadOnly(path);
      await chmod(path, 0o500);
    } else if (metadata.isFile()) await chmod(path, 0o400);
    else throw new Error("Runtime artifact contains an unsupported file.");
  }
  await chmod(directory, 0o500);
}

async function existingArtifact(
  target: string,
  input: StageRuntimeArtifactInput,
): Promise<VerifiedRuntimeArtifact | null> {
  try {
    const artifact = await readArtifactDescriptor(target);
    if (artifact.version !== input.expectedVersion || artifact.integrity !== input.expectedIntegrity ||
        artifact.sourceSha !== (input.sourceSha ?? null)) {
      throw new Error("Existing runtime artifact descriptor does not match.");
    }
    await validateUnpackedPackage(target, input.expectedVersion);
    return artifact;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readArtifactDescriptor(directory: string): Promise<VerifiedRuntimeArtifact> {
  const canonical = await realpath(directory);
  const value = JSON.parse((await readRegularFile(join(canonical, "artifact.json"), 4 * 1024))
    .toString("utf8")) as {
    version?: unknown;
    integrity?: unknown;
    source_sha?: unknown;
    tree_sha256?: unknown;
  };
  if (typeof value.version !== "string" || !exactVersion.test(value.version) ||
      typeof value.integrity !== "string" || !sha512Integrity.test(value.integrity) ||
      (value.source_sha !== null &&
        (typeof value.source_sha !== "string" || !sourceSha.test(value.source_sha))) ||
      typeof value.tree_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.tree_sha256)) {
    throw new Error("Runtime artifact descriptor is invalid.");
  }
  const packageDirectory = join(canonical, "package");
  if (await hashArtifactTree(packageDirectory) !== value.tree_sha256) {
    throw new Error("Runtime artifact content changed.");
  }
  return Object.freeze({
    artifactDirectory: canonical,
    packageDirectory,
    version: value.version,
    integrity: value.integrity,
    sourceSha: value.source_sha,
    treeSha256: value.tree_sha256,
  });
}

async function hashArtifactTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      entries += 1;
      if (entries > 50_000 || child.name.includes("\0")) {
        throw new Error("Runtime artifact tree exceeded its bound.");
      }
      const path = join(directory, child.name);
      const metadata = await lstat(path);
      const name = relative(root, path);
      if (metadata.isSymbolicLink()) throw new Error("Runtime artifact contains a symbolic link.");
      if (metadata.isDirectory()) {
        hash.update(`D\0${name}\0${metadata.mode & 0o777}\0`);
        await walk(path);
        continue;
      }
      if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024) {
        throw new Error("Runtime artifact contains an unsupported file.");
      }
      bytes += metadata.size;
      if (bytes > 256 * 1024 * 1024) throw new Error("Runtime artifact tree exceeded its bound.");
      const content = await readFile(path);
      hash.update(`F\0${name}\0${metadata.mode & 0o777}\0${content.length}\0`);
      hash.update(content);
    }
  };
  await walk(root);
  return hash.digest("hex");
}

async function removeOwnedStaging(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      await rm(path, { force: true });
      return;
    }
    if (metadata.isDirectory()) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) await removeOwnedStaging(join(path, entry));
    } else if (metadata.isFile()) await chmod(path, 0o600);
    await rm(path, { recursive: metadata.isDirectory(), force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function revalidateArtifact(root: string, artifact: VerifiedRuntimeArtifact): Promise<VerifiedRuntimeArtifact> {
  const canonical = await realpath(artifact.artifactDirectory);
  if (!inside(join(root, "artifacts"), canonical)) throw new Error("Runtime artifact is outside the runtime root.");
  const actual = await readArtifactDescriptor(canonical);
  if (actual.version !== artifact.version || actual.integrity !== artifact.integrity ||
      actual.sourceSha !== artifact.sourceSha || actual.treeSha256 !== artifact.treeSha256) {
    throw new Error("Runtime artifact descriptor changed.");
  }
  await validateUnpackedPackage(canonical, artifact.version);
  return actual;
}

async function switchCurrent(root: string, target: string): Promise<void> {
  if (!inside(join(root, "artifacts"), target)) throw new Error("Runtime activation target is invalid.");
  const temporary = join(root, `.current-${process.pid}-${Date.now()}`);
  await symlink(relative(root, target), temporary, "dir");
  await rename(temporary, join(root, "current"));
}

async function readCurrentTarget(current: string, root: string): Promise<string | null> {
  try {
    const target = await realpath(current);
    if (!inside(join(root, "artifacts"), target)) throw new Error("Active runtime target is invalid.");
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertIdentity(identity: RuntimeBuildIdentity, artifact: VerifiedRuntimeArtifact): void {
  if (identity.package_version !== artifact.version ||
      identity.artifact_integrity !== artifact.integrity ||
      identity.source_sha !== artifact.sourceSha) {
    throw new Error("Running server identity does not match the active artifact.");
  }
}

async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const pending = operation(controller.signal);
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("Runtime lifecycle operation timed out."));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      await Promise.race([
        pending.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
