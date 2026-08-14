import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ManagedServiceDefinition } from "./managed-service.js";
import type { RuntimeBuildIdentity } from "./runtime-identity.js";
import type { VerifiedRuntimeArtifact } from "./runtime-lifecycle.js";
import { operatorErrors } from "./operator-error.js";

export interface ManagedServiceRuntimeState {
  readonly running: boolean;
  readonly mode?: "foreground" | "managed" | "legacy";
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

type DefinitionState =
  | { readonly kind: "absent" }
  | { readonly kind: "current" | "stale"; readonly content: string };

export async function installManagedService(
  input: ManagedServiceInstallInput,
): Promise<ManagedServiceInstallResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 300_000) {
    throw new Error("Managed service install timeout is invalid.");
  }
  await input.assertInstallation();
  const installLock = await acquireInstallLock(input.dataDirectory);
  try {
    const definitionState = await inspectDefinition(input.definition, input.uid);
    const [runtime, service] = await Promise.all([input.inspectRuntime(), input.inspectService()]);
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
    const previousContent = definitionState.kind === "absent" ? null : definitionState.content;
    const mustUnload = previousActive || (definitionState.kind === "stale" &&
      service.recoveryCommand === input.definition.recoverLoaded);
    let mutationStarted = false;
    try {
      if (mustUnload) {
        mutationStarted = true;
        await runWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.unload, signal));
        await waitForStopped(input, input.timeoutMs);
      }
      await ensurePrivateSink(input.definition.stdoutPath, input.uid);
      await ensurePrivateSink(input.definition.stderrPath, input.uid);
      if (definitionState.kind !== "current") {
        mutationStarted = true;
        await writePrivateFile(
          input.definition.definitionPath,
          input.definition.content,
          input.uid,
          previousContent,
        );
      }
      if (input.definition.reload !== null) {
        mutationStarted = true;
        await runWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.reload!, signal));
      }
      mutationStarted = true;
      const startCommand = input.definition.platform === "launchd" &&
          definitionState.kind === "current" && service.state === "inactive" &&
          service.recoveryCommand !== null
        ? service.recoveryCommand
        : input.definition.install;
      await runWithDeadline(input.timeoutMs, (signal) => input.run(startCommand, signal));
      const identity = await runWithDeadline(input.timeoutMs, input.probe);
      if (!runtimeMatchesArtifact(identity, input.artifact)) {
        throw new Error("Managed service started an unexpected runtime artifact.");
      }
      return result("installed", input, identity);
    } catch {
      if (!mutationStarted) throw new ManagedServiceInstallError("stopped");
      throw new ManagedServiceInstallError(await rollback(input, previousContent, previousActive));
    }
  } finally {
    await installLock.release();
  }
}

async function rollback(
  input: ManagedServiceInstallInput,
  previousContent: string | null,
  previousActive: boolean,
): Promise<"restored" | "stopped" | "failed"> {
  try {
    await runWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.rollbackRemove, signal))
      .catch(() => undefined);
    await waitForStopped(input, input.timeoutMs);
    if (previousContent === null) {
      await removeCurrentDefinition(input.definition);
    } else {
      await writePrivateFile(
        input.definition.definitionPath,
        previousContent,
        input.uid,
        input.definition.content,
      );
    }
    if (input.definition.reload !== null) {
      await runWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.reload!, signal));
    }
    if (!previousActive) return "stopped";
    await runWithDeadline(input.timeoutMs, (signal) => input.run(input.definition.install, signal));
    await runWithDeadline(input.timeoutMs, input.probe);
    return "restored";
  } catch {
    return "failed";
  }
}

