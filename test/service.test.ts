import { describe, expect, it, vi } from "vitest";

import type { HttpsServerOptions, RunningServer } from "../src/https-server.js";
import { createNodeServerService, selectServerEnvironment } from "../src/service.js";

describe("node server service", () => {
  it("loads configured TLS files and starts with a fail-closed protocol authorizer", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const keyBuffer = Buffer.from("test-key-material");
    const readFile = vi.fn().mockResolvedValue(Buffer.from("test-certificate"));
    const readPrivateKey = vi.fn().mockResolvedValue(keyBuffer);
    const startServer = vi.fn(async (_options: HttpsServerOptions): Promise<RunningServer> => ({
      origin: "https://127.0.0.1:7443",
      limits: {
        maxConnections: 1,
        maxHeaderBytes: 1,
        maxRequestBodyBytes: 1,
        maxRequestsPerSocket: 1,
        requestTimeoutMs: 1,
        headersTimeoutMs: 1,
        keepAliveTimeoutMs: 1,
        handlerTimeoutMs: 1,
      },
      close,
    }));
    const waitForShutdown = vi.fn().mockResolvedValue(undefined);
    const onStarted = vi.fn();
    const service = createNodeServerService({
      environment: {
        BORG_SERVER_TLS_KEY_FILE: "/private/server.key",
        BORG_SERVER_TLS_CERT_FILE: "/private/server.crt",
      },
      readFile,
      readPrivateKey,
      startServer,
      onStarted,
      waitForShutdown,
    });

    await service.start([]);

    expect(readPrivateKey).toHaveBeenCalledWith("/private/server.key");
    expect(readFile).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledWith("/private/server.crt");
    expect(startServer).toHaveBeenCalledOnce();
    const options = startServer.mock.calls[0]?.[0];
    expect(options?.bind).toEqual({});
    expect(options?.protocolInfo.capabilities).toEqual([
      "coordination.core",
      "auth.bearer",
      "auth.revocation",
      "scope.cube-isolation",
      "transport.tls",
      "authority.no-cloud-fallback",
      "log.cursor",
      "stream.sse",
      "stream.replay",
      "acks",
      "claims",
      "decisions",
    ]);
    await expect(
      options?.authorizeProtocol("Bearer not-yet-supported", AbortSignal.abort()),
    ).resolves.toBe(false);
    expect(onStarted).toHaveBeenCalledWith("https://127.0.0.1:7443");
    expect(waitForShutdown).toHaveBeenCalledOnce();
    expect(keyBuffer.every((byte) => byte === 0)).toBe(true);
  });

  it("wipes the key buffer when server startup fails", async () => {
    const keyBuffer = Buffer.from("test-key-material");
    const service = createNodeServerService({
      environment: {
        BORG_SERVER_TLS_KEY_FILE: "/private/server.key",
        BORG_SERVER_TLS_CERT_FILE: "/private/server.crt",
      },
      readFile: vi.fn(async (path: string) =>
        path.endsWith(".key") ? keyBuffer : Buffer.from("test-certificate")),
      readPrivateKey: vi.fn().mockResolvedValue(keyBuffer),
      startServer: vi.fn().mockRejectedValue(new Error("startup failed")),
      onStarted: vi.fn(),
      waitForShutdown: vi.fn(),
    });

    await expect(service.start([])).rejects.toThrow("startup failed");
    expect(keyBuffer.every((byte) => byte === 0)).toBe(true);
  });

  it("fails before opening a listener when TLS paths are missing", async () => {
    const startServer = vi.fn();
    const service = createNodeServerService({
      environment: {},
      readFile: vi.fn(),
      readPrivateKey: vi.fn(),
      startServer,
      onStarted: vi.fn(),
      waitForShutdown: vi.fn(),
    });

    await expect(service.start([])).rejects.toThrow(
      "Server data directory or TLS files must be configured.",
    );
    expect(startServer).not.toHaveBeenCalled();
  });

  it("passes only allowlisted server configuration out of the process environment", () => {
    expect(selectServerEnvironment({
      BORG_SERVER_TLS_KEY_FILE: "/private/server.key",
      BORG_SERVER_TLS_CERT_FILE: "/private/server.crt",
      BORG_TOKEN: "must-not-cross-boundary",
      GOOGLE_REFRESH_TOKEN: "must-not-cross-boundary",
    })).toEqual({
      BORG_SERVER_TLS_KEY_FILE: "/private/server.key",
      BORG_SERVER_TLS_CERT_FILE: "/private/server.crt",
    });
  });
});
