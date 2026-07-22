import { describe, expect, it } from "vitest";

import { createManagedServiceDefinition } from "../src/managed-service.js";

describe("managed service adapters", () => {
  it("renders a portable systemd user service against the immutable current target", () => {
    const service = createManagedServiceDefinition({
      platform: "systemd",
      nodeExecutable: "/usr/bin/node",
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
    expect(service.content).not.toContain("checkout");
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
  });
});
