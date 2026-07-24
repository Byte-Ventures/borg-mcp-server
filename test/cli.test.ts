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
        recoveryCredential: "a".repeat(43),
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
      "Local server setup completed.\nArtifact: unavailable\nLocal owner access: prepared.\nNo server process started.\nNext: start the server, then run borg assimilate.",
    );
  });

  it("renders repeated setup without replaying credentials", async () => {
    const service: ServerService = {
      start: vi.fn(),
      setup: vi.fn().mockResolvedValue({
        existing: true,
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
      `Local server is already prepared.\nArtifact: borgmcp-server@0.1.8 (sha512-${"A".repeat(86)}==)\nBuild identity: ${"a".repeat(40)}\nData and identity: unchanged\nNo server process started.\nNext: borg-mcp-server start`,
    );
    expect(output).not.toMatch(/credential|invitation/iu);
  });

  it("renders the bounded non-interactive setup record without secrets", async () => {
    const service: ServerService = {
      start: vi.fn(),
      setup: vi.fn().mockResolvedValue({
        existing: true,
        artifact: { version: "0.1.8", integrity: "sha512-safe", sourceSha: "abc123" },
      }),
    };
    const io = { ...createIo(), isTTY: false };
    expect(await runCli(["setup"], service, io)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(JSON.stringify({
      status: "prepared",
      artifact: "borgmcp-server@0.1.8",
      build_identity: "abc123",
      owner_access: "prepared",
      process: "stopped",
    }));
  });

  it("creates an invitation only in an interactive terminal with the approved copy", async () => {
    const invite = vi.fn().mockResolvedValue("i".repeat(43));
    const interactive = { ...createIo(), isTTY: true };
    expect(await runCli(["invite"], { start: vi.fn(), invite }, interactive)).toBe(0);
    expect(interactive.stdout).toHaveBeenCalledWith(
      `Invitation (single-use; shown once): ${"i".repeat(43)}\nShare it only with the intended recipient.`,
    );

    const nonInteractive = { ...createIo(), isTTY: false };
    expect(await runCli(["invite"], { start: vi.fn(), invite }, nonInteractive)).toBe(1);
    expect(nonInteractive.stderr).toHaveBeenCalledWith(
      "Invitation creation requires an interactive terminal.",
    );
    expect(invite).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit unambiguous setup reinitialization flag", async () => {
    const setup = vi.fn().mockResolvedValue({
      recoveryCredential: "a".repeat(43),
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
      "--reinitialize   Destroy and recreate the existing server identity and database",
    ));
  });

  it("delegates explicit start to the service boundary", async () => {
    const service: ServerService = { start: vi.fn().mockResolvedValue(undefined) };

    const exitCode = await runCli(["start", "--lan"], service, createIo());

    expect(exitCode).toBe(0);
    expect(service.start).toHaveBeenCalledWith(["--lan"]);
  });

  it("renders approved exact runtime evidence and bounded non-TTY JSON without guessing", async () => {
    const status = vi.fn().mockResolvedValue({
      status: "running",
      controllerVersion: "0.1.19",
      preparedArtifact: { version: "0.1.8", integrity: `sha512-${"A".repeat(86)}==` },
      runningArtifact: null,
      buildIdentity: null,
      endpoint: "https://127.0.0.1:7091",
      mode: "managed",
      serviceAdapter: "launchd",
      dataIdentity: "available",
      nextAction: "borg-mcp-server update",
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
      installed_controller: "borgmcp-server@0.1.19",
      prepared_runtime: "borgmcp-server@0.1.8",
      prepared_integrity: `sha512-${"A".repeat(86)}==`,
      running_runtime: null,
      running_integrity: null,
      build_identity: null,
      endpoint: "https://127.0.0.1:7091",
      mode: "managed",
      service_adapter: "launchd",
      data_identity: "available",
      next_action: "borg-mcp-server update",
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("reports the installed controller version and stops managed service idempotently", async () => {
    const versionIo = { ...createIo(), isTTY: true };
    expect(await runCli(["--version"], { start: vi.fn() }, versionIo)).toBe(0);
    expect(versionIo.stdout).toHaveBeenCalledWith("borgmcp-server@0.1.19");

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
        version: "0.2.0",
        integrity: `sha512-${"A".repeat(86)}==`,
        sourceSha: "a".repeat(40),
      },
      runningIdentity: {
        package_version: "0.2.0",
        artifact_integrity: `sha512-${"A".repeat(86)}==`,
        source_sha: "a".repeat(40),
        protocol_version: "4",
        started_at: "2026-07-21T12:00:00.000Z",
      },
      dataIdentity: "preserved",
    });
    const service: ServerService = { start: vi.fn(), update };
    const io = { ...createIo(), isTTY: true };

    expect(await runCli(["update"], service, io)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(expect.stringContaining("Artifact verified and activated."));
    expect(io.stdout).toHaveBeenCalledWith(expect.stringContaining("Data and identity: preserved"));
    expect(io.stdout.mock.calls[0]![0]).not.toContain("/private/runtime");
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

  it("administers invitations and grants without accepting recovery secrets in argv", async () => {
    const recovery = "r".repeat(43);
    const readSecret = vi.fn().mockResolvedValue(recovery);
    const createClientInvitation = vi.fn().mockResolvedValue("i".repeat(43));
    const replaceOwnerInvitation = vi.fn().mockResolvedValue("o".repeat(43));
    const grantClient = vi.fn().mockResolvedValue(undefined);
    const ungrantClient = vi.fn().mockResolvedValue(undefined);
    const service: ServerService = {
      start: vi.fn(), createClientInvitation, replaceOwnerInvitation, grantClient, ungrantClient,
    };
    const io = { ...createIo(), readSecret } satisfies CliIo;
    const clientId = "00000000-0000-4000-8000-000000000001";
    const cubeId = "00000000-0000-4000-8000-000000000002";

    expect(await runCli(["client-invite"], service, io)).toBe(0);
    expect(await runCli(["owner-invite"], service, io)).toBe(0);
    expect(await runCli(["client-grant", clientId, cubeId, "write"], service, io)).toBe(0);
    expect(await runCli(["client-ungrant", clientId, cubeId], service, io)).toBe(0);
    expect(readSecret).toHaveBeenCalledTimes(2);
    expect(readSecret).toHaveBeenNthCalledWith(1, "Recovery credential (hidden input): ");
    expect(readSecret).toHaveBeenNthCalledWith(2, "Recovery credential (hidden input): ");
    expect(createClientInvitation).toHaveBeenCalledWith(recovery);
    expect(replaceOwnerInvitation).toHaveBeenCalledWith(recovery);
    expect(grantClient).toHaveBeenCalledWith(clientId, cubeId, "write");
    expect(ungrantClient).toHaveBeenCalledWith(clientId, cubeId);
    expect(io.stdout).toHaveBeenCalledWith(
      `Client enrollment invitation (single-use, shown once): ${"i".repeat(43)}`,
    );
    expect(io.stdout).toHaveBeenCalledWith(
      `Owner enrollment invitation (single-use, shown once): ${"o".repeat(43)}`,
    );
    expect(JSON.stringify(io.stdout.mock.calls)).not.toContain(recovery);
    expect(await runCli(["owner-invite", recovery], service, io)).toBe(1);
  });

  it("prints the resolved cube, full ID, effective grant, and capability summary", async () => {
    const cubeId = "00000000-0000-4000-8000-000000000042";
    const createClientInvitation = vi.fn().mockResolvedValue({
      invitation: "i".repeat(43),
      cubeId,
      cubeName: "release-tooling",
      access: "write",
    });
    const io = {
      ...createIo(),
      readSecret: vi.fn().mockResolvedValue("r".repeat(43)),
    } satisfies CliIo;
    const service: ServerService = { start: vi.fn(), createClientInvitation };

    expect(await runCli(["client-invite", "release-tooling"], service, io)).toBe(0);
    expect(createClientInvitation).toHaveBeenCalledWith(
      "r".repeat(43),
      "release-tooling",
      undefined,
    );
    expect(io.stdout).toHaveBeenCalledWith(
      `Cube: "release-tooling" (${cubeId})\n` +
      "Grant: write (coordinate - attach, read, post, acknowledge, and receive directed wakes)\n" +
      `Client enrollment invitation (single-use, shown once): ${"i".repeat(43)}`,
    );

    expect(await runCli(
      ["client-invite", cubeId, "--access", "manage"],
      service,
      io,
    )).toBe(0);
    expect(createClientInvitation).toHaveBeenLastCalledWith("r".repeat(43), cubeId, "manage");
    expect(await runCli(["client-invite", "release-tooling", "--access", "owner"], service, io))
      .toBe(1);
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

  it("rejects unknown commands", async () => {
    const service: ServerService = { start: vi.fn() };
    const io = createIo();

    const exitCode = await runCli(["unknown"], service, io);

    expect(exitCode).toBe(1);
    expect(service.start).not.toHaveBeenCalled();
    expect(io.stderr).toHaveBeenCalledWith("Unknown command.");
  });
});
