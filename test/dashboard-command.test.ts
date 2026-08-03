import { mkdtemp, realpath, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrapServer } from "../src/bootstrap.js";
import { inspectRuntimeLock } from "../src/service.js";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const sqliteExperimentalWarning =
  /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n?/u;
let directory: string | undefined;
let server: ChildProcess | undefined;

afterEach(async () => {
  if (server !== undefined) {
    server.kill("SIGKILL");
    await waitForExit(server).catch(() => undefined);
    server = undefined;
  }
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("dashboard command", () => {
  it("reads the live server in a separate non-TTY process and leaves it running", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-command-")));
    await bootstrapServer(directory);
    server = spawn(process.execPath, [mainPath, "start", "--port", "0"], {
      env: childEnvironment(directory),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const live = await waitForLiveRuntime(directory);
    const result = await runDashboard(directory);

    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain("borgmcp-server online");
    expect(result.stdout).toContain(live.endpoint);
    expect(result.stdout).toContain("0 cubes | 0 posts/15m");
    expect(result.stdout).not.toContain("\u001b");
    if (Number(process.versions.node.split(".")[0]) < 24) {
      expect(result.stderr).toMatch(sqliteExperimentalWarning);
    }
    expect(withoutKnownSqliteWarning(result.stderr)).toBe("");
    expect(server.exitCode).toBeNull();
    expect(() => process.kill(server!.pid!, 0)).not.toThrow();

    server.kill("SIGTERM");
    await expect(waitForExit(server)).resolves.toMatchObject({ code: 0, signal: null });
    server = undefined;
  });

  it("reports missing and stopped installations without raw paths", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-state-")));
    const missingPath = join(directory, "private-missing-installation");
    const missing = await runDashboard(missingPath);
    expect(missing).toMatchObject({ code: 1, signal: null });
    const missingStderr = withoutKnownSqliteWarning(missing.stderr);
    expect(missingStderr).toBe(
      "Server command failed: Prepare the local server in BORG_SERVER_DATA_DIR " +
      "before opening the dashboard.\n",
    );
    expect(missingStderr).not.toContain(missingPath);

    await bootstrapServer(directory);
    const stopped = await runDashboard(directory);
    expect(stopped).toMatchObject({ code: 1, signal: null });
    const stoppedStderr = withoutKnownSqliteWarning(stopped.stderr);
    expect(stoppedStderr).toBe(
      "Server command failed: Start the local server before opening the dashboard.\n",
    );
    expect(stoppedStderr).not.toContain(directory);
  });
});

async function runDashboard(dataDirectory: string): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [mainPath, "dashboard"], {
    env: childEnvironment(dataDirectory),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return { ...await waitForExit(child), stdout, stderr };
}

function childEnvironment(dataDirectory: string): NodeJS.ProcessEnv {
  const {
    NODE_NO_WARNINGS: _nodeNoWarnings,
    NODE_OPTIONS: _nodeOptions,
    ...environment
  } = process.env;
  return { ...environment, BORG_SERVER_DATA_DIR: dataDirectory };
}

function withoutKnownSqliteWarning(stderr: string): string {
  return stderr.replace(new RegExp(sqliteExperimentalWarning.source, "gu"), "");
}

async function waitForLiveRuntime(dataDirectory: string): Promise<{
  readonly endpoint: string;
}> {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const runtime = await inspectRuntimeLock(dataDirectory).catch(() => ({ running: false } as const));
    if (runtime.running && runtime.endpoint !== null) return { endpoint: runtime.endpoint };
  }
  throw new Error("Server did not become ready.");
}

function waitForExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
