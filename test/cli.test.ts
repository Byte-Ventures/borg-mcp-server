import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliIo, type ServerService } from "../src/index.js";
import { RuntimeUpdateFailure } from "../src/runtime-operator.js";

function createIo() {
  const stdout = vi.fn((_message: string): void => undefined);
  const stderr = vi.fn((_message: string): void => undefined);

  return { stdout, stderr } satisfies CliIo;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCli", () => {
  it("runs offline setup without starting a service or opening a listener", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const service: ServerService = {
      start: vi.fn(),
      setup: vi.fn().mockResolvedValue({
        bindHost: "192.168.1.20",
        initialInvitation: "b".repeat(43),
      }),
    };
    const io = createIo();

    const exitCode = await runCli(["setup"], service, io);

    expect(exitCode).toBe(0);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.setup).toHaveBeenCalledWith({ reinitialize: false });
    expect(listen).not.toHaveBeenCalled();
    expect(io.stdout).toHaveBeenCalledWith(
      "Local server setup completed.\nYour server data and identity are ready.\nPrepared bind address: 192.168.1.20\nThis address is written into the server certificate.\nNext, run:\n  borg-mcp-server start\nLeave that terminal open while the server is running.\nAfter installing the borg client, open a second terminal in your Git repository and run:\n  borg assimilate",
    );
  });

  it("renders repeated setup without replaying credentials", async () => {
    const service: ServerService = {
      start: vi.fn(),
      setup: vi.fn().mockResolvedValue({
        existing: true,
        bindHost: "::1",
        artifact: {
          version: "0.1.8",
          integrity: `sha512-${"A".repeat(86)}==`,
          sourceSha: "a".repeat(40),
        },
      }),
    };
    const io = createIo();

    expect(await runCli(["setup"], service, io)).toBe(0);
    const output = io.stdout.mock.calls[0]![0];
    expect(output).toBe(
      "Your local server is already prepared.\nYour server data and identity are unchanged.\nPrepared bind address: ::1\nThis address is written into the server certificate.\nSetup did not start the server.\nNext, run:\n  borg-mcp-server start\nLeave that terminal open while the server is running.",
    );
    expect(output).not.toMatch(/credential|invitation/iu);
  });

  it("suppresses standalone next steps for client-owned onboarding", async () => {
    const service: ServerService = {
      start: vi.fn(),
      setup: vi.fn().mockResolvedValue({
        bindHost: "127.0.0.1",
        initialInvitation: "b".repeat(43),
      }),
    };
    const io = createIo();
    const previous = process.env["BORG_CLIENT_ONBOARDING"];
    process.env["BORG_CLIENT_ONBOARDING"] = "1";
    try {
      expect(await runCli(["setup"], service, io)).toBe(0);
      expect(io.stdout).toHaveBeenCalledWith(
        "Local server setup completed.\nYour server data and identity are ready.\nPrepared bind address: 127.0.0.1\nThis address is written into the server certificate.",
      );

      const existingIo = createIo();
      const existingService: ServerService = {
        start: vi.fn(),
        setup: vi.fn().mockResolvedValue({
          existing: true,
          bindHost: "192.168.1.20",
          artifact: { version: "0.17.0", integrity: "sha512-safe", sourceSha: "abc123" },
        }),
      };
      expect(await runCli(["setup"], existingService, existingIo)).toBe(0);
      expect(existingIo.stdout).toHaveBeenCalledWith(
        "Your local server is already prepared.\nYour server data and identity are unchanged.\nPrepared bind address: 192.168.1.20\nThis address is written into the server certificate.\nSetup did not start the server.",
      );
    } finally {
      if (previous === undefined) delete process.env["BORG_CLIENT_ONBOARDING"];
      else process.env["BORG_CLIENT_ONBOARDING"] = previous;
    }
  });

  it("renders the bounded non-interactive setup record without secrets", async () => {
    const service: ServerService = {
      start: vi.fn(),
      setup: vi.fn().mockResolvedValue({
        existing: true,
        bindHost: "192.168.1.20",
        artifact: { version: "0.1.8", integrity: "sha512-safe", sourceSha: "abc123" },
      }),
    };
    const io = { ...createIo(), isTTY: false };
    expect(await runCli(["setup"], service, io)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(JSON.stringify({
      status: "prepared",
      artifact: "borgmcp-server@0.1.8",
      build_identity: "abc123",
      bind_host: "192.168.1.20",
      owner_access: "prepared",
      process: "stopped",
    }));
  });

  it("creates an invitation only in an interactive terminal with the approved copy", async () => {
    const invite = vi.fn().mockResolvedValue({
      invitation: "i".repeat(180),
      endpoint: "https://127.0.0.1:7091",
      loopbackOnly: true,
    });
    const interactive = { ...createIo(), isTTY: true };
    expect(await runCli(["invite", "Alice laptop"], { start: vi.fn(), invite }, interactive)).toBe(0);
    expect(invite).toHaveBeenCalledWith("Alice laptop");
    expect(interactive.stdout).toHaveBeenCalledWith(
      `Client enrollment invitation (single-use, shown once): ${"i".repeat(180)}\n` +
      "Share it only with the intended recipient.\n" +
      "This invitation works only on this machine. For another machine, run cert-reissue, restart, then mint again.",
    );

    const nonInteractive = { ...createIo(), isTTY: false };
    expect(await runCli(["invite"], { start: vi.fn(), invite }, nonInteractive)).toBe(1);
    expect(nonInteractive.stderr).toHaveBeenCalledWith(
      "Invitation creation requires an interactive terminal.",
    );
    expect(invite).toHaveBeenCalledTimes(1);
    expect(await runCli(
      ["invite", "too", "many"],
      { start: vi.fn(), invite },
      { ...createIo(), isTTY: true },
    )).toBe(1);
  });

  it("reissues a certificate for a private-LAN host without exposing reinitialize", async () => {
    const reissueCertificate = vi.fn().mockResolvedValue({
      caFingerprint: "a".repeat(64),
      hosts: ["127.0.0.1", "192.168.1.20"],
    });
    const io = createIo();

    expect(await runCli(["cert-reissue", "--host", "192.168.1.20"], {
      start: vi.fn(),
      reissueCertificate,
    }, io)).toBe(0);
    expect(reissueCertificate).toHaveBeenCalledWith("192.168.1.20");
    expect(io.stdout).toHaveBeenCalledWith(
      "Server certificate reissued for 127.0.0.1, 192.168.1.20.\n" +
      "Next: restart the server with `borg server start --host 192.168.1.20 --lan`.",
    );
    expect(await runCli(["cert-reissue", "--reinitialize"], {
      start: vi.fn(),
      reissueCertificate,
    }, createIo())).toBe(1);
  });

  it("requires an explicit unambiguous setup reinitialization flag", async () => {
    const setup = vi.fn().mockResolvedValue({
      initialInvitation: "b".repeat(43),
    });
    const service: ServerService = { start: vi.fn(), setup };

    expect(await runCli(["setup", "--reinitialize"], service, createIo())).toBe(0);
    expect(setup).toHaveBeenCalledWith({ reinitialize: true });
    setup.mockClear();
    expect(await runCli(["setup", "--reinitialize", "--reinitialize"], service, createIo())).toBe(1);
    expect(await runCli(["setup", "--force"], service, createIo())).toBe(1);
    expect(setup).not.toHaveBeenCalled();

    const help = createIo();
    expect(await runCli(["help"], service, help)).toBe(0);
    expect(help.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "--reinitialize   Recreate the database and leaf identity; preserve the CA when present",
    ));
  });

  it("delegates explicit start to the service boundary", async () => {
    const service: ServerService = { start: vi.fn().mockResolvedValue(undefined) };

    const exitCode = await runCli(["start", "--lan"], service, createIo());

    expect(exitCode).toBe(0);
    expect(service.start).toHaveBeenCalledWith(["--lan"]);
  });

  it("delegates the local dashboard with only the strict ASCII option", async () => {
    const dashboard = vi.fn().mockResolvedValue(undefined);
    const service: ServerService = { start: vi.fn(), dashboard };

    expect(await runCli(["dashboard"], service, createIo())).toBe(0);
    expect(dashboard).toHaveBeenLastCalledWith({ ascii: false });
    expect(await runCli(["dashboard", "--ascii"], service, createIo())).toBe(0);
    expect(dashboard).toHaveBeenLastCalledWith({ ascii: true });
    expect(await runCli(["dashboard", "--ascii", "--ascii"], service, createIo())).toBe(1);
    expect(await runCli(["dashboard", "--host", "127.0.0.1"], service, createIo())).toBe(1);
    expect(dashboard).toHaveBeenCalledTimes(2);
  });

  it("renders approved exact runtime evidence and bounded non-TTY JSON without guessing", async () => {
    const status = vi.fn().mockResolvedValue({
      status: "running",
      controllerVersion: "0.17.0",
      preparedArtifact: { version: "0.1.8", integrity: `sha512-${"A".repeat(86)}==` },
      runningArtifact: null,
      buildIdentity: null,
      endpoint: "https://127.0.0.1:7091",
      mode: "managed",
      serviceAdapter: "launchd",
      dataIdentity: "available",
      nextAction: { kind: "update-runtime" },
    });
    const service: ServerService = { start: vi.fn(), status };
    const tty = { ...createIo(), isTTY: true };
    const machine = { ...createIo(), isTTY: false };

    expect(await runCli(["status"], service, tty)).toBe(0);
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "Local server is reachable, but its running build identity is unavailable.",
    ));
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining("Build identity: unavailable"));
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining("Mode: managed (launchd)"));
    expect(await runCli(["status"], service, machine)).toBe(0);
    expect(JSON.parse(machine.stdout.mock.calls[0]![0])).toEqual({
      status: "running",
      installed_controller: "borgmcp-server@0.17.0",
      prepared_runtime: "borgmcp-server@0.1.8",
      prepared_integrity: `sha512-${"A".repeat(86)}==`,
      running_runtime: null,
      running_integrity: null,
      build_identity: null,
      endpoint: "https://127.0.0.1:7091",
      mode: "managed",
      service_adapter: "launchd",
      service_state: "active",
      service_recovery: null,
      runtime_lock: { state: "clear" },
      data_identity: "available",
      next_action: "borg-mcp-server update",
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("returns typed stale-lock and inactive-service recovery evidence instead of a generic failure", async () => {
    const status = vi.fn().mockResolvedValue({
      status: "stopped",
      controllerVersion: "0.17.0",
      preparedArtifact: {
        version: "0.17.0",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
      runningArtifact: null,
      buildIdentity: null,
      endpoint: null,
      mode: "stopped",
      serviceAdapter: "launchd",
      serviceState: "inactive",
      serviceRecoveryCommand: [
        "launchctl",
        "bootstrap",
        "gui/501",
        "/Users/Test Operator/Library/LaunchAgents/ai.borgmcp.server.plist",
      ],
      runtimeLock: {
        state: "stale",
        pid: 77_814,
        processState: "absent",
        identity: {
          package_version: "0.17.0",
          artifact_integrity: `sha512-${"A".repeat(86)}==`,
          source_sha: "a".repeat(40),
          protocol_version: "8",
          started_at: "2026-07-26T12:00:00.000Z",
        },
        endpoint: "https://127.0.0.1:7091",
        mode: "foreground",
        recoveryAction: "borg-mcp-server recover-stale-lock",
      },
      dataIdentity: "available",
      nextAction: null,
    });
    const service: ServerService = { start: vi.fn(), status };
    const machine = { ...createIo(), isTTY: false };
    const tty = { ...createIo(), isTTY: true };

    expect(await runCli(["status", "--json"], service, machine)).toBe(1);
    expect(JSON.parse(machine.stdout.mock.calls[0]![0])).toMatchObject({
      status: "stopped",
      service_adapter: "launchd",
      service_state: "inactive",
      service_recovery: {
        kind: "run-platform-command",
        command: [
          "launchctl",
          "bootstrap",
          "gui/501",
          "/Users/Test Operator/Library/LaunchAgents/ai.borgmcp.server.plist",
        ],
      },
      runtime_lock: {
        state: "stale",
        pid: 77_814,
        process_state: "absent",
        runtime: "borgmcp-server@0.17.0",
        recovery_action: "borg-mcp-server recover-stale-lock",
      },
    });
    expect(await runCli(["status"], service, tty)).toBe(1);
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "Recovery: borg-mcp-server recover-stale-lock",
    ));
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "Service recovery: launchctl bootstrap gui/501 '/Users/Test Operator/Library/LaunchAgents/ai.borgmcp.server.plist'",
    ));
  });

  it("preserves a stale lock only through the explicit recovery command", async () => {
    const recoverStaleLock = vi.fn().mockResolvedValue({
      backupPath: "/Users/operator/.borg/server/runtime.lock.stale-preserved",
      stale: {
        pid: 77_814,
        identity: {
          package_version: "0.17.0",
          artifact_integrity: `sha512-${"A".repeat(86)}==`,
          source_sha: "a".repeat(40),
          protocol_version: "8",
          started_at: "2026-07-26T12:00:00.000Z",
        },
        endpoint: null,
        mode: "foreground",
      },
    });
    const service: ServerService = { start: vi.fn(), recoverStaleLock };
    const machine = { ...createIo(), isTTY: false };

    expect(await runCli(["recover-stale-lock", "--json"], service, machine)).toBe(0);
    expect(JSON.parse(machine.stdout.mock.calls[0]![0])).toEqual({
      status: "recovered",
      previous_pid: 77_814,
      process_state: "absent",
      preserved_lock: "/Users/operator/.borg/server/runtime.lock.stale-preserved",
      process: "stopped",
      next_action: "borg-mcp-server status",
    });
    expect(recoverStaleLock).toHaveBeenCalledOnce();
    expect(await runCli(["recover-stale-lock", "--force"], service, machine)).toBe(1);
    expect(recoverStaleLock).toHaveBeenCalledOnce();
  });

  it("renders the exact controller completion action from status in both output modes", async () => {
    const status = vi.fn().mockResolvedValue({
      status: "running",
      controllerVersion: "0.2.0",
      preparedArtifact: {
        version: "0.17.0",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
      runningArtifact: {
        version: "0.17.0",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
      buildIdentity: "a".repeat(40),
      endpoint: "https://127.0.0.1:7091",
      mode: "managed",
      serviceAdapter: "launchd",
      dataIdentity: "available",
      nextAction: { kind: "install-controller", version: "0.17.0" },
    });
    const service: ServerService = { start: vi.fn(), status };
    const tty = { ...createIo(), isTTY: true };
    const machine = { ...createIo(), isTTY: false };

    expect(await runCli(["status"], service, tty)).toBe(0);
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "Next: npm install --global borgmcp-server@0.17.0.",
    ));
    expect(await runCli(["status", "--json"], service, machine)).toBe(0);
    expect(JSON.parse(machine.stdout.mock.calls[0]![0])).toMatchObject({
      installed_controller: "borgmcp-server@0.2.0",
      running_runtime: "borgmcp-server@0.17.0",
      next_action: "npm install --global borgmcp-server@0.17.0",
    });
  });

  it("reports the installed controller version and stops managed service idempotently", async () => {
    const versionIo = { ...createIo(), isTTY: true };
    expect(await runCli(["--version"], { start: vi.fn() }, versionIo)).toBe(0);
    expect(versionIo.stdout).toHaveBeenCalledWith("borgmcp-server@0.17.0");

    const stop = vi.fn()
      .mockResolvedValueOnce({ outcome: "stopped" })
      .mockResolvedValueOnce({ outcome: "already-stopped" })
      .mockResolvedValueOnce({ outcome: "foreground-action-required" });
    const service: ServerService = { start: vi.fn(), stop };
    const tty = { ...createIo(), isTTY: true };
    expect(await runCli(["stop"], service, tty)).toBe(0);
    expect(tty.stdout).toHaveBeenLastCalledWith(expect.stringContaining("Managed local server stopped."));
    expect(await runCli(["stop"], service, tty)).toBe(0);
    expect(tty.stdout).toHaveBeenLastCalledWith(expect.stringContaining("already stopped"));
    expect(await runCli(["stop"], service, tty)).toBe(1);
    expect(tty.stdout).toHaveBeenLastCalledWith(expect.stringContaining("Ctrl-C"));
  });

  it("renders bounded verification and rollback failures without raw errors", async () => {
    const tty = createIo();
    const verification: ServerService = {
      start: vi.fn(),
      update: vi.fn().mockRejectedValue(new RuntimeUpdateFailure("ARTIFACT_VERIFICATION_FAILED")),
    };
    expect(await runCli(["update"], verification, tty)).toBe(1);
    expect(tty.stderr).toHaveBeenCalledWith(
      "Update stopped: artifact verification failed.\nNo activation occurred.\nThe last verified runtime remains available.\nNext: borg-mcp-server status",
    );

    const machine = { ...createIo(), isTTY: false };
    const rollback: ServerService = {
      start: vi.fn(),
      update: vi.fn().mockRejectedValue(new RuntimeUpdateFailure("ACTIVATION_FAILED", "restored")),
    };
    expect(await runCli(["update"], rollback, machine)).toBe(1);
    expect(JSON.parse(machine.stdout.mock.calls[0]![0])).toEqual({
      status: "failed",
      error_code: "ACTIVATION_FAILED",
      recovery: "restored",
      data_identity: "preserved",
    });
    expect(machine.stderr).not.toHaveBeenCalled();
  });

  it("renders approved verified update evidence without exposing raw artifact locations", async () => {
    const update = vi.fn().mockResolvedValue({
      outcome: "updated",
      artifact: {
        artifactDirectory: "/private/runtime/artifacts/secret",
        packageDirectory: "/private/runtime/artifacts/secret/package",
        version: "0.17.0",
        integrity: `sha512-${"A".repeat(86)}==`,
        sourceSha: "a".repeat(40),
      },
      runningIdentity: {
        package_version: "0.17.0",
        artifact_integrity: `sha512-${"A".repeat(86)}==`,
        source_sha: "a".repeat(40),
        protocol_version: "8",
        started_at: "2026-07-21T12:00:00.000Z",
      },
      dataIdentity: "preserved",
      controllerVersion: "0.17.0",
      nextAction: null,
    });
    const service: ServerService = { start: vi.fn(), update };
    const io = { ...createIo(), isTTY: true };

    expect(await runCli(["update"], service, io)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(expect.stringContaining("Artifact verified and activated."));
    expect(io.stdout).toHaveBeenCalledWith(expect.stringContaining("Data and identity: preserved"));
    expect(io.stdout.mock.calls[0]![0]).not.toContain("/private/runtime");
  });

  it("keeps an inactive managed definition stopped and names its exact platform recovery", async () => {
    const recoveryCommand = [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/operator/Library/LaunchAgents/ai.borgmcp.server.plist",
    ] as const;
    const update = vi.fn().mockResolvedValue({
      outcome: "prepared",
      artifact: {
        artifactDirectory: "/runtime/artifacts/candidate",
        packageDirectory: "/runtime/artifacts/candidate/package",
        version: "0.17.0",
        integrity: `sha512-${"A".repeat(86)}==`,
        sourceSha: "a".repeat(40),
        treeSha256: "b".repeat(64),
      },
      runningIdentity: null,
      dataIdentity: "preserved",
      controllerVersion: "0.17.0",
      serviceAdapter: "launchd",
      serviceState: "inactive",
      serviceRecoveryCommand: recoveryCommand,
      nextAction: null,
    });
    const service: ServerService = { start: vi.fn(), update };
    const tty = { ...createIo(), isTTY: true };
    const machine = { ...createIo(), isTTY: false };

    expect(await runCli(["update"], service, tty)).toBe(0);
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "Managed service: inactive (launchd)",
    ));
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "Service recovery: launchctl bootstrap gui/501 /Users/operator/Library/LaunchAgents/ai.borgmcp.server.plist",
    ));
    expect(await runCli(["update", "--json"], service, machine)).toBe(0);
    expect(JSON.parse(machine.stdout.mock.calls[0]![0])).toMatchObject({
      status: "prepared",
      running_runtime: null,
      mode: "stopped",
      service_adapter: "launchd",
      service_state: "inactive",
      service_recovery: {
        kind: "run-platform-command",
        command: recoveryCommand,
      },
    });
  });

  it("makes a newer runtime's remaining controller install explicit in TTY and JSON", async () => {
    const update = vi.fn().mockResolvedValue({
      outcome: "updated",
      artifact: {
        artifactDirectory: "/runtime/artifacts/candidate",
        packageDirectory: "/runtime/artifacts/candidate/package",
        version: "0.17.0",
        integrity: `sha512-${"A".repeat(86)}==`,
        sourceSha: "a".repeat(40),
        treeSha256: "b".repeat(64),
      },
      runningIdentity: {
          package_version: "0.17.0",
        artifact_integrity: `sha512-${"A".repeat(86)}==`,
        source_sha: "a".repeat(40),
        protocol_version: "8",
        started_at: "2026-07-26T12:00:00.000Z",
      },
      dataIdentity: "preserved",
      controllerVersion: "0.2.0",
      nextAction: { kind: "install-controller", version: "0.17.0" },
    });
    const service: ServerService = { start: vi.fn(), update };
    const tty = { ...createIo(), isTTY: true };
    const machine = { ...createIo(), isTTY: false };

    expect(await runCli(["update"], service, tty)).toBe(0);
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "Installed controller remains: borgmcp-server@0.2.0",
    ));
    expect(tty.stdout).toHaveBeenCalledWith(expect.stringContaining(
      "Next: npm install --global borgmcp-server@0.17.0",
    ));

    expect(await runCli(["update"], service, machine)).toBe(0);
    expect(JSON.parse(machine.stdout.mock.calls[0]![0])).toMatchObject({
      status: "updated",
      installed_controller: "borgmcp-server@0.2.0",
      artifact: "borgmcp-server@0.17.0",
      running_runtime: "borgmcp-server@0.17.0",
      next_action: "npm install --global borgmcp-server@0.17.0",
    });
  });

  it("rotates and revokes clients only through explicit offline commands", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const rotateClient = vi.fn().mockResolvedValue("r".repeat(43));
    const revokeClient = vi.fn().mockResolvedValue(undefined);
    const service: ServerService = { start: vi.fn(), rotateClient, revokeClient };
    const rotateIo = createIo();
    const revokeIo = createIo();
    const clientId = "00000000-0000-4000-8000-000000000001";

    expect(await runCli(["client-rotate", clientId], service, rotateIo)).toBe(0);
    expect(await runCli(["client-revoke", clientId], service, revokeIo)).toBe(0);

    expect(rotateClient).toHaveBeenCalledWith(clientId);
    expect(revokeClient).toHaveBeenCalledWith(clientId);
    expect(rotateIo.stdout).toHaveBeenCalledWith(expect.stringContaining("shown once"));
    expect(revokeIo.stdout).toHaveBeenCalledWith("Client revoked.");
    expect(service.start).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("lists sanitized client identities, states, handles, and grants", async () => {
    const listClients = vi.fn().mockResolvedValue([
      {
        name: "Alice\u001b]8;;https://attacker.invalid\u0007 laptop",
        handle: "aaaaaaaa1",
        state: "active" as const,
        grants: [{
          cubeId: "00000000-0000-4000-8000-000000000051",
          cubeName: "Release\u001b[31m cube",
          access: "manage" as const,
        }],
      },
      {
        name: "Local client",
        handle: "aaaaaaaa2",
        state: "revoked" as const,
        grants: [],
      },
    ]);
    const service: ServerService = { start: vi.fn(), listClients };
    const io = createIo();

    expect(await runCli(["client-list"], service, io)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith([
      "Alice laptop [aaaaaaaa1] active",
      "  manage  Release cube (00000000-0000-4000-8000-000000000051)",
      "Local client [aaaaaaaa2] revoked",
      "  No cube grants.",
    ].join("\n"));
    expect(JSON.stringify(io.stdout.mock.calls)).not.toContain("\u001b");
    expect(listClients).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed offline credential commands without exposing a service", async () => {
    const service: ServerService = {
      start: vi.fn(),
      rotateClient: vi.fn(),
      revokeClient: vi.fn(),
    };

    expect(await runCli(["client-rotate"], service, createIo())).toBe(1);
    expect(await runCli(["client-revoke", "one", "two"], service, createIo())).toBe(1);
    expect(service.rotateClient).not.toHaveBeenCalled();
    expect(service.revokeClient).not.toHaveBeenCalled();
  });

  it("does not print a credential when offline rotation fails", async () => {
    const io = createIo();
    const service: ServerService = {
      start: vi.fn(),
      rotateClient: vi.fn().mockRejectedValue(new Error("Client does not exist.")),
    };

    await expect(runCli([
      "client-rotate",
      "00000000-0000-4000-8000-000000000001",
    ], service, io)).rejects.toThrow("Client does not exist.");
    expect(io.stdout).not.toHaveBeenCalled();
  });

  it("prints help without starting the service", async () => {
    const service: ServerService = { start: vi.fn() };
    const io = createIo();

    const exitCode = await runCli([], service, io);

    expect(exitCode).toBe(0);
    expect(service.start).not.toHaveBeenCalled();
    expect(io.stdout).toHaveBeenCalledOnce();
  });

  it("describes client administration as live-safe in help", async () => {
    const service: ServerService = { start: vi.fn() };
    const io = createIo();

    expect(await runCli(["help"], service, io)).toBe(0);

    const help = io.stdout.mock.calls[0]![0];
    expect(help).toContain("client-rotate <client-id>  Rotate one client credential while the server is live");
    expect(help).toContain("client-list  List clients, ID-derived handles, states, and cube grants while the server is live");
    expect(help).toContain("client-revoke <client-name-or-handle>  Revoke one client and its credentials while the server is live");
    expect(help).toContain("client-grant <client-name-or-handle> <cube-id> <read|write|manage>  Set one cube grant while the server is live");
    expect(help).toContain("client-ungrant <client-name-or-handle> <cube-id>  Remove one cube grant while the server is live");
    expect(help).toContain("Client listing, rotation, revocation, and grant changes are operator-only\nlive-safe operations; the running server observes committed changes on the next\nrequest.");
    expect(help).toContain("Stop the server before setup or reinitialization.");
    expect(help).not.toContain("Rotate one client credential offline");
    expect(help).not.toContain("Stop the server before\nsetup, rotation, revocation, grant changes, or reinitialization.");
  });

  it("rejects unknown commands", async () => {
    const service: ServerService = { start: vi.fn() };
    const io = createIo();

    const exitCode = await runCli(["unknown"], service, io);

    expect(exitCode).toBe(1);
    expect(service.start).not.toHaveBeenCalled();
    expect(io.stderr).toHaveBeenCalledWith("Unknown command.");
  });
});
