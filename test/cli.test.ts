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
