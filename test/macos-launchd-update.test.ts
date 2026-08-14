import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { bootstrapServer } from "../src/bootstrap.js";
import { createManagedServiceDefinition } from "../src/managed-service.js";
import { installManagedService } from "../src/managed-service-install.js";
import { operatorErrors } from "../src/operator-error.js";
import {
  createRuntimeLifecycle,
  createUnixNpmArtifactUnpacker,
} from "../src/runtime-lifecycle.js";
import { createRuntimeOperator } from "../src/runtime-operator.js";
import { SERVER_PACKAGE_VERSION } from "../src/runtime-identity.js";
import {
  completeRuntimeUpdate,
  inspectManagedServiceState,
  inspectNodeRuntime,
  inspectRuntimeLock,
} from "../src/service.js";

const execute = promisify(execFile);

describe("macOS launchd managed update journey", () => {
  it.skipIf(process.platform !== "darwin")(
    "updates, reports, and restarts an isolated managed runtime",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "borg-launchd-update-")));
      const dataDirectory = join(root, "data");
      const runtimeDirectory = join(root, "runtime");
      const definitionPath = join(root, "ai.borgmcp.server.test.plist");
      const label = `ai.borgmcp.server.test-${randomUUID()}`;
      const domain = `gui/${process.getuid?.() ?? 0}`;
      const definition = createManagedServiceDefinition({
        platform: "launchd",
        nodeExecutable: process.execPath,
        runtimeRoot: runtimeDirectory,
        dataDirectory,
        definitionPath,
        launchdDomain: domain,
        label,
        port: 0,
      });
      let loaded = false;
      try {
        await bootstrapServer(dataDirectory);
        const packed = await execute("npm", [
          "pack",
          "--ignore-scripts",
          "--pack-destination",
          root,
        ], {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        const archiveName = packed.stdout.trim().split("\n").at(-1);
        if (archiveName === undefined || archiveName === "") throw new Error("npm pack returned no archive.");
        const tarballPath = join(root, archiveName);
        const archive = await readFile(tarballPath);
        const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
        const run = async (
          command: readonly [string, ...string[]],
          signal: AbortSignal,
        ): Promise<{ readonly stdout: string; readonly stderr: string }> => {
          const [executable, ...args] = command;
          const result = await execute(executable, args, {
            signal,
            encoding: "utf8",
            timeout: 20_000,
            maxBuffer: 64 * 1024,
          });
          return { stdout: result.stdout, stderr: result.stderr };
        };
        const lifecycle = createRuntimeLifecycle({
          unpack: createUnixNpmArtifactUnpacker(),
          restart: async (signal) => { await run(definition.restart, signal); },
          stop: async (signal) => { await run(definition.unload, signal); },
          probe: (signal) => waitForManagedIdentity(dataDirectory, signal),
        });
        const operator = createRuntimeOperator({
          runtimeRoot: runtimeDirectory,
          artifacts: {
            latest: async () => ({
              tarballPath,
              version: SERVER_PACKAGE_VERSION,
              integrity,
              sourceSha: null,
              cleanup: async () => undefined,
            }),
          },
          lifecycle,
          isRunning: async () => {
            const status = await inspectRuntimeLock(dataDirectory);
            if (!status.running && status.stale !== undefined) {
              throw operatorErrors.RUNTIME_LOCK_STALE;
            }
            return status.running;
          },
        });

        const prepared = await operator.prepareLatest(30_000);
        const installInput = {
          definition,
          artifact: prepared,
          dataDirectory,
          assertInstallation: async () => undefined,
          inspectRuntime: async () => {
            const status = await inspectRuntimeLock(dataDirectory);
            return status.running
              ? { running: true as const, mode: status.mode, identity: status.identity }
              : { running: false as const, stale: status.stale !== undefined };
          },
          inspectService: () => inspectManagedServiceState(definition, run),
          run,
          probe: (signal: AbortSignal) => waitForManagedIdentity(dataDirectory, signal),
          timeoutMs: 20_000,
        };
        await expect(installManagedService(installInput)).resolves.toMatchObject({
          outcome: "installed",
          adapter: "launchd",
          artifact: { version: SERVER_PACKAGE_VERSION, integrity },
        });
        loaded = true;
        const first = await waitForManagedRuntime(dataDirectory);
        await expect(installManagedService(installInput)).resolves.toMatchObject({
          outcome: "already-installed",
        });
        expect((await lstat(definitionPath)).mode & 0o777).toBe(0o600);
        expect((await lstat(definition.stdoutPath)).mode & 0o777).toBe(0o600);
        expect((await lstat(definition.stderrPath)).mode & 0o777).toBe(0o600);

        const before = await inspectNodeRuntime(
          dataDirectory,
          runtimeDirectory,
          () => inspectManagedServiceState(definition, run),
        );
        expect(before).toMatchObject({
          status: "running",
          runningArtifact: { version: SERVER_PACKAGE_VERSION, integrity },
          mode: "managed",
          serviceState: "active",
          serviceAdapter: "launchd",
          runtimeLock: { state: "clear" },
        });

        const update = completeRuntimeUpdate(
          await operator.updateLatest(30_000),
          SERVER_PACKAGE_VERSION,
          await inspectManagedServiceState(definition, run),
        );
        expect(update).toMatchObject({
          outcome: "updated",
          artifact: { version: SERVER_PACKAGE_VERSION, integrity },
          runningIdentity: { package_version: SERVER_PACKAGE_VERSION, artifact_integrity: integrity },
          serviceState: "active",
          serviceAdapter: "launchd",
        });
        const afterUpdate = await waitForManagedRuntime(dataDirectory, first.pid);

        await run(definition.restart, new AbortController().signal);
        const afterRestart = await waitForManagedRuntime(dataDirectory, afterUpdate.pid);
        const final = await inspectNodeRuntime(
          dataDirectory,
          runtimeDirectory,
          () => inspectManagedServiceState(definition, run),
        );
        expect(final).toMatchObject({
          status: "running",
          runningArtifact: { version: SERVER_PACKAGE_VERSION, integrity },
          mode: "managed",
          serviceState: "active",
          serviceAdapter: "launchd",
          runtimeLock: { state: "clear" },
        });
        expect(afterRestart.pid).not.toBe(afterUpdate.pid);

        const serviceTarget = definition.status[2];
        if (serviceTarget === undefined) throw new Error("Launchd service target is unavailable.");
        await run(
          ["launchctl", "kill", "SIGTERM", serviceTarget],
          new AbortController().signal,
        );
        await waitForStopped(dataDirectory);
        const stoppedLoaded = await inspectManagedServiceState(definition, run);
        expect(stoppedLoaded).toEqual({
          state: "inactive",
          adapter: "launchd",
          recoveryCommand: definition.recoverLoaded,
        });
        expect(completeRuntimeUpdate(
          await operator.updateLatest(30_000),
          SERVER_PACKAGE_VERSION,
          stoppedLoaded,
        )).toMatchObject({
          outcome: "prepared",
          runningIdentity: null,
          serviceState: "inactive",
          serviceRecoveryCommand: definition.recoverLoaded,
        });

        await run(definition.recoverLoaded, new AbortController().signal);
        await waitForManagedRuntime(dataDirectory);
        await run(definition.unload, new AbortController().signal);
        loaded = false;
        await waitForStopped(dataDirectory);
        const unloadedDefined = await inspectManagedServiceState(definition, run);
        expect(unloadedDefined).toEqual({
          state: "inactive",
          adapter: "launchd",
          recoveryCommand: definition.install,
        });
        expect(completeRuntimeUpdate(
          await operator.updateLatest(30_000),
          SERVER_PACKAGE_VERSION,
          unloadedDefined,
        )).toMatchObject({
          outcome: "prepared",
          runningIdentity: null,
          serviceState: "inactive",
          serviceRecoveryCommand: definition.install,
        });

        await rm(definitionPath);
        const absent = await inspectManagedServiceState(definition, run);
        expect(absent).toEqual({
          state: "absent",
          adapter: null,
          recoveryCommand: null,
        });
        expect(completeRuntimeUpdate(
          await operator.updateLatest(30_000),
          SERVER_PACKAGE_VERSION,
          absent,
        )).toMatchObject({
          outcome: "prepared",
          runningIdentity: null,
          serviceState: "absent",
          serviceRecoveryCommand: null,
        });
      } finally {
        if (loaded) {
          await execute(definition.unload[0], definition.unload.slice(1), {
            encoding: "utf8",
            timeout: 20_000,
          }).catch(() => undefined);
          await waitForStopped(dataDirectory).catch(() => undefined);
        }
        await makeWritable(root).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});

async function waitForManagedIdentity(
  dataDirectory: string,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      const status = await inspectRuntimeLock(dataDirectory);
      if (status.running && status.mode === "managed" && status.identity !== null) {
        return status.identity;
      }
    } catch (error) {
      if (error !== operatorErrors.RUNTIME_LOCK_INVALID) throw error;
    }
    await delay(50);
  }
  throw new Error("Managed runtime identity probe was cancelled.");
}

async function waitForManagedRuntime(
  dataDirectory: string,
  previousPid?: number,
): Promise<Extract<Awaited<ReturnType<typeof inspectRuntimeLock>>, { running: true }>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const status = await inspectRuntimeLock(dataDirectory);
      if (status.running && status.mode === "managed" && status.identity !== null &&
          (previousPid === undefined || status.pid !== previousPid)) {
        return status;
      }
    } catch (error) {
      if (error !== operatorErrors.RUNTIME_LOCK_INVALID) throw error;
    }
    await delay(50);
  }
  throw new Error("Managed launchd runtime did not become ready.");
}

async function waitForStopped(dataDirectory: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const status = await inspectRuntimeLock(dataDirectory);
      if (!status.running && status.stale === undefined) return;
    } catch (error) {
      if (error !== operatorErrors.RUNTIME_LOCK_INVALID) throw error;
    }
    await delay(50);
  }
  throw new Error("Managed launchd runtime did not stop.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (!metadata.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}
