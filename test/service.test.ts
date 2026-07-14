import { describe, expect, it, vi } from "vitest";

import type { HttpsServerOptions, RunningServer } from "../src/https-server.js";
import { createNodeServerService, selectServerEnvironment } from "../src/service.js";

describe("node server service", () => {
  it("loads configured TLS files and starts with a fail-closed protocol authorizer", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn(async (path: string) => Buffer.from(path));
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
      startServer,
      onStarted,
      waitForShutdown,
    });

    await service.start([]);

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(startServer).toHaveBeenCalledOnce();
    const options = startServer.mock.calls[0]?.[0];
    expect(options?.bind).toEqual({});
    expect(options?.protocolInfo.capabilities).toEqual([
      "transport.tls",
      "authority.no-cloud-fallback",
    ]);
    await expect(options?.authorizeProtocol("Bearer not-yet-supported")).resolves.toBe(false);
    expect(onStarted).toHaveBeenCalledWith("https://127.0.0.1:7443");
    expect(waitForShutdown).toHaveBeenCalledOnce();
  });

  it("fails before opening a listener when TLS paths are missing", async () => {
    const startServer = vi.fn();
    const service = createNodeServerService({
      environment: {},
      readFile: vi.fn(),
      startServer,
      onStarted: vi.fn(),
      waitForShutdown: vi.fn(),
    });

    await expect(service.start([])).rejects.toThrow(
      "TLS key and certificate files must be configured.",
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