async function inspectDefinition(
  definition: ManagedServiceDefinition,
  uid = process.getuid?.(),
): Promise<DefinitionState> {
  try {
    const metadata = await lstat(definition.definitionPath);
    await assertCanonicalDirectory(dirname(definition.definitionPath), uid);
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        metadata.size > 64 * 1024 || (uid !== undefined && metadata.uid !== uid) ||
        (metadata.mode & 0o077) !== 0) {
      throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
    }
    const content = await readFile(definition.definitionPath, "utf8");
    if (content === definition.content) return { kind: "current", content };
    if (content.includes(definition.ownershipMarker) ||
        isPublishedLegacyDefinition(definition, content)) return { kind: "stale", content };
    throw operatorErrors.MANAGED_SERVICE_DEFINITION_FOREIGN;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

function isPublishedLegacyDefinition(
  definition: ManagedServiceDefinition,
  content: string,
): boolean {
  const expected = legacyDefinitionContent(definition);
  const normalizedExpected = normalizeLegacyCommand(definition.platform, expected);
  const normalizedContent = normalizeLegacyCommand(definition.platform, content);
  return normalizedExpected !== null && normalizedContent === normalizedExpected;
}

function legacyDefinitionContent(definition: ManagedServiceDefinition): string {
  if (definition.platform === "launchd") {
    return definition.content
      .replace(`<!-- ${definition.ownershipMarker} -->\n`, "")
      .replace(/^  <key>Standard(?:Out|Error)Path<\/key><string>.*<\/string>\n/gmu, "")
      .replace("  <key>Umask</key><integer>63</integer>\n", "");
  }
  return definition.content
    .replace(`# ${definition.ownershipMarker}\n`, "")
    .replace("UMask=0077\n", "")
    .replace(/^Standard(?:Output|Error)=.*\n/gmu, "")
    .replaceAll("%%", "%");
}

function normalizeLegacyCommand(
  platform: ManagedServiceDefinition["platform"],
  content: string,
): string | null {
  if (platform === "launchd") {
    const command = /<key>ProgramArguments<\/key><array><string>([^<]*)<\/string>(<string>--disable-warning=ExperimentalWarning<\/string>)?<string>([^<]*)<\/string><string>start<\/string>(<string>--port<\/string><string>[0-9]+<\/string>)?<\/array>/u;
    const match = command.exec(content);
    if (match === null || !isCanonicalXmlPath(match[1] ?? "") ||
        !isCanonicalXmlPath(match[3] ?? "", "/current/package/dist/main.js") ||
        !isLegacyPort(match[4]?.match(/[0-9]+/u)?.[0])) return null;
    return content.replace(command,
      "<key>ProgramArguments</key><array><string>{NODE}</string>" +
      "<string>{RUNTIME}/current/package/dist/main.js</string><string>start</string></array>");
  }
  const command = /^ExecStart="((?:[^"\\\n]|\\["\\])*)"( "--disable-warning=ExperimentalWarning")? "((?:[^"\\\n]|\\["\\])*)" start( --port [0-9]+)?$/mu;
  const match = command.exec(content);
  if (match === null || !isCanonicalSystemdPath(match[1] ?? "") ||
      !isCanonicalSystemdPath(match[3] ?? "", "/current/package/dist/main.js") ||
      !isLegacyPort(match[4]?.slice(" --port ".length))) return null;
  return content.replace(command,
    'ExecStart="{NODE}" "{RUNTIME}/current/package/dist/main.js" start');
}

function isLegacyPort(value: string | undefined): boolean {
  if (value === undefined) return true;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 && String(port) === value;
}

function isCanonicalXmlPath(value: string, suffix = ""): boolean {
  const decoded = value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
  return xmlEscape(decoded) === value && isLegacyPath(decoded, suffix);
}

function isCanonicalSystemdPath(value: string, suffix = ""): boolean {
  const decoded = value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  return systemdEscape(decoded) === value && isLegacyPath(decoded, suffix);
}

function isLegacyPath(value: string, suffix: string): boolean {
  return isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value) && value.endsWith(suffix);
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function ensurePrivateSink(path: string, uid = process.getuid?.()): Promise<void> {
  await ensurePrivateDirectory(dirname(path), uid);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        (uid !== undefined && metadata.uid !== uid)) {
      throw operatorErrors.MANAGED_SERVICE_LOG_UNSAFE;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
}

async function writePrivateFile(
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
  await runWithDeadline(timeoutMs, async (signal) => {
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

async function acquireInstallLock(directory: string): Promise<{ readonly release: () => Promise<void> }> {
  const path = join(directory, "service-install.lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw operatorErrors.MANAGED_SERVICE_INSTALL_BUSY;
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

async function runWithDeadline<T>(
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
