import { describe, expect, it } from "vitest";

import { createManagedServiceDefinition } from "../src/managed-service.js";
import { runCli } from "../src/cli.js";
import type { ServerService } from "../src/service.js";

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
      "--property=LoadState,ActiveState,SubState,MainPID",
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
});
