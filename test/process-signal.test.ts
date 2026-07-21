import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { bootstrapServer } from "../src/bootstrap.js";

const fixture = fileURLToPath(new URL("fixtures/process-signal-child.mjs", import.meta.url));
const startedChildren = new WeakSet<ChildProcess>();
const pendingMessages = new WeakMap<ChildProcess, unknown[]>();

describe("production process signal lifecycle", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "cleans every named startup phase on %s",
    async (signal) => {
      const phases = [
        "post-lock", "pre-lock", "pre-listen", "live-listener", "shutdown-in-progress",
        "post-lock", "pre-lock", "pre-listen", "live-listener", "shutdown-in-progress",
      ] as const;
      for (const phase of phases) {
        const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-process-signal-")));
        try {
          await bootstrapServer(directory);
          const child = startChild(directory, phase);
          const output = captureOutput(child);
          let origin: string | undefined;
          if (phase === "shutdown-in-progress") {
            origin = (await waitForPhase(child, "live-listener")).origin;
            const observed = waitForPhase(child, "signal-observed");
            child.kill(signal);
            await observed;
            await waitForPhase(child, "shutdown-in-progress");
            child.send("continue");
          } else {
            const reached = await waitForPhase(child, phase);
            origin = reached.origin;
            const observed = waitForPhase(child, "signal-observed");
            child.kill(signal);
            await observed;
            if (phase !== "live-listener") child.send("continue");
          }
          await expect(waitForExit(child, 3_000)).resolves.toMatchObject({ code: 0, signal: null });
          await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
          if (origin !== undefined) await expect(connectTo(origin)).rejects.toThrow();
          expect(await output).not.toMatch(/credential|invitation|private-key|secret/iu);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );

  it("exits fatally with listener unavailable and lock retained when close is unconfirmed", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-process-close-failure-")));
    try {
      await bootstrapServer(directory);
      const child = startChild(directory, "live-listener", true);
      const output = captureOutput(child);
      const { origin } = await waitForPhase(child, "live-listener");
      const observed = waitForPhase(child, "signal-observed");
      child.kill("SIGTERM");
      await observed;

      await expect(waitForExit(child, 3_000)).resolves.toMatchObject({ code: 1, signal: null });
      await expect(access(join(directory, "runtime.lock"))).resolves.toBeUndefined();
      await expect(connectTo(origin!)).rejects.toThrow();
      const fatalOutput = await output;
      expect(fatalOutput).toContain("Server command failed.\n");
      expect(fatalOutput).not.toContain("secret child close detail");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("refuses setup and reinitialization while the production server is live", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-main-live-setup-")));
    let running: ChildProcess | undefined;
    try {
      const installation = await bootstrapServer(directory);
      const before = await Promise.all(Object.values(installation.paths).map((path) => readFile(path)));
      const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      running = fork(mainPath, ["start", "--port", "0"], {
        env: { ...process.env, BORG_SERVER_DATA_DIR: directory },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const runningOutput = captureOutput(running);
      await waitForListeningOrigin(running);

      for (const args of [["setup"], ["setup", "--reinitialize"]]) {
        const setup = fork(mainPath, args, {
          env: { ...process.env, BORG_SERVER_DATA_DIR: directory },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const output = captureOutput(setup);
        await expect(waitForExit(setup, 3_000)).resolves.toMatchObject({ code: 1, signal: null });
        expect(await output).toContain(
          "Server command failed: Stop the server before running setup or offline administration.",
        );
      }
      const after = await Promise.all(Object.values(installation.paths).map((path) => readFile(path)));
      expect(after).toEqual(before);
      running.kill("SIGTERM");
      await expect(waitForExit(running, 3_000)).resolves.toMatchObject({ code: 0, signal: null });
      expect(await runningOutput).not.toMatch(/credential|invitation|private-key|secret/iu);
      running = undefined;
    } finally {
      if (running !== undefined) {
        running.kill("SIGKILL");
        await waitForExit(running, 3_000).catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it.each(["SIGTERM", "SIGINT"] as const)(
    "closes raw pre-TLS sockets within the production %s shutdown bound",
    async (signal) => {
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-main-signal-")));
        try {
          await bootstrapServer(directory);
          const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
          const child = fork(mainPath, ["start", "--port", "0"], {
            env: { ...process.env, BORG_SERVER_DATA_DIR: directory },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          });
          const output = captureOutput(child);
          const origin = await waitForListeningOrigin(child);
          const raw = await openRawSocket(origin);
          const startedAt = Date.now();
          child.kill(signal);

          await expect(waitForExit(child, 3_000)).resolves.toMatchObject({ code: 0, signal: null });
          expect(Date.now() - startedAt).toBeLessThan(3_000);
          await expect(raw.closed).resolves.toBeUndefined();
          await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
          await expect(connectTo(origin)).rejects.toThrow();
          expect(await output).not.toMatch(/credential|invitation|private-key|secret/iu);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    20_000,
  );

  it("keeps invalid ambient bind configuration inside the production main error boundary", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-main-config-")));
    try {
      const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      const help = fork(mainPath, ["help"], {
        env: {
          ...process.env,
          BORG_SERVER_DATA_DIR: directory,
          BORG_SERVER_BIND_HOST: "attacker.invalid",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const helpOutput = captureOutput(help);
      await expect(waitForExit(help, 3_000)).resolves.toMatchObject({ code: 0, signal: null });
      expect(await helpOutput).toContain("Usage: borg-mcp-server");
      expect(await helpOutput).not.toContain("attacker.invalid");
      expect(await helpOutput).not.toContain("file:///");

      const setup = fork(mainPath, ["setup"], {
        env: {
          ...process.env,
          BORG_SERVER_DATA_DIR: directory,
          BORG_SERVER_BIND_HOST: "attacker.invalid",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const setupOutput = captureOutput(setup);
      await expect(waitForExit(setup, 3_000)).resolves.toMatchObject({ code: 1, signal: null });
      const output = await setupOutput;
      expect(output).toContain("Server command failed: Configure --host as an explicit IP address.");
      expect(output).not.toContain("attacker.invalid");
      expect(output).not.toContain("file:///");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("sanitizes production entrypoint configuration failures without echoing input", async () => {
    const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    const cases = [
      {
        args: ["start", "--host", "example.invalid"],
        environment: {},
        expected: "Server command failed: Configure --host as an explicit IP address.",
        secret: "example.invalid",
      },
      {
        args: ["start", "--host", "0.0.0.0"],
        environment: {},
        expected: "Server command failed: Choose a specific loopback or private-LAN IP; wildcard binds are prohibited.",
        secret: "0.0.0.0",
      },
      {
        args: ["start", "--port", "attacker-port"],
        environment: {},
        expected: "Server command failed: Provide --port as an integer from 0 to 65535.",
        secret: "attacker-port",
      },
      {
        args: ["start"],
        environment: { BORG_SERVER_MAX_DATABASE_BYTES: "attacker-capacity" },
        expected: "Server command failed: Set BORG_SERVER_MAX_DATABASE_BYTES to a positive integer.",
        secret: "attacker-capacity",
      },
      {
        args: ["start"],
        environment: { BORG_SERVER_DATA_DIR: "/private/secret-server-path" },
        expected: "Server command failed.",
        secret: "/private/secret-server-path",
      },
    ] as const;

    for (const testCase of cases) {
      const child = fork(mainPath, [...testCase.args], {
        env: { ...process.env, ...testCase.environment },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const captured = captureOutput(child);
      await expect(waitForExit(child, 3_000)).resolves.toMatchObject({ code: 1, signal: null });
      const output = await captured;
      expect(output).toContain(testCase.expected);
      expect(output).not.toContain(testCase.secret);
      expect(output).not.toContain("file:///");
      expect(output).not.toContain("credential-secret");
    }
  }, 20_000);
});

function startChild(directory: string, phase: string, closeReject = false): ChildProcess {
  const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const child = spawn(process.execPath, [
    "--import",
    pathToFileURL(fixture).href,
    mainPath,
    "start",
    "--port",
    "0",
  ], {
    env: {
      ...process.env,
      BORG_SERVER_DATA_DIR: directory,
      BORG_TEST_DATA_DIR: directory,
      BORG_TEST_PHASE: phase,
      BORG_TEST_CLOSE_REJECT: closeReject ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const queued: unknown[] = [];
  pendingMessages.set(child, queued);
  child.on("message", (message) => queued.push(message));
  child.stderr?.on("data", (chunk: Buffer) => queued.push({ phase: `stderr:${chunk.toString("utf8")}` }));
  return child;
}

async function waitForPhase(child: ChildProcess, phase: string): Promise<{ origin?: string }> {
  if (!startedChildren.has(child)) {
    const target = waitForRawPhase(child, phase);
    const ready = waitForRawPhase(child, "preload-ready");
    await ready;
    startedChildren.add(child);
    child.send("start");
    return target;
  }
  return waitForRawPhase(child, phase);
}

function waitForRawPhase(child: ChildProcess, phase: string): Promise<{ origin?: string }> {
  const queued = pendingMessages.get(child) ?? [];
  const queuedIndex = queued.findIndex((message) => typeof message === "object" && message !== null &&
    (message as { phase?: unknown }).phase === phase);
  if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0] as { origin?: string });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const seen = queued.map((message) => typeof message === "object" && message !== null
        ? String((message as { phase?: unknown }).phase)
        : typeof message).join(",");
      reject(new Error(`Child did not reach ${phase}; observed: ${seen}.`));
    }, 10_000);
    const onMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null ||
          (message as { phase?: unknown }).phase !== phase) return;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("message", onMessage);
      const index = queued.indexOf(message);
      if (index >= 0) queued.splice(index, 1);
      resolve(message as { origin?: string });
    };
    const onExit = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      reject(new Error(`Child exited before ${phase}.`));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Child did not exit within the shutdown bound."));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function captureOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("close", () => resolve(output));
  });
}

function connectTo(origin: string): Promise<void> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function openRawSocket(origin: string): Promise<{ socket: Socket; closed: Promise<void> }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.once("connect", () => resolve({
      socket,
      closed: new Promise<void>((resolveClosed) => socket.once("close", () => resolveClosed())),
    }));
    socket.once("error", reject);
  });
}

function waitForListeningOrigin(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Production main did not report readiness.")), 3_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      const match = /"endpoint":"(https:\/\/[^"]+)"/u.exec(stderr);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Production main exited before readiness."));
    });
  });
}
