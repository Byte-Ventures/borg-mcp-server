import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createBoundManagedServiceRunner,
  createManagedServiceDefinition,
} from "../src/managed-service.js";
import { runCli } from "../src/cli.js";
import type { ServerService } from "../src/service.js";
import { managedServiceControllerMismatch, operatorErrors } from "../src/operator-error.js";

describe("managed service adapters", () => {
  it("renders a portable systemd user service against the immutable current target", () => {
    const service = createManagedServiceDefinition({
      platform: "systemd",
      nodeExecutable: "/usr/bin/node",
      nodeVersion: "24.19.0",
      runtimeRoot: "/home/operator/.borg/server-runtime",
      dataDirectory: "/home/operator/.borg/server",
      definitionPath: "/home/operator/.config/systemd/user/ai.borgmcp.server.service",
    });

    expect(service.content).toContain(
      'ExecStart="/usr/bin/node" "/home/operator/.borg/server-runtime/current/package/dist/main.js" start',
    );
    expect(service.content).toContain('Environment="BORG_SERVER_DATA_DIR=/home/operator/.borg/server"');
    expect(service.content).toContain('Environment="BORG_SERVER_PROCESS_MODE=managed"');
    expect(service.content).toContain("UMask=0077");
    expect(service.content).toContain(
      'StandardOutput="append:/home/operator/.borg/server/logs/managed.stdout.log"',
    );
    expect(service.content).toContain(
      'StandardError="append:/home/operator/.borg/server/logs/managed.stderr.log"',
    );
    expect(service.install).toEqual(["systemctl", "--user", "enable", "--now", "ai.borgmcp.server"]);
    expect(service.rollbackRemove).toEqual([
      "systemctl", "--user", "disable", "--now", "ai.borgmcp.server",
    ]);
    expect(service.reload).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(service.status).toEqual([
      "systemctl",
      "--user",
      "show",
      "ai.borgmcp.server",
      "--property=LoadState,ActiveState,SubState,MainPID,FragmentPath",
    ]);
    expect(service.content).not.toContain("checkout");
  });

  it("adds the sqlite warning suppression only for Node 22 managed starts", async () => {
    for (const [platform, nodeVersion, expected] of [
      ["systemd", "22.18.0", true],
      ["launchd", "22.18.0", true],
      ["systemd", "24.19.0", false],
      ["launchd", "24.19.0", false],
    ] as const) {
      const definition = createManagedServiceDefinition({
        platform,
        nodeExecutable: "/usr/bin/node",
        nodeVersion,
        runtimeRoot: "/runtime",
        dataDirectory: "/data",
        definitionPath: "/service",
        ...(platform === "launchd" ? { launchdDomain: "gui/501" } : {}),
      });
      expect(definition.content.includes("--disable-warning=ExperimentalWarning")).toBe(expected);
    }
    let directStartArgs: readonly string[] | undefined;
    await runCli(["start"], {
      start: async (args) => { directStartArgs = args; },
    } as ServerService, { stdout: () => undefined, stderr: () => undefined });
    expect(directStartArgs).toEqual([]);
    expect(directStartArgs).not.toContain("--disable-warning=ExperimentalWarning");
  });

  it("renders a thin launchd adapter with the same runtime and data contract", () => {
    const service = createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/opt/local/bin/node",
      runtimeRoot: "/Users/operator/.borg/server-runtime",
      dataDirectory: "/Users/operator/.borg/server & identity",
      definitionPath: "/Users/operator/Library/LaunchAgents/ai.borgmcp.server.plist",
      launchdDomain: "gui/501",
    });

    expect(service.content).toContain(
      "/Users/operator/.borg/server-runtime/current/package/dist/main.js",
    );
    expect(service.content).toContain("/Users/operator/.borg/server &amp; identity");
    expect(service.content).toContain("BORG_SERVER_PROCESS_MODE");
    expect(service.content).toContain("<key>Umask</key><integer>63</integer>");
    expect(service.content).toContain(
      "<key>StandardOutPath</key><string>/Users/operator/.borg/server &amp; identity/logs/managed.stdout.log</string>",
    );
    expect(service.content).toContain("borgmcp-server-owned:ai.borgmcp.server");
    expect(service.restart).toEqual([
      "launchctl", "kickstart", "-k", "gui/501/ai.borgmcp.server",
    ]);
    expect(service.unload).toEqual([
      "launchctl", "bootout", "gui/501/ai.borgmcp.server",
    ]);
    expect(service.content).not.toContain("Development");
  });

  it("rejects relative, multiline, and ambiguous platform inputs", () => {
    expect(() => createManagedServiceDefinition({
      platform: "systemd",
      nodeExecutable: "node",
      runtimeRoot: "/runtime",
      dataDirectory: "/data",
      definitionPath: "/service",
    })).toThrow("Managed service paths must be absolute and single-line.");
    expect(() => createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/node",
      runtimeRoot: "/runtime",
      dataDirectory: "/data\ninjected",
      definitionPath: "/service",
      launchdDomain: "system",
    })).toThrow();
    expect(() => createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/node",
      runtimeRoot: "/runtime",
      dataDirectory: "/data",
      definitionPath: "/service",
      launchdDomain: "gui/501",
      label: "invalid label",
    })).toThrow("Managed service label is invalid.");
    expect(() => createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/node",
      runtimeRoot: "/runtime",
      dataDirectory: "/data",
      definitionPath: "/service",
      launchdDomain: "gui/501",
      port: 70_000,
    })).toThrow("Managed service port is invalid.");
  });

  it("quotes systemd paths and escapes percent specifiers", () => {
    const definition = createManagedServiceDefinition({
      platform: "systemd",
      nodeExecutable: "/opt/Node Runtime/node",
      runtimeRoot: "/home/operator/100% runtime",
      dataDirectory: "/home/operator/100% data",
      definitionPath: "/home/operator/.config/systemd/user/ai.borgmcp.server.service",
    });
    expect(definition.content).toContain('ExecStart="/opt/Node Runtime/node"');
    expect(definition.content).toContain("/home/operator/100%% runtime/current/package/dist/main.js");
    expect(definition.content).toContain('Environment="BORG_SERVER_DATA_DIR=/home/operator/100%% data"');
    expect(definition.content).toContain('StandardOutput="append:/home/operator/100%% data/logs/managed.stdout.log"');
  });

  it("supports a bounded unique launchd label for isolated lifecycle exercises", () => {
    const definition = createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/usr/bin/node",
      runtimeRoot: "/private/runtime",
      dataDirectory: "/private/data",
      definitionPath: "/private/ai.borgmcp.server.test.plist",
      launchdDomain: "gui/501",
      label: "ai.borgmcp.server.test-154",
      port: 0,
    });

    expect(definition.label).toBe("ai.borgmcp.server.test-154");
    expect(definition.content).toContain(
      "<key>Label</key><string>ai.borgmcp.server.test-154</string>",
    );
    expect(definition.content).toContain("<string>--port</string><string>0</string>");
    expect(definition.status).toEqual([
      "launchctl",
      "print",
      "gui/501/ai.borgmcp.server.test-154",
    ]);
    expect(definition.recoverLoaded).toEqual([
      "launchctl",
      "kickstart",
      "gui/501/ai.borgmcp.server.test-154",
    ]);
  });

  it("refuses every mutating controller command when the loaded definition is foreign", async () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const expectedPath = platform === "launchd"
        ? "/isolated/Library/LaunchAgents/ai.borgmcp.server.plist"
        : "/isolated/.config/systemd/user/ai.borgmcp.server.service";
      const foreignPath = platform === "launchd"
        ? "/Users/operator/Library/LaunchAgents/ai.borgmcp.server.plist"
        : "/home/operator/.config/systemd/user/ai.borgmcp.server.service";
      const definition = createManagedServiceDefinition({
        platform,
        nodeExecutable: "/usr/bin/node",
        runtimeRoot: "/isolated/runtime",
        dataDirectory: "/isolated/data",
        definitionPath: expectedPath,
        ...(platform === "launchd" ? { launchdDomain: "gui/501" } : {}),
      });
      const commands: (readonly string[])[] = [];
      const run = async (command: readonly [string, ...string[]]) => {
        commands.push(command);
        if (command !== definition.status) throw new Error("Controller mutation escaped the ownership guard.");
        return {
          stdout: platform === "launchd"
            ? `path = ${foreignPath}\nstate = running\n`
            : `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nFragmentPath=${foreignPath}\n`,
          stderr: "",
        };
      };
      const bound = createBoundManagedServiceRunner(definition, run);
      const mismatch = managedServiceControllerMismatch(expectedPath, foreignPath);
      expect(mismatch.message).toContain(expectedPath);
      expect(mismatch.message).toContain(foreignPath);
      const mutations = [
        definition.install,
        definition.restart,
        definition.recoverLoaded,
        definition.unload,
        definition.rollbackRemove,
        ...(definition.reload === null ? [] : [definition.reload]),
      ];

      for (const command of mutations) {
        commands.length = 0;
        await expect(bound(command, new AbortController().signal)).rejects.toThrow(
          mismatch.message,
        );
        expect(commands).toEqual([definition.status]);
      }
    }
  });

  it("allows controller mutation only for the requested definition or an absent job", async () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "borg-managed-service-binding-")));
      const definitionPath = join(root, platform === "launchd"
        ? "ai.borgmcp.server.plist"
        : "ai.borgmcp.server.service");
      await writeFile(definitionPath, "fixture definition", { mode: 0o644 });
      const definition = createManagedServiceDefinition({
        platform,
        nodeExecutable: "/usr/bin/node",
        runtimeRoot: "/isolated/runtime",
        dataDirectory: "/isolated/data",
        definitionPath,
        ...(platform === "launchd" ? { launchdDomain: "gui/501" } : {}),
      });
      const commands: (readonly string[])[] = [];
      const run = async (command: readonly [string, ...string[]]) => {
        commands.push(command);
        if (command === definition.status) {
          return {
            stdout: platform === "launchd"
              ? `path = ${definition.definitionPath}\nstate = running\n`
              : `LoadState=loaded\nActiveState=active\nFragmentPath=${definition.definitionPath}\n`,
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      };

      await expect(createBoundManagedServiceRunner(definition, run)(
        definition.restart,
        new AbortController().signal,
      )).resolves.toEqual({ stdout: "", stderr: "" });
      expect(commands).toEqual([definition.status, definition.restart]);
      expect((await lstat(definitionPath)).mode & 0o777).toBe(0o600);

      commands.length = 0;
      await rm(definitionPath);
      await expect(createBoundManagedServiceRunner(definition, run)(
        definition.restart,
        new AbortController().signal,
      )).rejects.toThrow(
        `The managed service definition ${definitionPath} is unsafe. Replace it with an owner-owned, ` +
        "single-link regular file no larger than 65536 bytes and mode 0600, then retry.",
      );
      expect(commands).toEqual([definition.status]);

      commands.length = 0;
      const absentRun = async (command: readonly [string, ...string[]]) => {
        commands.push(command);
        if (command === definition.status) {
          if (platform === "launchd") throw Object.assign(new Error("not loaded"), { code: 113 });
          return { stdout: "LoadState=not-found\nFragmentPath=\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };
      await expect(createBoundManagedServiceRunner(definition, absentRun)(
        definition.install,
        new AbortController().signal,
      )).resolves.toEqual({ stdout: "", stderr: "" });
      expect(commands).toEqual([definition.status, definition.install]);

      commands.length = 0;
      const malformedRun = async (command: readonly [string, ...string[]]) => {
        commands.push(command);
        return {
          stdout: platform === "launchd"
            ? "state = running\n"
            : "LoadState=loaded\nActiveState=active\nFragmentPath=\n",
          stderr: "",
        };
      };
      await expect(createBoundManagedServiceRunner(definition, malformedRun)(
        definition.restart,
        new AbortController().signal,
      )).rejects.toBe(operatorErrors.MANAGED_SERVICE_CONTROLLER_FOREIGN);
      expect(commands).toEqual([definition.status]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a lexical controller match through a symlinked definition", async () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "borg-managed-service-symlink-")));
      const expectedPath = join(root, platform === "launchd"
        ? "ai.borgmcp.server.plist"
        : "ai.borgmcp.server.service");
      const foreignPath = join(root, "foreign-definition");
      const foreignContent = "foreign definition must remain unchanged";
      await writeFile(foreignPath, foreignContent, { mode: 0o600 });
      await symlink(foreignPath, expectedPath);
      const definition = createManagedServiceDefinition({
        platform,
        nodeExecutable: "/usr/bin/node",
        runtimeRoot: "/isolated/runtime",
        dataDirectory: "/isolated/data",
        definitionPath: expectedPath,
        ...(platform === "launchd" ? { launchdDomain: "gui/501" } : {}),
      });
      const commands: (readonly string[])[] = [];
      const run = async (command: readonly [string, ...string[]]) => {
        commands.push(command);
        if (command !== definition.status) throw new Error("Controller mutation escaped the symlink guard.");
        return {
          stdout: platform === "launchd"
            ? `path = ${expectedPath}\nstate = running\n`
            : `LoadState=loaded\nActiveState=active\nFragmentPath=${expectedPath}\n`,
          stderr: "",
        };
      };

      const bound = createBoundManagedServiceRunner(definition, run);
      const mutations = [
        definition.install,
        definition.restart,
        definition.recoverLoaded,
        definition.unload,
        definition.rollbackRemove,
        ...(definition.reload === null ? [] : [definition.reload]),
      ];
      for (const command of mutations) {
        commands.length = 0;
        await expect(bound(command, new AbortController().signal))
          .rejects.toMatchObject({
            code: "MANAGED_SERVICE_DEFINITION_UNSAFE",
            message: expect.stringContaining(expectedPath),
          });
        expect(commands).toEqual([definition.status]);
      }
      expect(await readFile(foreignPath, "utf8")).toBe(foreignContent);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses every launchd mutation when an absent job has a symlinked definition", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "borg-launchd-absent-symlink-")));
    const expectedPath = join(root, "ai.borgmcp.server.plist");
    const foreignPath = join(root, "foreign-definition");
    const foreignContent = "foreign definition must remain unchanged";
    await writeFile(foreignPath, foreignContent, { mode: 0o600 });
    await symlink(foreignPath, expectedPath);
    const definition = createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/usr/bin/node",
      runtimeRoot: "/isolated/runtime",
      dataDirectory: "/isolated/data",
      definitionPath: expectedPath,
      launchdDomain: "gui/501",
    });
    const commands: (readonly string[])[] = [];
    const run = async (command: readonly [string, ...string[]]) => {
      commands.push(command);
      if (command === definition.status) {
        throw Object.assign(new Error("not loaded"), { code: 113 });
      }
      throw new Error("Controller mutation escaped the absent-job symlink guard.");
    };
    const bound = createBoundManagedServiceRunner(definition, run);

    for (const command of [
      definition.install,
      definition.restart,
      definition.recoverLoaded,
      definition.unload,
      definition.rollbackRemove,
    ]) {
      commands.length = 0;
      await expect(bound(command, new AbortController().signal))
        .rejects.toMatchObject({
          code: "MANAGED_SERVICE_DEFINITION_UNSAFE",
          message: expect.stringContaining(expectedPath),
        });
      expect(commands).toEqual([definition.status]);
    }
    expect(await readFile(foreignPath, "utf8")).toBe(foreignContent);
    await rm(root, { recursive: true, force: true });
  });

  it("allows only the guarded systemd reload after removing its verified definition", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "borg-systemd-removal-")));
    const definitionPath = join(root, "ai.borgmcp.server.service");
    await writeFile(definitionPath, "fixture definition", { mode: 0o600 });
    const definition = createManagedServiceDefinition({
      platform: "systemd",
      nodeExecutable: "/usr/bin/node",
      runtimeRoot: "/isolated/runtime",
      dataDirectory: "/isolated/data",
      definitionPath,
    });
    const commands: (readonly string[])[] = [];
    const run = async (command: readonly [string, ...string[]]) => {
      commands.push(command);
      return command === definition.status
        ? {
            stdout: `LoadState=loaded\nActiveState=inactive\nFragmentPath=${definitionPath}\n`,
            stderr: "",
          }
        : { stdout: "", stderr: "" };
    };
    const bound = createBoundManagedServiceRunner(definition, run);

    await bound(definition.rollbackRemove, new AbortController().signal);
    await rm(definitionPath);
    await expect(bound(definition.reload!, new AbortController().signal))
      .resolves.toEqual({ stdout: "", stderr: "" });
    expect(commands).toEqual([
      definition.status,
      definition.rollbackRemove,
      definition.status,
      definition.reload,
    ]);
    await rm(root, { recursive: true, force: true });
  });
});
