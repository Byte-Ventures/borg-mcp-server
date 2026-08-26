import { chmod, link, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectManagedServiceDefinition,
  installManagedService,
  ManagedServiceInstallError,
  type ManagedServiceInstallInput,
} from "../src/managed-service-install.js";
import { createManagedServiceDefinition } from "../src/managed-service.js";

const directories: string[] = [];
const integrity = `sha512-${"A".repeat(86)}==`;
const sourceSha = "a".repeat(40);
const artifact = Object.freeze({
  artifactDirectory: "/runtime/artifacts/verified",
  packageDirectory: "/runtime/artifacts/verified/package",
  version: "0.18.1",
  integrity,
  sourceSha,
  treeSha256: "b".repeat(64),
});
const identity = Object.freeze({
  package_version: artifact.version,
  artifact_integrity: artifact.integrity,
  source_sha: sourceSha,
  protocol_version: "13",
  started_at: "2026-08-14T12:00:00.000Z",
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("managed service installation", () => {
  it("atomically installs private definitions and log sinks, then resolves an exact retry", async () => {
    const fixture = await installationFixture();
    const commands: string[][] = [];
    const input = {
      ...fixture.input,
      run: vi.fn(async (command: readonly [string, ...string[]]) => {
        commands.push([...command]);
        return { stdout: "", stderr: "" };
      }),
    } satisfies ManagedServiceInstallInput;

    await expect(installManagedService(input)).resolves.toMatchObject({
      outcome: "installed",
      adapter: "systemd",
      artifact,
      runningIdentity: identity,
    });
    expect(commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "ai.borgmcp.server"],
    ]);
    expect(await readFile(fixture.definition.definitionPath, "utf8"))
      .toBe(fixture.definition.content);
    for (const path of [
      fixture.definition.definitionPath,
      fixture.definition.stdoutPath,
      fixture.definition.stderrPath,
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(join(fixture.directory, "data", "logs"))).mode & 0o777).toBe(0o700);

    commands.length = 0;
    await expect(installManagedService({
      ...input,
      inspectRuntime: async () => ({ running: true, mode: "managed", identity }),
      inspectService: async () => ({ state: "active", recoveryCommand: null }),
    })).resolves.toMatchObject({ outcome: "already-installed" });
    expect(commands).toEqual([]);
  });

  it("replaces only a private marker-bearing Borg-owned stale definition", async () => {
    const fixture = await installationFixture();
    const stale = fixture.definition.content
      .replace("UMask=0077\n", "")
      .replace(/^Standard(?:Output|Error)=.*\n/gmu, "")
      .replace(`${fixture.directory}/runtime/current/`, "/old-runtime/current/");
    await mkdir(join(fixture.directory, "systemd"), { recursive: true });
    await writeFile(fixture.definition.definitionPath, stale, { mode: 0o644 });
    let running = true;
    const commands: string[][] = [];

    await expect(installManagedService({
      ...fixture.input,
      inspectRuntime: async () => running
        ? { running: true, mode: "managed", identity: { ...identity, package_version: "0.17.0" } }
        : { running: false },
      inspectService: async () => ({ state: "active", recoveryCommand: null }),
      run: async (command) => {
        commands.push([...command]);
        if (command === fixture.definition.unload) running = false;
        return { stdout: "", stderr: "" };
      },
    })).resolves.toMatchObject({ outcome: "installed" });

    expect(commands[0]).toEqual(["systemctl", "--user", "stop", "ai.borgmcp.server"]);
    expect(await readFile(fixture.definition.definitionPath, "utf8"))
      .toBe(fixture.definition.content);
    expect((await lstat(fixture.definition.definitionPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses markerless definitions published by v0.18.1 without controller mutation", async () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const fixture = await installationFixture(platform);
      const legacy = legacyDefinition(fixture.directory, platform);
      await mkdir(join(fixture.directory, platform), { recursive: true });
      await writeFile(fixture.definition.definitionPath, legacy, { mode: 0o600 });
      const run = vi.fn();

      await expect(installManagedService({ ...fixture.input, run }))
        .rejects.toThrow("not recognized as Borg-owned");
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(fixture.definition.definitionPath, "utf8")).toBe(legacy);
    }
  });

  it("enables an existing inactive systemd user definition instead of only restarting it", async () => {
    const fixture = await installationFixture();
    await mkdir(join(fixture.directory, "systemd"), { recursive: true });
    await writeFile(fixture.definition.definitionPath, fixture.definition.content, { mode: 0o600 });
    const commands: string[][] = [];
    await installManagedService({
      ...fixture.input,
      inspectService: async () => ({
        state: "inactive",
        recoveryCommand: fixture.definition.recoverLoaded,
      }),
      run: async (command) => {
        commands.push([...command]);
        return { stdout: "", stderr: "" };
      },
    });
    expect(commands).toContainEqual([
      "systemctl", "--user", "enable", "--now", "ai.borgmcp.server",
    ]);
    expect(commands).not.toContainEqual([
      "systemctl", "--user", "restart", "ai.borgmcp.server",
    ]);
  });

  it("refuses foreground ownership and foreign or unsafe definitions before controller mutation", async () => {
    const fixture = await installationFixture();
    await mkdir(join(fixture.directory, "systemd"), { recursive: true });
    await writeFile(fixture.definition.definitionPath, "foreign service\n", { mode: 0o600 });
    const run = vi.fn();

    await expect(installManagedService({ ...fixture.input, run }))
      .rejects.toThrow("not recognized as Borg-owned");
    expect(run).not.toHaveBeenCalled();

    await writeFile(fixture.definition.definitionPath, fixture.definition.content);
    await chmod(fixture.definition.definitionPath, 0o620);
    await expect(installManagedService({ ...fixture.input, run }))
      .rejects.toThrow(fixture.definition.definitionPath);
    expect(run).not.toHaveBeenCalled();

    await chmod(fixture.definition.definitionPath, 0o600);
    await expect(installManagedService({
      ...fixture.input,
      inspectRuntime: async () => ({ running: true, mode: "foreground", identity }),
      run,
    })).rejects.toThrow("Ctrl-C");
    expect(run).not.toHaveBeenCalled();

    const outside = join(fixture.directory, "outside");
    const linked = join(fixture.directory, "linked-systemd");
    await mkdir(outside);
    await writeFile(join(outside, "ai.borgmcp.server.service"), fixture.definition.content, {
      mode: 0o600,
    });
    await symlink(outside, linked, "dir");
    await expect(installManagedService({
      ...fixture.input,
      definition: { ...fixture.definition, definitionPath: join(linked, "ai.borgmcp.server.service") },
      run,
    })).rejects.toThrow(join(linked, "ai.borgmcp.server.service"));
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses foreign-owned, symlinked, and group-writable definitions with exact remediation", async () => {
    const fixture = await installationFixture();
    await mkdir(dirname(fixture.definition.definitionPath), { recursive: true });
    await writeFile(fixture.definition.definitionPath, fixture.definition.content, { mode: 0o600 });
    const remediation = "owner-owned, single-link regular file no larger than 65536 bytes and mode 0600";

    await expect(inspectManagedServiceDefinition(
      fixture.definition,
      (process.getuid?.() ?? 0) + 1,
    )).rejects.toThrow(fixture.definition.definitionPath);

    await chmod(fixture.definition.definitionPath, 0o620);
    await expect(inspectManagedServiceDefinition(fixture.definition))
      .rejects.toThrow(remediation);

    await rm(fixture.definition.definitionPath);
    const target = join(fixture.directory, "foreign-definition");
    await writeFile(target, fixture.definition.content, { mode: 0o600 });
    await symlink(target, fixture.definition.definitionPath);
    await expect(inspectManagedServiceDefinition(fixture.definition))
      .rejects.toThrow(fixture.definition.definitionPath);
  });

  it("refuses an unbound controller before creating service files", async () => {
    const fixture = await installationFixture();
    const failure = new Error("controller definition mismatch");
    const run = vi.fn();

    await expect(installManagedService({
      ...fixture.input,
      assertControllerBinding: async () => { throw failure; },
      run,
    })).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
    await expect(lstat(fixture.definition.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fixture.definition.stdoutPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fixture.definition.stderrPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires canonical ownership markers and refuses hardlinked definitions and logs", async () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const fixture = await installationFixture(platform);
      await mkdir(dirname(fixture.definition.definitionPath), { recursive: true });
      const embeddedMarker = platform === "launchd"
        ? `<?xml version="1.0" encoding="UTF-8"?>\n<!-- not-${fixture.definition.ownershipMarker} -->\n<plist/>\n`
        : `# not-${fixture.definition.ownershipMarker}\n[Unit]\nDescription=foreign\n`;
      await writeFile(fixture.definition.definitionPath, embeddedMarker, { mode: 0o600 });
      await expect(installManagedService(fixture.input))
        .rejects.toThrow("not recognized as Borg-owned");
    }

    const definitionFixture = await installationFixture();
    await mkdir(dirname(definitionFixture.definition.definitionPath), { recursive: true });
    await writeFile(definitionFixture.definition.definitionPath, definitionFixture.definition.content, {
      mode: 0o600,
    });
    const definitionAlias = join(definitionFixture.directory, "definition-alias");
    await link(definitionFixture.definition.definitionPath, definitionAlias);
    const definitionRun = vi.fn();
    await expect(installManagedService({ ...definitionFixture.input, run: definitionRun }))
      .rejects.toThrow(definitionFixture.definition.definitionPath);
    expect(definitionRun).not.toHaveBeenCalled();
    expect(await readFile(definitionAlias, "utf8")).toBe(definitionFixture.definition.content);
    expect((await lstat(definitionAlias)).mode & 0o777).toBe(0o600);

    const logFixture = await installationFixture();
    await mkdir(dirname(logFixture.definition.stdoutPath), { recursive: true, mode: 0o700 });
    await writeFile(logFixture.definition.stdoutPath, "sentinel\n", { mode: 0o600 });
    const logAlias = join(logFixture.directory, "log-alias");
    await link(logFixture.definition.stdoutPath, logAlias);
    const logRun = vi.fn();
    await expect(installManagedService({ ...logFixture.input, run: logRun }))
      .rejects.toThrow("owner-owned regular files");
    expect(logRun).not.toHaveBeenCalled();
    expect(await readFile(logAlias, "utf8")).toBe("sentinel\n");
    expect((await lstat(logAlias)).mode & 0o777).toBe(0o600);
  });

  it("serializes concurrent installers without reclaiming an existing lock", async () => {
    const fixture = await installationFixture();
    await writeFile(join(fixture.directory, "data", "service-install.lock"), "123\n", { mode: 0o600 });
    const run = vi.fn();
    await expect(installManagedService({ ...fixture.input, run })).rejects.toThrow(
      "Another managed service installation is running.",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("removes a new definition and reports a safe stop when startup fails", async () => {
    const fixture = await installationFixture();
    await expect(installManagedService({
      ...fixture.input,
      run: async (command) => {
        if (command === fixture.definition.install) throw new Error("private controller error");
        return { stdout: "", stderr: "" };
      },
    })).rejects.toMatchObject({
      name: "ManagedServiceInstallError",
      recovery: "stopped",
      message: "Managed service installation did not complete.",
    });
    await expect(lstat(fixture.definition.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores and restarts a replaced Borg-owned definition after startup failure", async () => {
    const fixture = await installationFixture();
    const stale = `# ${fixture.definition.ownershipMarker}\n[Unit]\nold definition\n`;
    await mkdir(join(fixture.directory, "systemd"), { recursive: true });
    await writeFile(fixture.definition.definitionPath, stale, { mode: 0o600 });
    let running = true;
    let installAttempts = 0;
    const previousIdentity = { ...identity, package_version: "0.17.0" };

    let error: unknown;
    try {
      await installManagedService({
        ...fixture.input,
        inspectRuntime: async () => running
          ? { running: true, mode: "managed", identity: previousIdentity }
          : { running: false },
        inspectService: async () => ({ state: "active", recoveryCommand: null }),
        run: async (command) => {
          if (command === fixture.definition.unload || command === fixture.definition.rollbackRemove) {
            running = false;
          }
          if (command === fixture.definition.install) {
            installAttempts += 1;
            if (installAttempts === 1) throw new Error("private controller error");
            running = true;
          }
          return { stdout: "", stderr: "" };
        },
        probe: async () => ({ ...previousIdentity, started_at: "2026-08-14T13:00:00.000Z" }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ManagedServiceInstallError);
    expect(error).toMatchObject({ recovery: "restored" });
    expect(await readFile(fixture.definition.definitionPath, "utf8")).toBe(stale);
    expect(installAttempts).toBe(2);
  });

  it("reports failed recovery when rollback starts a different runtime identity", async () => {
    const fixture = await installationFixture();
    const stale = `# ${fixture.definition.ownershipMarker}\n[Unit]\nold definition\n`;
    await mkdir(join(fixture.directory, "systemd"), { recursive: true });
    await writeFile(fixture.definition.definitionPath, stale, { mode: 0o600 });
    let running = true;
    let installAttempts = 0;

    await expect(installManagedService({
      ...fixture.input,
      inspectRuntime: async () => running
        ? { running: true, mode: "managed", identity: { ...identity, package_version: "0.17.0" } }
        : { running: false },
      inspectService: async () => ({ state: "active", recoveryCommand: null }),
      run: async (command) => {
        if (command === fixture.definition.unload || command === fixture.definition.rollbackRemove) {
          running = false;
        }
        if (command === fixture.definition.install) {
          installAttempts += 1;
          if (installAttempts === 1) throw new Error("private controller error");
          running = true;
        }
        return { stdout: "", stderr: "" };
      },
      probe: async () => ({ ...identity, package_version: "9.9.9" }),
    })).rejects.toMatchObject({ recovery: "failed" });
    expect(await readFile(fixture.definition.definitionPath, "utf8")).toBe(stale);
  });
});

function legacyDefinition(
  directory: string,
  platform: "launchd" | "systemd",
  nodeExecutable = "/usr/bin/node",
  runtimeRoot = "/old-runtime",
): string {
  if (platform === "launchd") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.borgmcp.server</string>
  <key>ProgramArguments</key><array><string>${nodeExecutable}</string><string>${runtimeRoot}/current/package/dist/main.js</string><string>start</string></array>
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

async function installationFixture(platform: "launchd" | "systemd" = "systemd") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-service-install-")));
  directories.push(directory);
  const dataDirectory = join(directory, "data");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const definition = createManagedServiceDefinition({
    platform,
    nodeExecutable: "/usr/bin/node",
    nodeVersion: "24.19.0",
    runtimeRoot: join(directory, "runtime"),
    dataDirectory,
    definitionPath: join(directory, platform,
      platform === "launchd" ? "ai.borgmcp.server.plist" : "ai.borgmcp.server.service"),
    ...(platform === "launchd" ? { launchdDomain: "gui/501" } : {}),
  });
  const input = {
    definition,
    artifact,
    dataDirectory,
    assertInstallation: async () => undefined,
    assertControllerBinding: async () => undefined,
    inspectRuntime: async () => ({ running: false }),
    inspectService: async () => ({ state: "absent" as const, recoveryCommand: null }),
    run: async () => ({ stdout: "", stderr: "" }),
    probe: async () => identity,
    timeoutMs: 1_000,
  } satisfies ManagedServiceInstallInput;
  return { directory, definition, input };
}
