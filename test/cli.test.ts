import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliIo, type ServerService } from "../src/index.js";

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
    expect(service.setup).toHaveBeenCalledOnce();
    expect(listen).not.toHaveBeenCalled();
    expect(io.stdout).toHaveBeenCalledWith(expect.stringContaining("shown once"));
  });

  it("delegates explicit start to the service boundary", async () => {
    const service: ServerService = { start: vi.fn().mockResolvedValue(undefined) };

    const exitCode = await runCli(["start", "--lan"], service, createIo());

    expect(exitCode).toBe(0);
    expect(service.start).toHaveBeenCalledWith(["--lan"]);
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
    expect(createClientInvitation).toHaveBeenCalledWith(recovery);
    expect(replaceOwnerInvitation).toHaveBeenCalledWith(recovery);
    expect(grantClient).toHaveBeenCalledWith(clientId, cubeId, "write");
    expect(ungrantClient).toHaveBeenCalledWith(clientId, cubeId);
    expect(JSON.stringify(io.stdout.mock.calls)).not.toContain(recovery);
    expect(await runCli(["owner-invite", recovery], service, io)).toBe(1);
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
