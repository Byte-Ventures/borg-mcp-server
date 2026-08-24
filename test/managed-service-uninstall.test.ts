import { chmod, link, lstat, mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagedServiceDefinition } from "../src/managed-service.js";
import {
  ManagedServiceUninstallError,
  uninstallManagedService,
  type ManagedServiceUninstallInput,
} from "../src/managed-service-uninstall.js";
import { operatorErrors, operatorPublicDetails } from "../src/operator-error.js";
import { inspectManagedServiceState } from "../src/service.js";

const directories: string[] = [];
const identity = Object.freeze({
  package_version: "0.19.0",
  artifact_integrity: `sha512-${"A".repeat(86)}==`,
  source_sha: "a".repeat(40),
  protocol_version: "12",
  started_at: "2026-08-14T12:00:00.000Z",
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("managed service uninstallation", () => {
  it("removes an active systemd definition and preserves every retained path", async () => {
    const fixture = await uninstallFixture("systemd");
    let running = true;
    let serviceState: "active" | "absent" = "active";
    const commands: string[][] = [];
    const input = {
      ...fixture.input,
      inspectRuntime: async () => running
        ? { running: true, mode: "managed" as const, identity }
        : { running: false },
      inspectService: async () => serviceState === "active"
        ? { state: "active" as const, recoveryCommand: null }
        : { state: "absent" as const, recoveryCommand: null },
      run: async (command: readonly [string, ...string[]]) => {
        commands.push([...command]);
        if (command === fixture.definition.rollbackRemove) {
          running = false;
          serviceState = "absent";
        }
        return { stdout: "", stderr: "" };
      },
    } satisfies ManagedServiceUninstallInput;

    await expect(uninstallManagedService(input)).resolves.toEqual({
      outcome: "removed-active",
      adapter: "systemd",
    });
    expect(commands).toEqual([
      ["systemctl", "--user", "disable", "--now", "ai.borgmcp.server"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    await expect(lstat(fixture.definition.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    for (const [path, content] of fixture.retained) {
      expect(await readFile(path, "utf8")).toBe(content);
    }
  });

  it("removes inactive launchd and systemd definitions and treats absence idempotently", async () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const fixture = await uninstallFixture(platform);
      const commands: string[][] = [];
      let serviceState: "inactive" | "absent" = "inactive";
      await expect(uninstallManagedService({
        ...fixture.input,
        inspectService: async () => serviceState === "inactive"
          ? { state: "inactive", recoveryCommand: fixture.definition.recoverLoaded }
          : { state: "absent", recoveryCommand: null },
        run: async (command) => {
          commands.push([...command]);
          if (command === fixture.definition.rollbackRemove) serviceState = "absent";
          return { stdout: "", stderr: "" };
        },
      })).resolves.toEqual({ outcome: "removed-inactive", adapter: platform });
      expect(commands).toContainEqual([...fixture.definition.rollbackRemove]);

      commands.length = 0;
      await expect(uninstallManagedService({
        ...fixture.input,
        run: async (command) => {
          commands.push([...command]);
          return { stdout: "", stderr: "" };
        },
      })).resolves.toEqual({ outcome: "already-absent", adapter: platform });
      expect(commands).toEqual([]);
    }
  });

  it("stops and removes an active launchd definition", async () => {
    const fixture = await uninstallFixture("launchd");
    let running = true;
    let active = true;
    await expect(uninstallManagedService({
      ...fixture.input,
      inspectRuntime: async () => running
        ? { running: true, mode: "managed", identity }
        : { running: false },
      inspectService: async () => active
        ? { state: "active", recoveryCommand: null }
        : { state: "absent", recoveryCommand: null },
      run: async (command) => {
        if (command === fixture.definition.rollbackRemove) {
          running = false;
          active = false;
        }
        return { stdout: "", stderr: "" };
      },
    })).resolves.toEqual({ outcome: "removed-active", adapter: "launchd" });
    await expect(lstat(fixture.definition.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an already-unloaded launchd definition without a controller command", async () => {
    const fixture = await uninstallFixture("launchd");
    const run = vi.fn();
    await expect(uninstallManagedService({
      ...fixture.input,
      inspectService: async () => {
        try {
          await lstat(fixture.definition.definitionPath);
          return { state: "inactive" as const, recoveryCommand: fixture.definition.install };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return { state: "absent" as const, recoveryCommand: null };
        }
      },
      run,
    })).resolves.toEqual({ outcome: "removed-inactive", adapter: "launchd" });
    expect(run).not.toHaveBeenCalled();
  });

  it("distinguishes leftover active and inactive registrations from complete absence", async () => {
    const fixture = await uninstallFixture("systemd");
    await unlink(fixture.definition.definitionPath);

    for (const serviceState of ["active", "inactive"] as const) {
      await expect(uninstallManagedService({
        ...fixture.input,
        inspectService: async () => serviceState === "active"
          ? { state: "active", recoveryCommand: null }
          : { state: "inactive", recoveryCommand: fixture.definition.install },
      })).rejects.toBe(operatorErrors.MANAGED_SERVICE_REGISTRATION_LEFTOVER);
    }
    await expect(uninstallManagedService({
      ...fixture.input,
      inspectService: async () => { throw new Error("private controller probe failure"); },
    })).rejects.toMatchObject({
      definitionState: "absent",
      serviceState: "unknown",
      serviceRecoveryCommand: null,
      runningIdentityRestored: null,
    });
    await expect(uninstallManagedService(fixture.input)).resolves.toEqual({
      outcome: "already-absent",
      adapter: "systemd",
    });
  });

  it("preserves production loaded-inactive evidence when the definition is missing", async () => {
    const message =
      "No Borg service definition is present, but the service manager still reports ai.borgmcp.server. " +
      "Remove the leftover registration, then retry:\n" +
      "  macOS: launchctl bootout gui/$(id -u)/ai.borgmcp.server\n" +
      "  Linux: systemctl --user disable --now ai.borgmcp.server";
    for (const platform of ["launchd", "systemd"] as const) {
      const fixture = await uninstallFixture(platform);
      await unlink(fixture.definition.definitionPath);
      const inspectService = () => inspectManagedServiceState(
        fixture.definition,
        async () => ({
          stdout: platform === "launchd"
            ? "state = exited\n"
            : "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n",
          stderr: "",
        }),
      );
      await expect(inspectService()).resolves.toEqual({
        state: "inactive",
        adapter: platform,
        recoveryCommand: null,
      });
      const run = vi.fn();
      let failure: unknown;
      try {
        await uninstallManagedService({ ...fixture.input, inspectService, run });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(operatorErrors.MANAGED_SERVICE_REGISTRATION_LEFTOVER);
      expect(operatorPublicDetails(failure)).toEqual({
        code: "MANAGED_SERVICE_REGISTRATION_LEFTOVER",
        message,
      });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("removes marker-owned stale definitions but refuses foreign and hardlinked files before mutation", async () => {
    const fixture = await uninstallFixture("systemd");
    const stale = fixture.definition.content.replace("Description=Borg MCP server", "Description=Older Borg MCP server");
    await writeFile(fixture.definition.definitionPath, stale, { mode: 0o600 });
    await expect(uninstallManagedService(fixture.input)).resolves.toMatchObject({
      outcome: "removed-inactive",
    });

    await writeFile(fixture.definition.definitionPath, "# foreign\n[Unit]\n", { mode: 0o600 });
    const run = vi.fn();
    await expect(uninstallManagedService({ ...fixture.input, run }))
      .rejects.toThrow("not recognized as Borg-owned");
    expect(run).not.toHaveBeenCalled();

    await writeFile(fixture.definition.definitionPath, fixture.definition.content, { mode: 0o600 });
    await chmod(fixture.definition.definitionPath, 0o644);
    await expect(uninstallManagedService({ ...fixture.input, run }))
      .rejects.toThrow("owner-private regular file");
    expect(run).not.toHaveBeenCalled();

    await chmod(fixture.definition.definitionPath, 0o600);
    await link(fixture.definition.definitionPath, join(fixture.directory, "definition-alias"));
    await expect(uninstallManagedService({ ...fixture.input, run }))
      .rejects.toThrow("owner-private regular file");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses markerless definitions published by v0.18.1 without controller mutation", async () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const fixture = await uninstallFixture(platform);
      const legacy = legacyDefinition(fixture.directory, platform);
      await writeFile(fixture.definition.definitionPath, legacy, { mode: 0o600 });
      const run = vi.fn();

      await expect(uninstallManagedService({ ...fixture.input, run }))
        .rejects.toThrow("not recognized as Borg-owned");
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(fixture.definition.definitionPath, "utf8")).toBe(legacy);
    }
  });

  it("preserves an incomplete live runtime-lock refusal before controller or file mutation", async () => {
    const fixture = await uninstallFixture("systemd");
    const run = vi.fn();

    await expect(uninstallManagedService({
      ...fixture.input,
      inspectRuntime: async () => { throw operatorErrors.RUNTIME_LOCK_LIVE_UNRECOGNIZED; },
      inspectService: vi.fn(),
      run,
    })).rejects.toBe(operatorErrors.RUNTIME_LOCK_LIVE_UNRECOGNIZED);
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(fixture.definition.definitionPath, "utf8"))
      .toBe(fixture.definition.content);
  });

  it("retains the definition and reports observed state when controller removal fails", async () => {
    const fixture = await uninstallFixture("launchd");
    const input = {
      ...fixture.input,
      inspectService: async () => ({ state: "active" as const, recoveryCommand: null }),
      inspectRuntime: async () => ({ running: true, mode: "managed" as const, identity }),
      run: async () => { throw new Error("private launchctl failure"); },
    } satisfies ManagedServiceUninstallInput;

    await expect(uninstallManagedService(input)).rejects.toMatchObject({
      name: "ManagedServiceUninstallError",
      definitionState: "retained",
      serviceState: "active",
      serviceRecoveryCommand: null,
      runningIdentityRestored: true,
      message: "Managed service uninstallation did not complete.",
    });
    expect(await readFile(fixture.definition.definitionPath, "utf8"))
      .toBe(fixture.definition.content);
  });

  it("reports retained definition and unknown service state when the initial controller probe fails", async () => {
    const fixture = await uninstallFixture("systemd");
    await expect(uninstallManagedService({
      ...fixture.input,
      inspectService: async () => { throw new Error("private controller probe failure"); },
    })).rejects.toMatchObject({
      definitionState: "retained",
      serviceState: "unknown",
      serviceRecoveryCommand: null,
      runningIdentityRestored: null,
    });
    expect(await readFile(fixture.definition.definitionPath, "utf8"))
      .toBe(fixture.definition.content);
  });

  it("serializes with installation through the existing managed-service lock", async () => {
    const fixture = await uninstallFixture("systemd");
    await writeFile(join(fixture.directory, "data", "service-install.lock"), "123\n", { mode: 0o600 });
    const run = vi.fn();
    await expect(uninstallManagedService({ ...fixture.input, run })).rejects.toThrow(
      "Another managed service change is running.",
    );
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(fixture.definition.definitionPath, "utf8"))
      .toBe(fixture.definition.content);
  });

  it("reports a retained definition and exact recovery command after a filesystem failure", async () => {
    const fixture = await uninstallFixture("systemd");
    const definitionDirectory = dirname(fixture.definition.definitionPath);
    let serviceState: "inactive" | "absent" = "inactive";
    const input = {
      ...fixture.input,
      inspectService: async () => serviceState === "inactive"
        ? { state: "inactive" as const, recoveryCommand: fixture.definition.recoverLoaded }
        : { state: "absent" as const, recoveryCommand: null },
      run: async (command: readonly [string, ...string[]]) => {
        if (command === fixture.definition.rollbackRemove) {
          serviceState = "absent";
          await chmod(definitionDirectory, 0o500);
        }
        return { stdout: "", stderr: "" };
      },
    } satisfies ManagedServiceUninstallInput;

    let failure: unknown;
    try {
      await uninstallManagedService(input);
    } catch (error) {
      failure = error;
    } finally {
      await chmod(definitionDirectory, 0o700);
    }
    expect(failure).toBeInstanceOf(ManagedServiceUninstallError);
    expect(failure).toMatchObject({
      definitionState: "retained",
      serviceState: "absent",
      serviceRecoveryCommand: ["systemctl", "--user", "enable", "--now", "ai.borgmcp.server"],
      runningIdentityRestored: null,
    });
    expect(await readFile(fixture.definition.definitionPath, "utf8"))
      .toBe(fixture.definition.content);
  });

  it("restores an active definition only when the prior stable identity returns", async () => {
    const fixture = await uninstallFixture("systemd");
    let running = true;
    let active = true;
    let reloads = 0;
    const input = {
      ...fixture.input,
      inspectRuntime: async () => running
        ? { running: true, mode: "managed" as const, identity }
        : { running: false },
      inspectService: async () => active
        ? { state: "active" as const, recoveryCommand: null }
        : { state: "absent" as const, recoveryCommand: null },
      run: async (command: readonly [string, ...string[]]) => {
        if (command === fixture.definition.rollbackRemove) {
          running = false;
          active = false;
        } else if (command === fixture.definition.reload) {
          reloads += 1;
          if (reloads === 1) throw new Error("private reload failure");
        } else if (command === fixture.definition.install) {
          running = true;
          active = true;
        }
        return { stdout: "", stderr: "" };
      },
      probe: async () => ({ ...identity, started_at: "2026-08-14T13:00:00.000Z" }),
    } satisfies ManagedServiceUninstallInput;

    await expect(uninstallManagedService(input)).rejects.toMatchObject({
      definitionState: "retained",
      serviceState: "active",
      runningIdentityRestored: true,
    });
    expect(await readFile(fixture.definition.definitionPath, "utf8"))
      .toBe(fixture.definition.content);
  });

  it("never removes or overwrites a definition replaced during controller shutdown", async () => {
    const fixture = await uninstallFixture("launchd");
    const replacement = "foreign replacement\n";
    let running = true;
    let active = true;
    await expect(uninstallManagedService({
      ...fixture.input,
      inspectRuntime: async () => running
        ? { running: true, mode: "managed", identity }
        : { running: false },
      inspectService: async () => active
        ? { state: "active", recoveryCommand: null }
        : { state: "absent", recoveryCommand: null },
      run: async (command) => {
        if (command === fixture.definition.rollbackRemove) {
          running = false;
          active = false;
          await writeFile(fixture.definition.definitionPath, replacement, { mode: 0o600 });
        }
        return { stdout: "", stderr: "" };
      },
    })).rejects.toMatchObject({
      definitionState: "changed",
      serviceState: "absent",
      serviceRecoveryCommand: null,
      runningIdentityRestored: false,
    });
    expect(await readFile(fixture.definition.definitionPath, "utf8")).toBe(replacement);
  });
});

function legacyDefinition(directory: string, platform: "launchd" | "systemd"): string {
  if (platform === "launchd") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.borgmcp.server</string>
  <key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/old-runtime/current/package/dist/main.js</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>BORG_SERVER_DATA_DIR</key><string>${directory}/data</string><key>BORG_SERVER_PROCESS_MODE</key><string>managed</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
  }
  return `[Unit]
Description=Borg MCP server (ai.borgmcp.server)

[Service]
Type=simple
ExecStart="/usr/bin/node" "/old-runtime/current/package/dist/main.js" start
Environment="BORG_SERVER_DATA_DIR=${directory}/data"
Environment="BORG_SERVER_PROCESS_MODE=managed"
Restart=on-failure
RestartSec=2
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

async function uninstallFixture(platform: "launchd" | "systemd") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-service-uninstall-")));
  directories.push(directory);
  const dataDirectory = join(directory, "data");
  const runtimeDirectory = join(directory, "runtime");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const definition = createManagedServiceDefinition({
    platform,
    nodeExecutable: "/usr/bin/node",
    nodeVersion: "24.19.0",
    runtimeRoot: runtimeDirectory,
    dataDirectory,
    definitionPath: join(directory, platform,
      platform === "launchd" ? "ai.borgmcp.server.plist" : "ai.borgmcp.server.service"),
    ...(platform === "launchd" ? { launchdDomain: "gui/501" } : {}),
  });
  await mkdir(dirname(definition.definitionPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(definition.stdoutPath), { recursive: true, mode: 0o700 });
  await writeFile(definition.definitionPath, definition.content, { mode: 0o600 });
  const retained = new Map<string, string>([
    [join(dataDirectory, "server.db"), "database\n"],
    [join(dataDirectory, "server.json"), "identity\n"],
    [join(dataDirectory, "credential-digest.key"), "credential\n"],
    [join(runtimeDirectory, "current"), "runtime\n"],
    [definition.stdoutPath, "stdout\n"],
    [definition.stderrPath, "stderr\n"],
  ]);
  for (const [path, content] of retained) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
  const input = {
    definition,
    dataDirectory,
    inspectRuntime: async () => ({ running: false }),
    inspectService: async () => ({ state: "absent" as const, recoveryCommand: null }),
    run: async () => ({ stdout: "", stderr: "" }),
    probe: async () => identity,
    timeoutMs: 1_000,
  } satisfies ManagedServiceUninstallInput;
  return { directory, definition, retained, input };
}
