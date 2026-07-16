import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { bootstrapServer } from "../src/bootstrap.js";
import { runMain } from "../src/main.js";
import { operatorErrors, type OperatorErrorCode } from "../src/operator-error.js";
import * as operatorErrorModule from "../src/operator-error.js";
import {
  acquireRuntimeLock,
  createNodeServerService,
  createOfflineCredentialService,
  nodeServerService,
  type ServerService,
} from "../src/service.js";
import { isFatalTeardownError } from "../src/service.js";
import * as serviceModule from "../src/service.js";

const execute = promisify(execFile);

describe("main operator errors", () => {
  it("runs when npm invokes the executable through a bin symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "borg-main-bin-"));
    const bin = join(directory, "borg-mcp-server");
    try {
      await symlink(join(process.cwd(), "dist", "main.js"), bin);
      const result = await execute(process.execPath, [bin, "--help"]);
      expect(result.stdout).toContain("Usage: borg-mcp-server");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["START_PORT_INVALID", "Provide --port as an integer from 0 to 65535."],
    ["BIND_LAN_CONSENT", "Add --lan to consent to this private-LAN start."],
    ["SERVER_FILES_MISSING", "Configure BORG_SERVER_DATA_DIR or the required TLS file variables."],
    ["RUNTIME_ACTIVE", "Stop the server before running offline client administration."],
    ["DATABASE_LIMIT_INVALID", "Set BORG_SERVER_MAX_DATABASE_BYTES to a positive integer."],
  ] as const)("prints the actionable typed error: %s", async (code, publicMessage) => {
    const previousExitCode = process.exitCode;
    const stderr = vi.fn();
    const service: ServerService = {
      start: vi.fn().mockRejectedValue(operatorErrors[code as OperatorErrorCode]),
    };
    try {
      await runMain(["start"], service, { stdout: vi.fn(), stderr });
      expect(stderr).toHaveBeenCalledWith(`Server command failed: ${publicMessage}`);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("prints actionable output through the real CLI and service option parser", async () => {
    const previousExitCode = process.exitCode;
    const stderr = vi.fn();
    try {
      await runMain(["start", "--port", "attacker-value"], nodeServerService, {
        stdout: vi.fn(),
        stderr,
      });
      expect(stderr).toHaveBeenCalledWith(
        "Server command failed: Provide --port as an integer from 0 to 65535.",
      );
      expect(JSON.stringify(stderr.mock.calls)).not.toContain("attacker-value");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("explains setup rejection of a symlinked data directory without disclosing paths", async () => {
    const previousExitCode = process.exitCode;
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-main-setup-")));
    const target = join(parent, "private-target");
    const link = join(parent, "server-link");
    const stderr = vi.fn();
    try {
      await bootstrapServer(target);
      await symlink(target, link);
      const service: ServerService = {
        start: vi.fn(),
        setup: () => bootstrapServer(link),
      };

      await runMain(["setup"], service, { stdout: vi.fn(), stderr });

      expect(stderr).toHaveBeenCalledWith(
        "Server command failed: Choose a BORG_SERVER_DATA_DIR path that contains no symbolic links.",
      );
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(parent);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("keeps non-file setup database paths opaque", async () => {
    const previousExitCode = process.exitCode;
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-main-setup-leaf-")));
    const dataDirectory = join(parent, "server");
    const stderr = vi.fn();
    try {
      await mkdir(join(dataDirectory, "borg.db"), { recursive: true });
      const service: ServerService = {
        start: vi.fn(),
        setup: () => bootstrapServer(dataDirectory),
      };

      await runMain(["setup"], service, { stdout: vi.fn(), stderr });

      expect(stderr).toHaveBeenCalledWith("Server command failed.");
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(parent);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.each([
    [["start", "--host", "example.invalid"], "Server command failed: Configure --host as an explicit IP address."],
    [["start", "--host", "192.168.1.20"], "Server command failed: Add --lan to consent to this private-LAN start."],
  ] as const)("prints static network policy guidance for %j", async (args, message) => {
    const previousExitCode = process.exitCode;
    const stderr = vi.fn();
    try {
      await runMain(args, nodeServerService, { stdout: vi.fn(), stderr });
      expect(stderr).toHaveBeenCalledWith(message);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(args.at(-1));
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    [{}, "Server command failed: Configure BORG_SERVER_DATA_DIR or the required TLS file variables."],
    [{ BORG_SERVER_MAX_DATABASE_BYTES: "attacker-value" }, "Server command failed: Set BORG_SERVER_MAX_DATABASE_BYTES to a positive integer."],
  ] as const)("prints static service configuration guidance", async (environment, message) => {
    const previousExitCode = process.exitCode;
    const stderr = vi.fn();
    const service = createNodeServerService({
      environment,
      readFile: vi.fn(),
      readPrivateKey: vi.fn(),
      startServer: vi.fn(),
      onStarted: vi.fn(),
      waitForShutdown: vi.fn(),
    });
    try {
      await runMain(["start"], service, { stdout: vi.fn(), stderr });
      expect(stderr).toHaveBeenCalledWith(message);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain("attacker-value");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("prints static lock and unknown-client guidance through real offline services", async () => {
    const previousExitCode = process.exitCode;
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-main-operator-")));
    const stderr = vi.fn();
    try {
      await bootstrapServer(directory);
      const offline: ServerService = { start: vi.fn(), ...createOfflineCredentialService(directory) };
      const lock = await acquireRuntimeLock(directory);
      await runMain([
        "client-revoke",
        "00000000-0000-4000-8000-000000000001",
      ], offline, { stdout: vi.fn(), stderr });
      expect(stderr).toHaveBeenLastCalledWith(
        "Server command failed: Stop the server before running offline client administration.",
      );
      await lock.release();
      await runMain([
        "client-revoke",
        "00000000-0000-4000-8000-000000000001",
      ], offline, { stdout: vi.fn(), stderr });
      expect(stderr).toHaveBeenLastCalledWith(
        "Server command failed: Provide an existing active client ID.",
      );
    } finally {
      process.exitCode = previousExitCode;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not expose paths, credentials, or untrusted internal errors", async () => {
    const previousExitCode = process.exitCode;
    const stderr = vi.fn();
    const secret = "credential-secret-material";
    const service: ServerService = {
      start: vi.fn().mockRejectedValue(new Error(`open /private/server.key failed: ${secret}`)),
    };
    try {
      await runMain(["start"], service, { stdout: vi.fn(), stderr });
      expect(stderr).toHaveBeenCalledWith("Server command failed.");
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain("/private/server.key");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("does not trust a generic error that copies an allowlisted message", async () => {
    const previousExitCode = process.exitCode;
    const stderr = vi.fn();
    const service: ServerService = {
      start: vi.fn().mockRejectedValue(new Error("Stop the server before running offline client administration.")),
    };
    try {
      await runMain(["start"], service, { stdout: vi.fn(), stderr });
      expect(stderr).toHaveBeenCalledWith("Server command failed.");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("rejects spoofed, subclassed, cloned, accessor, and unknown operator errors", async () => {
    const secret = "secret-token-/private/server.key";
    const getter = vi.fn(() => secret);
    const legitimate = operatorErrors.RUNTIME_ACTIVE;
    expect(Reflect.set(legitimate, "message", secret)).toBe(false);
    const accessor = Object.freeze(Object.defineProperties({}, {
      publicMessage: { get: getter },
      message: { get: getter },
    }));
    const errors: unknown[] = [
      Object.freeze(Object.create(Object.getPrototypeOf(legitimate)) as object),
      Object.freeze({ ...legitimate, message: secret, publicMessage: secret }),
      accessor,
      new Proxy(legitimate, {
        get: () => { throw new Error(secret); },
        getPrototypeOf: () => { throw new Error(secret); },
      }),
      Object.freeze({ code: "ATTACKER_CODE", message: secret, publicMessage: secret }),
    ];
    const RecoveredConstructor = Object.getPrototypeOf(legitimate).constructor as new (
      capability: object,
      code: OperatorErrorCode,
    ) => Error;
    const constructorAttempts = [
      () => new RecoveredConstructor({}, "RUNTIME_ACTIVE"),
      () => Reflect.construct(RecoveredConstructor, [{}, "RUNTIME_ACTIVE"]),
      () => Reflect.construct(RecoveredConstructor.bind(null, {}), ["RUNTIME_ACTIVE"]),
      () => (RecoveredConstructor as unknown as Function).call({}, {}, "RUNTIME_ACTIVE"),
      () => (RecoveredConstructor as unknown as Function).apply({}, [{}, "RUNTIME_ACTIVE"]),
    ];
    for (const attempt of constructorAttempts) {
      try {
        errors.push(attempt());
      } catch (error) {
        errors.push(error);
      }
    }

    for (const error of errors) {
      const previousExitCode = process.exitCode;
      const stderr = vi.fn();
      const service: ServerService = { start: vi.fn().mockRejectedValue(error) };
      try {
        await runMain(["start"], service, { stdout: vi.fn(), stderr });
        expect(stderr).toHaveBeenCalledWith("Server command failed.");
        expect(JSON.stringify(stderr.mock.calls)).not.toContain(secret);
      } finally {
        process.exitCode = previousExitCode;
      }
    }
    expect(getter).not.toHaveBeenCalled();
    expect("OperatorError" in operatorErrorModule).toBe(false);
    expect(Reflect.ownKeys(legitimate)).not.toContain("operatorErrorCapability");
    expect(Reflect.ownKeys(Object.getPrototypeOf(legitimate))).not.toContain("operatorErrorCapability");
  });

  it("rejects constructor-recovery attacks against the built operator-error module", async () => {
    const operatorModulePath = "../dist/operator-error.js";
    const mainModulePath = "../dist/main.js";
    const built = await import(operatorModulePath);
    const builtMain = await import(mainModulePath);
    const secret = "built-secret-/private/operator-path";
    const legitimate = built.operatorErrors.RUNTIME_ACTIVE;
    const Recovered = Object.getPrototypeOf(legitimate).constructor as new (...args: unknown[]) => unknown;
    const proxyTraps = vi.fn(() => { throw new Error(secret); });
    const attempts: Array<() => unknown> = [
      () => new Recovered({}, "RUNTIME_ACTIVE"),
      () => Reflect.construct(Recovered, [{}, "RUNTIME_ACTIVE"]),
      () => Reflect.construct(Recovered.bind(null, {}), ["RUNTIME_ACTIVE"]),
      () => (Recovered as unknown as Function).call({}, {}, "RUNTIME_ACTIVE"),
      () => (Recovered as unknown as Function).apply({}, [{}, "RUNTIME_ACTIVE"]),
      () => {
        const Base = Recovered as any;
        return new (class extends Base {
          constructor() { super({}, "RUNTIME_ACTIVE"); }
        })();
      },
      () => Object.create(Object.getPrototypeOf(legitimate)),
      () => Object.freeze({ ...legitimate, message: secret, publicMessage: secret }),
      () => new Proxy(legitimate, {
        get: proxyTraps,
        getPrototypeOf: proxyTraps,
        ownKeys: proxyTraps,
      }),
      () => Object.freeze(Object.fromEntries(
        Reflect.ownKeys(legitimate).map((key) => [String(key), secret]),
      )),
    ];
    expect(Reflect.set(legitimate, "message", secret)).toBe(false);
    expect(Reflect.ownKeys(legitimate)).not.toContain("operatorErrorCapability");
    expect(Reflect.ownKeys(Object.getPrototypeOf(legitimate))).not.toContain("operatorErrorCapability");
    for (const invoke of attempts) {
      let result: unknown;
      try { result = invoke(); } catch (error) { result = error; }
      expect(built.operatorPublicMessage(result)).toBeNull();
      const previousExitCode = process.exitCode;
      const stderr = vi.fn();
      try {
        await builtMain.runMain(
          ["start"],
          { start: vi.fn().mockRejectedValue(result) },
          { stdout: vi.fn(), stderr },
        );
        expect(process.exitCode).toBe(1);
        expect(stderr).toHaveBeenCalledWith("Server command failed.");
        expect(JSON.stringify(stderr.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(stderr.mock.calls)).not.toContain("file:///");
        expect(JSON.stringify(stderr.mock.calls)).not.toContain("Operator error construction");
      } finally {
        process.exitCode = previousExitCode;
      }
    }
    expect(proxyTraps).not.toHaveBeenCalled();

    const previousExitCode = process.exitCode;
    const stderr = vi.fn();
    try {
      await builtMain.runMain(
        ["start"],
        { start: vi.fn().mockRejectedValue(legitimate) },
        { stdout: vi.fn(), stderr },
      );
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        "Server command failed: Stop the server before running offline client administration.",
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("does not expose fatal-error minting and rejects structural fatal forgeries", () => {
    expect("FatalTeardownError" in serviceModule).toBe(false);
    expect(isFatalTeardownError(new AggregateError([], "Server teardown could not be confirmed")))
      .toBe(false);
    expect(isFatalTeardownError(Object.freeze({
      name: "FatalTeardownError",
      message: "Server teardown could not be confirmed; the runtime remains locked.",
      errors: [],
    }))).toBe(false);
  });
});
