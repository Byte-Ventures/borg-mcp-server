import { describe, expect, it } from "vitest";

import { createManagedServiceDefinition } from "../src/managed-service.js";

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
    expect(service.install).toEqual(["systemctl", "--user", "enable", "--now", "ai.borgmcp.server"]);
    expect(service.status).toEqual([
      "systemctl",
      "--user",
      "show",
      "ai.borgmcp.server",
      "--property=LoadState,ActiveState,SubState,MainPID",
    ]);
    expect(service.content).not.toContain("checkout");
  });

  it("adds the sqlite warning suppression only for Node 22 managed starts", () => {
    const node22 = createManagedServiceDefinition({
      platform: "systemd",
      nodeExecutable: "/usr/bin/node",
      nodeVersion: "22.18.0",
      runtimeRoot: "/runtime",
      dataDirectory: "/data",
      definitionPath: "/service",
    });
    const node24 = createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/usr/bin/node",
      nodeVersion: "24.19.0",
      runtimeRoot: "/runtime",
      dataDirectory: "/data",
      definitionPath: "/service",
      launchdDomain: "gui/501",
    });

    expect(node22.content).toContain("--disable-warning=ExperimentalWarning");
    expect(node24.content).not.toContain("--disable-warning=ExperimentalWarning");
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
    expect(service.restart).toEqual([
      "launchctl", "kickstart", "-k", "gui/501/ai.borgmcp.server",
    ]);
    expect(service.stop).toEqual([
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
