import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { bootstrapServer, loadDigestKey, type BootstrapResult } from "../src/bootstrap.js";
import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import { applyMigrations, STORE_MIGRATIONS } from "../src/migrations.js";
import type { HttpsServerOptions, RunningServer } from "../src/https-server.js";
import { openStore, type LivenessStore } from "../src/store.js";
import {
  assertLanCaKeyOffline,
  acquireRuntimeLock,
  acquireInvitationMintLock,
  bindPortableOwnerCredentialPort,
  createNodeDashboardTerminal,
  createNodeServerService,
  createOfflineCredentialService,
  completeRuntimeUpdate,
  isFatalTeardownError,
  inspectManagedServiceState,
  inspectNodeRuntime,
  inspectRuntimeLock,
  recoverStaleRuntimeLock,
  stopServerRuntime,
  resolveStorageLimits,
  selectServerEnvironment,
  setupNodeServerInstallation,
} from "../src/service.js";
import { createRuntimeBuildIdentity } from "../src/runtime-identity.js";
import {
  portableCredentialAccount,
  readPortableServerCredential,
  writePortableServerCredential,
} from "../src/portable-credential-store.js";
import type { ForegroundDashboard } from "../src/dashboard.js";
import { createManagedServiceDefinition } from "../src/managed-service.js";
import { operatorErrors } from "../src/operator-error.js";
import { clientPrincipal } from "../src/principal.js";

function requireFreshSetup(
  result: Awaited<ReturnType<typeof setupNodeServerInstallation>>,
): BootstrapResult {
  if ("existing" in result) throw new Error("Expected a fresh server installation.");
  return result;
}

function serviceProbeError(code: string | number): Error {
  return Object.assign(new Error("managed service probe failed"), { code });
}

describe("node server service", () => {
  it.each([
    [null, true],
    [false, true],
    [true, false],
  ] as const)("restores the pre-dashboard stdin flow state %s", (readableFlowing, shouldPause) => {
    const setRawMode = vi.fn();
    const pause = vi.fn();
    const stdin = {
      readableFlowing,
      isRaw: false,
      setRawMode,
      resume: vi.fn(),
      pause,
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as typeof process.stdin;
    const stdout = {
      columns: 80,
      rows: 24,
      write: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as typeof process.stdout;

    const terminal = createNodeDashboardTerminal(true, { stdin, stdout });
    const unsubscribe = terminal.onInput!(() => undefined);
    expect(setRawMode).toHaveBeenCalledWith(true);
    unsubscribe();
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(pause).toHaveBeenCalledTimes(shouldPause ? 1 : 0);
  });

  it("restores raw and flow state when dashboard input setup fails", () => {
    const setRawMode = vi.fn();
    const pause = vi.fn();
    const stdin = {
      readableFlowing: null,
      isRaw: false,
      setRawMode,
      resume: vi.fn(() => { throw new Error("resume failed"); }),
      pause,
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as typeof process.stdin;
    const stdout = {
      columns: 80,
      rows: 24,
      write: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as typeof process.stdout;

    const terminal = createNodeDashboardTerminal(true, { stdin, stdout });
    expect(() => terminal.onInput!(() => undefined)).toThrow("resume failed");
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("authorizes explicit invitations with the directly provisioned portable owner credential", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-owner-invite-")));
    try {
      const directory = join(parent, "server");
      const credentials = join(parent, "credentials");
      await bootstrapServer(
        directory,
        "127.0.0.1",
        () => new Date(),
        (record) => writePortableServerCredential(credentials, record),
      );
       const invitation = await createOfflineCredentialService(directory, credentials)
         .invite("Alice laptop");
       expect(invitation.invitation).toMatch(/^[A-Za-z0-9_-]{43,1024}$/u);
      const runtime = await openStore({ path: join(directory, "borg.db") });
      try {
        const key = await loadDigestKey(join(directory, "credential-digest.key"));
        const authority = new CredentialAuthority(runtime.credentials, new CredentialDigester(key));
        key.fill(0);
        const enrolled = authority.exchangeInvitation({
           invitation: invitation.invitation,
          retryKey: randomUUID(),
          clientCredential: generateSecret(),
          clientName: "Far end self description",
        });
        expect(enrolled).toMatchObject({ purpose: "client", serverCapabilities: [] });
        const database = new DatabaseSync(join(directory, "borg.db"));
        try {
          expect(database.prepare("SELECT name FROM clients WHERE id = ?").get(enrolled!.clientId))
            .toEqual({ name: "Alice laptop" });
          expect(database.prepare(`
            SELECT requested_client_name FROM enrollment_claims WHERE client_id = ?
          `).get(enrolled!.clientId)).toEqual({
            requested_client_name: "Far end self description",
          });
        } finally {
          database.close();
        }
      } finally {
        runtime.close();
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("binds the portable owner credential to the actual listening origin", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-owner-origin-")));
    try {
      for (const bindHost of ["127.0.0.1", "::1"]) {
        const suffix = bindHost === "::1" ? "ipv6" : "ipv4";
        const directory = join(parent, `server-${suffix}`);
        const credentials = join(parent, `credentials-${suffix}`);
        const installation = await bootstrapServer(
          directory,
          bindHost,
          () => new Date(),
          (record) => writePortableServerCredential(credentials, record),
        );
        const displayHost = bindHost === "::1" ? "[::1]" : bindHost;

        await expect(bindPortableOwnerCredentialPort(
          directory,
          join(parent, `missing-credentials-${suffix}`),
          7_391,
        )).resolves.toBeUndefined();
        await bindPortableOwnerCredentialPort(directory, credentials, 7_391);

        for (const port of [7_391, 7_091]) {
          await expect(readPortableServerCredential(
            credentials,
            `https://${displayHost}:${port}`,
            `spki-sha256:${installation.caFingerprint}`,
          )).resolves.toMatchObject({
            clientId: installation.ownerAccess.clientId,
            serverCapabilities: ["create_cube"],
          });
        }
        await expect(createOfflineCredentialService(directory, credentials).invite())
          .resolves.toMatchObject({ invitation: expect.stringMatching(/^[A-Za-z0-9_-]{43,1024}$/u) });
        await bindPortableOwnerCredentialPort(directory, credentials, 7_392);
        await expect(readPortableServerCredential(
          credentials,
          `https://${displayHost}:7391`,
          `spki-sha256:${installation.caFingerprint}`,
        )).rejects.toThrow("Local owner credential is unavailable.");
        for (const port of [7_392, 7_091]) {
          await expect(readPortableServerCredential(
            credentials,
            `https://${displayHost}:${port}`,
            `spki-sha256:${installation.caFingerprint}`,
          )).resolves.toMatchObject({
            clientId: installation.ownerAccess.clientId,
            serverCapabilities: ["create_cube"],
          });
        }
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("preserves portable owner access across idempotent setup", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-owner-preserve-")));
    try {
      const directory = join(parent, "server");
      const credentials = join(parent, "credentials");
      const first = await setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: false },
        credentials,
      );
      expect("existing" in first).toBe(false);
      const before = await readFile(credentials);
      const second = await setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: false },
        credentials,
      );
      expect(second).toEqual({ existing: true });
      expect(await readFile(credentials)).toEqual(before);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects setup and startup when an ordinary enrollment occupies the default owner account", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-owner-collision-")));
    try {
      const directory = join(parent, "server");
      const credentials = join(parent, "credentials");
      const installation = requireFreshSetup(await setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: false },
        credentials,
      ));
      const origin = "https://127.0.0.1:7091";
      const trustIdentity = `spki-sha256:${installation.caFingerprint}`;
      const ordinary = {
        version: 2,
        origin,
        trustIdentity,
        credential: "o".repeat(43),
        clientId: "00000000-0000-4000-8000-000000000002",
        serverCapabilities: [],
      } as const;
      const before = JSON.parse(await readFile(credentials, "utf8")) as {
        version: number;
        accounts: Record<string, string>;
      };
      before.accounts[portableCredentialAccount(origin, trustIdentity)] = JSON.stringify(ordinary);
      await writeFile(credentials, `${JSON.stringify(before)}\n`, { mode: 0o600 });
      const occupied = await readFile(credentials);

      await expect(setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: false },
        credentials,
      )).rejects.toBe(operatorErrors.OWNER_CREDENTIAL_UNAVAILABLE);
      expect(await readFile(credentials)).toEqual(occupied);
      await expect(bindPortableOwnerCredentialPort(directory, credentials, 7_091))
        .rejects.toBe(operatorErrors.OWNER_CREDENTIAL_UNAVAILABLE);
      expect(await readFile(credentials)).toEqual(occupied);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("starts and stops the liveness scheduler with the authenticated runtime", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-liveness-service-")));
    try {
      await bootstrapServer(directory);
      const stop = vi.fn();
      const bindOwnerCredential = vi.fn().mockResolvedValue(undefined);
      const startLivenessScheduler = vi.fn((_liveness: LivenessStore) => ({ stop }));
      const service = createNodeServerService({
        environment: { BORG_SERVER_DATA_DIR: directory },
        readFile: vi.fn().mockResolvedValue(Buffer.from("certificate")),
        readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
        startServer: vi.fn().mockResolvedValue({
          origin: "https://127.0.0.1:7091",
          limits: {} as never,
          close: vi.fn().mockResolvedValue(undefined),
        }),
        onStarted: vi.fn(),
        bindOwnerCredential,
        waitForShutdown: vi.fn().mockResolvedValue(undefined),
        startLivenessScheduler,
      });

      await service.start([]);

      expect(bindOwnerCredential).toHaveBeenCalledWith("https://127.0.0.1:7091");
      expect(startLivenessScheduler).toHaveBeenCalledOnce();
      expect(startLivenessScheduler.mock.calls[0]![0]).toMatchObject({ scan: expect.any(Function) });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { originalHost: "127.0.0.1", lanHost: "fd00::20", loopbackHost: "127.0.0.1" },
    { originalHost: "::1", lanHost: "192.168.1.20", loopbackHost: "::1" },
  ])("keeps the original loopback family reachable during a $originalHost to $lanHost retrofit", async ({
    originalHost,
    lanHost,
    loopbackHost,
  }) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dual-listener-service-")));
    try {
      await bootstrapServer(directory, originalHost);
      await unlink(join(directory, "ca.key"));
      const starts: Array<{ readonly bind?: { readonly host?: string; readonly port?: number } }> = [];
      const closes = [vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined)];
      const startServer = vi.fn().mockImplementation(async (options) => {
        starts.push(options);
        const index = starts.length - 1;
        return {
          origin: index === 0
            ? `https://${lanHost.includes(":") ? `[${lanHost}]` : lanHost}:7091`
            : `https://${loopbackHost === "::1" ? "[::1]" : loopbackHost}:7091`,
          limits: {} as never,
          close: closes[index],
        };
      });
      const service = createNodeServerService({
        environment: { BORG_SERVER_DATA_DIR: directory },
        readFile: vi.fn(async (path: string) => path.endsWith("server.json")
          ? Buffer.from(JSON.stringify({ bind_host: originalHost }))
          : Buffer.from("certificate")),
        readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
        startServer,
        onStarted: vi.fn(),
        waitForShutdown: vi.fn().mockResolvedValue(undefined),
      });

      await service.start(["--host", lanHost, "--lan"]);

      expect(startServer).toHaveBeenCalledTimes(2);
      expect(starts.map((entry) => entry.bind)).toEqual([
        { host: lanHost, lanConsent: true },
        { host: loopbackHost, port: 7091 },
      ]);
      expect(closes[0]).toHaveBeenCalledOnce();
      expect(closes[1]).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes the LAN primary when the original-family compatibility listener fails", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dual-listener-cleanup-")));
    try {
      await bootstrapServer(directory, "::1");
      await unlink(join(directory, "ca.key"));
      const closePrimary = vi.fn().mockResolvedValue(undefined);
      const startServer = vi.fn()
        .mockResolvedValueOnce({
          origin: "https://192.168.1.20:7091",
          limits: {} as never,
          close: closePrimary,
        })
        .mockRejectedValueOnce(new Error("loopback bind failed"));
      const service = createNodeServerService({
        environment: { BORG_SERVER_DATA_DIR: directory },
        readFile: vi.fn(async (path: string) => path.endsWith("server.json")
          ? Buffer.from(JSON.stringify({ bind_host: "::1" }))
          : Buffer.from("certificate")),
        readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
        startServer,
        onStarted: vi.fn(),
        waitForShutdown: vi.fn().mockResolvedValue(undefined),
      });

      await expect(service.start(["--host", "192.168.1.20", "--lan"])).rejects.toThrow("loopback bind failed");
      expect(closePrimary).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("owns the foreground dashboard for the authenticated server lifetime", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-service-")));
    try {
      await bootstrapServer(directory);
      const closeDashboard = vi.fn();
      const dashboard: ForegroundDashboard = {
        failure: new Promise<never>(() => undefined),
        close: closeDashboard,
      };
      const startForegroundDashboard = vi.fn(() => dashboard);
      const closeServer = vi.fn().mockResolvedValue(undefined);
      const service = createNodeServerService({
        environment: { BORG_SERVER_DATA_DIR: directory },
        readFile: vi.fn().mockResolvedValue(Buffer.from("certificate")),
        readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
        startServer: vi.fn().mockResolvedValue({
          origin: "https://127.0.0.1:7091",
          limits: {} as never,
          close: closeServer,
        }),
        onStarted: vi.fn(),
        startForegroundDashboard,
        waitForShutdown: vi.fn().mockResolvedValue(undefined),
      });

      await service.start(["--ascii"]);

      expect(startForegroundDashboard).toHaveBeenCalledWith(expect.objectContaining({
        source: expect.objectContaining({
          read: expect.any(Function),
          subscribe: expect.any(Function),
        }),
        server: expect.objectContaining({
          name: "borgmcp-server",
          version: "0.15.1",
          endpoint: "https://127.0.0.1:7091",
          state: "online",
        }),
        asciiRequested: true,
      }));
      expect(closeDashboard).toHaveBeenCalledOnce();
      expect(closeServer).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shuts down the server when foreground dashboard rendering fails", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-dashboard-failure-")));
    try {
      await bootstrapServer(directory);
      const failure = new Error("dashboard render failure");
      const closeDashboard = vi.fn();
      const closeServer = vi.fn().mockResolvedValue(undefined);
      const service = createNodeServerService({
        environment: { BORG_SERVER_DATA_DIR: directory },
        readFile: vi.fn().mockResolvedValue(Buffer.from("certificate")),
        readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
        startServer: vi.fn().mockResolvedValue({
          origin: "https://127.0.0.1:7091",
          limits: {} as never,
          close: closeServer,
        }),
        onStarted: vi.fn(),
        startForegroundDashboard: () => ({
          failure: Promise.reject(failure),
          close: closeDashboard,
        }),
        waitForShutdown: vi.fn(() => new Promise<void>(() => undefined)),
      });

      await expect(service.start([])).rejects.toBe(failure);
      expect(closeDashboard).toHaveBeenCalledOnce();
      expect(closeServer).toHaveBeenCalledOnce();
      await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits a redacted startup record only when debug is explicitly enabled", async () => {
    const lines: string[] = [];
    const service = createNodeServerService({
      environment: {
        BORG_SERVER_TLS_KEY_FILE: "/private/server.key",
        BORG_SERVER_TLS_CERT_FILE: "/private/server.crt",
      },
      readFile: vi.fn().mockResolvedValue(Buffer.from("certificate")),
      readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
      startServer: vi.fn(async (): Promise<RunningServer> => ({
        origin: "https://127.0.0.1:7091",
        limits: {} as never,
        close: vi.fn().mockResolvedValue(undefined),
      })),
      onStarted: vi.fn(),
      waitForShutdown: vi.fn().mockResolvedValue(undefined),
      debugOutput: (line) => lines.push(line),
    });

    await service.start([]);
    expect(lines).toEqual([]);
    await service.start(["--log-level", "debug"]);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "debug",
      event: "startup",
      bind_mode: "loopback",
      port: 7091,
      data_directory: "tls_only",
    });
    expect(lines[0]).not.toContain("/private/");
    expect(lines.slice(1).map((line) => JSON.parse(line))).toEqual([
      { level: "debug", event: "lifecycle", action: "listening" },
      { level: "debug", event: "lifecycle", action: "stopped" },
    ]);
  });

  it("loads configured TLS files and starts with a fail-closed protocol authorizer", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const keyBuffer = Buffer.from("test-key-material");
    const readFile = vi.fn().mockResolvedValue(Buffer.from("test-certificate"));
    const readPrivateKey = vi.fn().mockResolvedValue(keyBuffer);
    const startServer = vi.fn(async (_options: HttpsServerOptions): Promise<RunningServer> => ({
      origin: "https://127.0.0.1:7091",
      limits: {
        maxConnections: 1,
        maxConnectionsPerAddress: 1,
        maxRequestsPerWindow: 1,
        maxRequestsPerAddressWindow: 1,
        maxRequestsGlobalWindow: 1,
        rateLimitWindowMs: 1,
        maxRateLimitEntries: 1,
        maxStreamsPerCredential: 1,
        maxHeaderBytes: 1,
        maxRequestBodyBytes: 1,
        maxRequestsPerSocket: 1,
        requestTimeoutMs: 1,
        tlsHandshakeTimeoutMs: 1,
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
        BORG_SERVER_TLS_CA_FILE: "/private/ca.crt",
      },
      readFile,
      readPrivateKey,
      startServer,
      onStarted,
      waitForShutdown,
    });

    await service.start([]);

    expect(readPrivateKey).toHaveBeenCalledWith("/private/server.key");
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledWith("/private/server.crt");
    expect(readFile).toHaveBeenCalledWith("/private/ca.crt");
    expect(startServer).toHaveBeenCalledOnce();
    const options = startServer.mock.calls[0]?.[0];
    expect(options?.bind).toEqual({});
    expect(options?.tls.ca).toEqual(Buffer.from("test-certificate"));
    expect(onStarted).toHaveBeenCalledWith(
      "https://127.0.0.1:7091",
        expect.objectContaining({ package_version: "0.15.1" }),
    );
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
      "Configure BORG_SERVER_DATA_DIR or the required TLS file variables.",
    );
    expect(startServer).not.toHaveBeenCalled();
  });

  it("passes only allowlisted server configuration out of the process environment", () => {
    expect(selectServerEnvironment({
      BORG_SERVER_TLS_KEY_FILE: "/private/server.key",
      BORG_SERVER_TLS_CERT_FILE: "/private/server.crt",
      BORG_SERVER_TLS_CA_FILE: "/private/ca.crt",
      BORG_SERVER_MAX_DATABASE_BYTES: "2000000000",
      BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE: "32768",
      BORG_SERVER_CONTEXT_GUIDELINE_BYTES: "8192",
      BORG_TOKEN: "must-not-cross-boundary",
      UNRELATED_REFRESH_TOKEN: "must-not-cross-boundary",
    })).toEqual({
      BORG_SERVER_TLS_KEY_FILE: "/private/server.key",
      BORG_SERVER_TLS_CERT_FILE: "/private/server.crt",
      BORG_SERVER_TLS_CA_FILE: "/private/ca.crt",
      BORG_SERVER_MAX_DATABASE_BYTES: "2000000000",
      BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE: "32768",
      BORG_SERVER_CONTEXT_GUIDELINE_BYTES: "8192",
    });
  });

  it("parses bounded storage settings and rejects ambiguous values", () => {
    expect(resolveStorageLimits({}).maxActiveDecisionBytesPerCube).toBe(16_384);
    expect(resolveStorageLimits({}).contextGuidelineBytes).toBe(16_384);
    expect(resolveStorageLimits({
      BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE: "2500",
      BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE: "32768",
      BORG_SERVER_CONTEXT_GUIDELINE_BYTES: "8192",
      BORG_SERVER_MAX_DATABASE_BYTES: "500000000",
      BORG_SERVER_MIN_FREE_DISK_BYTES: "50000000",
    })).toEqual({
      maxActivityEntriesPerCube: 2_500,
      maxActiveDecisionBytesPerCube: 32_768,
      contextGuidelineBytes: 8_192,
      maxDatabaseBytes: 500_000_000,
      minFreeDiskBytes: 50_000_000,
    });
    expect(() => resolveStorageLimits({ BORG_SERVER_MAX_DATABASE_BYTES: "1e9" }))
      .toThrow("Set BORG_SERVER_MAX_DATABASE_BYTES to a positive integer.");
    expect(() => resolveStorageLimits({ BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE: "0" }))
      .toThrow("Set BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE to a positive integer.");
    expect(() => resolveStorageLimits({ BORG_SERVER_CONTEXT_GUIDELINE_BYTES: "0" }))
      .toThrow("Set BORG_SERVER_CONTEXT_GUIDELINE_BYTES to a positive integer.");
  });

  it("requires the CA signing key to leave the runtime directory before LAN startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "borg-ca-custody-"));
    try {
      await expect(assertLanCaKeyOffline(directory)).resolves.toBeUndefined();
      await writeFile(join(directory, "ca.key"), "offline-only");
      await expect(assertLanCaKeyOffline(directory)).rejects.toThrow(
        "Move ca.key out of the runtime data directory before private-LAN startup.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("excludes offline credential changes while the server runtime lock is live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "borg-runtime-lock-"));
    try {
      const running = await acquireRuntimeLock(directory);
      await expect(acquireRuntimeLock(directory)).rejects.toThrow(
        "Stop the server before running setup or offline administration.",
      );
      await running.release();
      const offline = await acquireRuntimeLock(directory);
      await offline.release();
      await writeFile(
        join(directory, "runtime.lock"),
        JSON.stringify({ pid: 2_147_483_647, nonce: "stale" }),
        { mode: 0o600 },
      );
      await expect(acquireRuntimeLock(directory)).rejects.toThrow(
        "Confirm the recorded server process is stopped, then remove runtime.lock.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records exact running build identity without inferring it from a checkout", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-status-")));
    const identity = createRuntimeBuildIdentity({
      artifactIntegrity: `sha512-${"A".repeat(86)}==`,
      startedAt: new Date("2026-07-21T12:00:00.000Z"),
    });
    try {
      const lock = await acquireRuntimeLock(directory, "server", identity);
      await expect(inspectRuntimeLock(directory)).resolves.toEqual({
        running: true,
        pid: process.pid,
        identity,
        endpoint: null,
        mode: "foreground",
      });
      await lock.release();
      await expect(inspectRuntimeLock(directory)).resolves.toEqual({ running: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recognizes a live 0.1.8 runtime lock without inventing its process mode", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-legacy-runtime-lock-")));
    try {
      await writeFile(join(directory, "runtime.lock"), JSON.stringify({
        pid: process.pid,
        nonce: randomUUID(),
        purpose: "server",
        endpoint: "https://127.0.0.1:7091",
      }), { mode: 0o600 });
      await expect(inspectRuntimeLock(directory)).resolves.toEqual({
        running: true,
        pid: process.pid,
        identity: null,
        endpoint: "https://127.0.0.1:7091",
        mode: "legacy",
      });
      await writeFile(join(directory, "runtime.lock"), JSON.stringify({
        pid: process.pid,
        purpose: "server",
        mode: "unknown",
      }), { mode: 0o600 });
      await expect(inspectRuntimeLock(directory)).rejects.toThrow(
        "A live process owns runtime.lock. Stop the server through a supported command; do not remove the lock.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns bounded stale-lock evidence when a valid server lock has no live owner", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-stale-runtime-lock-")));
    const identity = createRuntimeBuildIdentity({
      artifactIntegrity: `sha512-${"A".repeat(86)}==`,
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
    });
    try {
      await writeFile(join(directory, "runtime.lock"), JSON.stringify({
        pid: 2_147_483_647,
        nonce: randomUUID(),
        purpose: "server",
        mode: "managed",
        runtime_identity: identity,
        endpoint: "https://127.0.0.1:7091",
      }), { mode: 0o600 });

      await expect(inspectRuntimeLock(directory)).resolves.toEqual({
        running: false,
        stale: {
          pid: 2_147_483_647,
          identity,
          endpoint: "https://127.0.0.1:7091",
          mode: "managed",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes an inactive managed definition from no service adapter", async () => {
    const dataDirectory = await realpath(await mkdtemp(join(tmpdir(), "borg-service-state-data-")));
    const runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), "borg-service-state-runtime-")));
    const inspect = inspectNodeRuntime as unknown as (
      data: string,
      runtime: string,
      inspectService: () => Promise<{
        readonly state: "active" | "inactive" | "absent";
        readonly adapter: "launchd" | "systemd" | null;
        readonly recoveryCommand: readonly string[] | null;
      }>,
    ) => Promise<{
      readonly serviceState: "active" | "inactive" | "absent";
      readonly serviceAdapter: "launchd" | "systemd" | null;
      readonly serviceRecoveryCommand: readonly string[] | null;
    }>;
    try {
      const inactive = await inspect(dataDirectory, runtimeDirectory, async () => ({
        state: "inactive",
        adapter: "launchd",
        recoveryCommand: [
          "launchctl",
          "bootstrap",
          "gui/501",
          "/Users/operator/Library/LaunchAgents/ai.borgmcp.server.plist",
        ],
      }));
      const absent = await inspect(dataDirectory, runtimeDirectory, async () => ({
        state: "absent",
        adapter: null,
        recoveryCommand: null,
      }));

      expect(inactive).toMatchObject({
        serviceState: "inactive",
        serviceAdapter: "launchd",
        serviceRecoveryCommand: [
          "launchctl",
          "bootstrap",
          "gui/501",
          "/Users/operator/Library/LaunchAgents/ai.borgmcp.server.plist",
        ],
      });
      expect(absent).toMatchObject({
        serviceState: "absent",
        serviceAdapter: null,
        serviceRecoveryCommand: null,
      });
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  });

  it("inspects active, inactive, absent, and unsafe managed service definitions separately", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-managed-inspect-")));
    const definitionPath = join(directory, "ai.borgmcp.server.plist");
    const definition = createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/usr/bin/node",
      runtimeRoot: "/private/runtime",
      dataDirectory: "/private/data",
      definitionPath,
      launchdDomain: "gui/501",
    });
    const run = vi.fn();
    try {
      run.mockRejectedValueOnce(serviceProbeError(113));
      await expect(inspectManagedServiceState(definition, run)).resolves.toEqual({
        state: "absent",
        adapter: null,
        recoveryCommand: null,
      });

      await writeFile(definitionPath, definition.content, { mode: 0o600 });
      run.mockRejectedValueOnce(serviceProbeError(113));
      await expect(inspectManagedServiceState(definition, run)).resolves.toEqual({
        state: "inactive",
        adapter: "launchd",
        recoveryCommand: definition.install,
      });

      run.mockResolvedValueOnce({ stdout: "state = exited\n", stderr: "" });
      await expect(inspectManagedServiceState(definition, run)).resolves.toEqual({
        state: "inactive",
        adapter: "launchd",
        recoveryCommand: definition.recoverLoaded,
      });

      run.mockResolvedValueOnce({ stdout: "state = running\n", stderr: "" });
      await expect(inspectManagedServiceState(definition, run)).resolves.toEqual({
        state: "active",
        adapter: "launchd",
        recoveryCommand: null,
      });

      await rm(definitionPath);
      const unsafeDefinition = { ...definition, definitionPath: directory };
      run.mockRejectedValueOnce(serviceProbeError(113));
      await expect(inspectManagedServiceState(unsafeDefinition, run)).rejects.toThrow(
        "Ensure the managed service definition is a regular file, then retry.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["permission", "EACCES"],
    ["timeout", "ETIMEDOUT"],
    ["unknown exit", 9],
  ] as const)("does not turn a %s service-probe failure into inactive guidance", async (_name, code) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-managed-unknown-")));
    const definitionPath = join(directory, "ai.borgmcp.server.plist");
    const definition = createManagedServiceDefinition({
      platform: "launchd",
      nodeExecutable: "/usr/bin/node",
      runtimeRoot: "/private/runtime",
      dataDirectory: "/private/data",
      definitionPath,
      launchdDomain: "gui/501",
    });
    const error = serviceProbeError(code);
    try {
      await writeFile(definitionPath, definition.content, { mode: 0o600 });
      await expect(inspectManagedServiceState(
        definition,
        vi.fn().mockRejectedValue(error),
      )).rejects.toBe(error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses systemd's explicit not-found state for inactive-unloaded guidance", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-systemd-unloaded-")));
    const definitionPath = join(directory, "ai.borgmcp.server.service");
    const definition = createManagedServiceDefinition({
      platform: "systemd",
      nodeExecutable: "/usr/bin/node",
      runtimeRoot: "/private/runtime",
      dataDirectory: "/private/data",
      definitionPath,
    });
    try {
      await writeFile(definitionPath, definition.content, { mode: 0o600 });
      await expect(inspectManagedServiceState(
        definition,
        vi.fn().mockResolvedValue({
          stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n",
          stderr: "",
        }),
      )).resolves.toEqual({
        state: "inactive",
        adapter: "systemd",
        recoveryCommand: definition.install,
      });
      await expect(inspectManagedServiceState(
        definition,
        vi.fn().mockResolvedValue({ stdout: "unexpected output\n", stderr: "" }),
      )).rejects.toThrow("systemd returned no service state.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports managed service state across running, inactive-defined, and absent updates", () => {
    const artifact = {
      artifactDirectory: "/runtime/artifacts/candidate",
      packageDirectory: "/runtime/artifacts/candidate/package",
      version: "0.15.1",
      integrity: `sha512-${"A".repeat(86)}==`,
      sourceSha: "a".repeat(40),
      treeSha256: "b".repeat(64),
    };
    const prepared = {
      outcome: "prepared" as const,
      artifact,
      runningIdentity: null,
      dataIdentity: "preserved" as const,
    };
    const command = [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/operator/Library/LaunchAgents/ai.borgmcp.server.plist",
    ] as const;

    expect(completeRuntimeUpdate(prepared, "0.15.1", {
      state: "inactive",
      adapter: "launchd",
      recoveryCommand: command,
    })).toMatchObject({
      serviceState: "inactive",
      serviceAdapter: "launchd",
      serviceRecoveryCommand: command,
    });
    expect(completeRuntimeUpdate(prepared, "0.15.1", {
      state: "absent",
      adapter: null,
      recoveryCommand: null,
    })).toMatchObject({
      serviceState: "absent",
      serviceAdapter: null,
      serviceRecoveryCommand: null,
    });
    expect(completeRuntimeUpdate({
      ...prepared,
      outcome: "updated",
      runningIdentity: createRuntimeBuildIdentity({
        artifactIntegrity: artifact.integrity,
        startedAt: new Date("2026-07-26T12:00:00.000Z"),
      }),
    }, "0.15.1", {
      state: "active",
      adapter: "launchd",
      recoveryCommand: null,
    })).toMatchObject({
      serviceState: "active",
      serviceAdapter: "launchd",
      serviceRecoveryCommand: null,
      runningIdentity: { package_version: "0.15.1" },
    });
  });

  it("revalidates and preserves a stale runtime lock without starting or deleting evidence", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-stale-recovery-")));
    const identity = createRuntimeBuildIdentity({
      artifactIntegrity: `sha512-${"A".repeat(86)}==`,
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
    });
    const record = {
      pid: 2_147_483_647,
      nonce: randomUUID(),
      purpose: "server",
      mode: "managed",
      runtime_identity: identity,
      endpoint: "https://127.0.0.1:7091",
    };
    try {
      await writeFile(join(directory, "runtime.lock"), JSON.stringify(record), { mode: 0o600 });
      const recovered = await recoverStaleRuntimeLock(
        directory,
        () => new Date("2026-07-26T12:34:56.789Z"),
      );

      expect(recovered).toMatchObject({
        backupPath: expect.stringContaining("runtime.lock.stale-20260726T123456789Z-"),
        stale: {
          pid: record.pid,
          identity,
          endpoint: record.endpoint,
          mode: "managed",
        },
      });
      await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(recovered.backupPath, "utf8")).resolves.toBe(JSON.stringify(record));
      expect((await readdir(directory)).filter((name) => name.startsWith("runtime.lock.stale-")))
        .toHaveLength(1);
      await expect(recoverStaleRuntimeLock(directory)).rejects.toThrow(
        "No safely recoverable stale runtime lock was found.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Cross-process acquire-vs-recover serialization is deliberately not promised; see #179.
  it("reports concurrent stale-preservation losers truthfully across 300 pairs", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-stale-concurrent-")));
    const identity = createRuntimeBuildIdentity({
      artifactIntegrity: `sha512-${"A".repeat(86)}==`,
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
    });
    const distribution = {
      success: 0,
      concurrent: 0,
      notStale: 0,
      invalid: 0,
      other: 0,
    };
    try {
      for (let iteration = 0; iteration < 300; iteration += 1) {
        await writeFile(join(directory, "runtime.lock"), JSON.stringify({
          pid: 2_147_483_647,
          nonce: randomUUID(),
          purpose: "server",
          mode: "managed",
          runtime_identity: identity,
          endpoint: "https://127.0.0.1:7091",
        }), { mode: 0o600 });
        let entered = 0;
        let bothEntered!: () => void;
        const bothAtTimestamp = new Promise<void>((resolve) => { bothEntered = resolve; });
        let releaseBoth!: () => void;
        const released = new Promise<void>((resolve) => { releaseBoth = resolve; });
        const now = async () => {
          entered += 1;
          if (entered === 2) bothEntered();
          await released;
          return new Date("2026-07-26T12:34:56.789Z");
        };
        const recoveries = [
          recoverStaleRuntimeLock(directory, now),
          recoverStaleRuntimeLock(directory, now),
        ];
        await bothAtTimestamp;
        releaseBoth();
        const results = await Promise.allSettled(recoveries);

        for (const result of results) {
          if (result.status === "fulfilled") {
            distribution.success += 1;
            expect(result.value).toMatchObject({
              stale: { pid: 2_147_483_647, identity },
            });
            continue;
          }
          const message = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
          if (message === "Another recovery already preserved runtime.lock. Rerun status.") {
            distribution.concurrent += 1;
          } else if (message === "No safely recoverable stale runtime lock was found.") {
            distribution.notStale += 1;
          } else if (message ===
            "Confirm the server is stopped, then remove the invalid runtime.lock.") {
            distribution.invalid += 1;
          } else {
            distribution.other += 1;
          }
        }
        const backups = (await readdir(directory))
          .filter((name) => name.startsWith("runtime.lock.stale-"));
        expect(backups).toHaveLength(1);
        await rm(join(directory, backups[0]!));
      }
      expect(distribution).toEqual({
        success: 300,
        concurrent: 300,
        notStale: 0,
        invalid: 0,
        other: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-lock-owner"],
  ] as const)("rejects a %s ownership nonce as invalid stale evidence", async (_name, nonce) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-stale-nonce-")));
    const identity = createRuntimeBuildIdentity({
      artifactIntegrity: `sha512-${"A".repeat(86)}==`,
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
    });
    try {
      await writeFile(join(directory, "runtime.lock"), JSON.stringify({
        pid: 2_147_483_647,
        ...(nonce === undefined ? {} : { nonce }),
        purpose: "server",
        mode: "managed",
        runtime_identity: identity,
        endpoint: "https://127.0.0.1:7091",
      }), { mode: 0o600 });

      await expect(inspectRuntimeLock(directory)).rejects.toThrow(
        "Confirm the server is stopped, then remove the invalid runtime.lock.",
      );
      await expect(recoverStaleRuntimeLock(directory)).rejects.toThrow(
        "Confirm the server is stopped, then remove the invalid runtime.lock.",
      );
      await expect(access(join(directory, "runtime.lock"))).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses when the stale record is replaced immediately before preservation", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-stale-replaced-")));
    const path = join(directory, "runtime.lock");
    const identity = createRuntimeBuildIdentity({
      artifactIntegrity: `sha512-${"A".repeat(86)}==`,
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
    });
    const original = {
      pid: 2_147_483_647,
      nonce: randomUUID(),
      purpose: "server",
      mode: "managed",
      runtime_identity: identity,
      endpoint: "https://127.0.0.1:7091",
    };
    const replacement = { ...original, nonce: randomUUID() };
    try {
      await writeFile(path, JSON.stringify(original), { mode: 0o600 });
      await expect(recoverStaleRuntimeLock(directory, () => {
        rmSync(path);
        writeFileSync(path, JSON.stringify(replacement), { mode: 0o600 });
        return new Date("2026-07-26T12:34:56.789Z");
      })).rejects.toThrow("No safely recoverable stale runtime lock was found.");

      await expect(readFile(path, "utf8")).resolves.toBe(JSON.stringify(replacement));
      expect((await readdir(directory)).filter((name) => name.startsWith("runtime.lock.stale-")))
        .toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not move a live lock that replaces stale evidence immediately before preservation", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-stale-live-replaced-")));
    const path = join(directory, "runtime.lock");
    const identity = createRuntimeBuildIdentity({
      artifactIntegrity: `sha512-${"A".repeat(86)}==`,
      startedAt: new Date("2026-07-26T12:00:00.000Z"),
    });
    const original = {
      pid: 2_147_483_647,
      nonce: randomUUID(),
      purpose: "server",
      mode: "managed",
      runtime_identity: identity,
      endpoint: "https://127.0.0.1:7091",
    };
    const live = { ...original, pid: process.pid, nonce: randomUUID() };
    try {
      await writeFile(path, JSON.stringify(original), { mode: 0o600 });
      await expect(recoverStaleRuntimeLock(directory, () => {
        rmSync(path);
        writeFileSync(path, JSON.stringify(live), { mode: 0o600 });
        return new Date("2026-07-26T12:34:56.789Z");
      })).rejects.toThrow("No safely recoverable stale runtime lock was found.");

      await expect(readFile(path, "utf8")).resolves.toBe(JSON.stringify(live));
      expect((await readdir(directory)).filter((name) => name.startsWith("runtime.lock.stale-")))
        .toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses stale-lock recovery for live, invalid, and unsafe lock evidence", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-stale-refusal-")));
    try {
      const live = await acquireRuntimeLock(directory, "server");
      await expect(recoverStaleRuntimeLock(directory)).rejects.toThrow(
        "No safely recoverable stale runtime lock was found.",
      );
      await live.release();

      await writeFile(join(directory, "runtime.lock"), JSON.stringify({
        pid: 2_147_483_647,
        purpose: "server",
        runtime_identity: { package_version: "not-a-version" },
      }), { mode: 0o600 });
      await expect(recoverStaleRuntimeLock(directory)).rejects.toThrow(
        "Confirm the server is stopped, then remove the invalid runtime.lock.",
      );
      await rm(join(directory, "runtime.lock"));
      await writeFile(join(directory, "runtime.lock"), JSON.stringify({
        pid: 2_147_483_647,
        purpose: "server",
        mode: "foreground",
      }), { mode: 0o600 });
      await expect(recoverStaleRuntimeLock(directory)).rejects.toThrow(
        "Confirm the server is stopped, then remove the invalid runtime.lock.",
      );
      await rm(join(directory, "runtime.lock"));
      await writeFile(join(directory, "runtime.lock"), "unsafe", { mode: 0o644 });
      await expect(recoverStaleRuntimeLock(directory)).rejects.toThrow(
        "Ensure runtime.lock is a private regular file before retrying.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops only managed runtimes and waits for lock disappearance", async () => {
    const managed = {
      running: true as const,
      pid: 123,
      identity: null,
      endpoint: "https://127.0.0.1:7091",
      mode: "managed" as const,
    };
    const inspect = vi.fn()
      .mockResolvedValueOnce(managed)
      .mockResolvedValueOnce(managed)
      .mockResolvedValueOnce({ running: false });
    const stopManaged = vi.fn().mockResolvedValue(undefined);
    await expect(stopServerRuntime({
      runtimeDataDirectory: "/owned/server",
      timeoutMs: 1_000,
      isManagedServiceActive: vi.fn().mockResolvedValue(true),
      stopManaged,
      inspect,
    })).resolves.toEqual({ outcome: "stopped" });
    expect(stopManaged).toHaveBeenCalledOnce();

    await expect(stopServerRuntime({
      runtimeDataDirectory: "/owned/server",
      timeoutMs: 1_000,
      isManagedServiceActive: vi.fn().mockResolvedValue(false),
      stopManaged,
      inspect: vi.fn().mockResolvedValue({ running: false }),
    })).resolves.toEqual({ outcome: "already-stopped" });
    expect(stopManaged).toHaveBeenCalledOnce();

    const legacyInspector = vi.fn()
      .mockResolvedValueOnce({ ...managed, mode: "legacy" })
      .mockResolvedValueOnce({ running: false });
    await expect(stopServerRuntime({
      runtimeDataDirectory: "/owned/server",
      timeoutMs: 1_000,
      isManagedServiceActive: vi.fn().mockResolvedValue(true),
      stopManaged,
      inspect: legacyInspector,
    })).resolves.toEqual({ outcome: "stopped" });
    expect(stopManaged).toHaveBeenCalledTimes(2);

    await expect(stopServerRuntime({
      runtimeDataDirectory: "/owned/server",
      timeoutMs: 1_000,
      isManagedServiceActive: vi.fn().mockResolvedValue(false),
      stopManaged,
      inspect: vi.fn().mockResolvedValue({ ...managed, mode: "foreground" }),
    })).resolves.toEqual({ outcome: "foreground-action-required" });
    expect(stopManaged).toHaveBeenCalledTimes(2);

    await expect(stopServerRuntime({
      runtimeDataDirectory: "/owned/server",
      timeoutMs: 100,
      isManagedServiceActive: vi.fn().mockResolvedValue(true),
      stopManaged,
      inspect: vi.fn().mockResolvedValue(managed),
    })).rejects.toThrow("Managed server stop timed out.");

    const failure = new Error("adapter failed");
    await expect(stopServerRuntime({
      runtimeDataDirectory: "/owned/server",
      timeoutMs: 1_000,
      isManagedServiceActive: vi.fn().mockResolvedValue(true),
      stopManaged: vi.fn().mockRejectedValue(failure),
      inspect: vi.fn().mockResolvedValue(managed),
    })).rejects.toBe(failure);
  });

  it("mints client invitations beside a live server after direct owner provisioning", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-live-invitation-")));
    let runtime: Awaited<ReturnType<typeof openStore>> | undefined;
    let digester: CredentialDigester | undefined;
    let running: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;
    try {
      const installation = await bootstrapServer(directory);
      runtime = await openStore({ path: installation.paths.database });
      const digestKey = await loadDigestKey(installation.paths.digestKey);
      digester = new CredentialDigester(digestKey);
      digestKey.fill(0);
      const liveAuthority = new CredentialAuthority(runtime.credentials, digester);
      const administration = createOfflineCredentialService(directory);
      const clientInvitation = await administration.createClientInvitation(installation.recoveryCredential);
      const originalCredential = generateSecret();
      const client = liveAuthority.exchangeInvitation({
        invitation: clientInvitation,
        retryKey: randomUUID(),
        clientCredential: originalCredential,
      });
      expect(client).not.toBeNull();
      const cubeId = "00000000-0000-4000-8000-000000000081";
      runtime.maintenance.createCube({ id: cubeId, name: "Live grant", directive: "" });
      running = await acquireRuntimeLock(directory, "server");

      expect(client).toMatchObject({ purpose: "client", serverCapabilities: [] });
      const beforeList = runtime.maintenance.observeAuthorityState();
      expect(await administration.listClients()).toEqual(
        expect.arrayContaining([expect.objectContaining({ state: "active" })]),
      );
      expect(runtime.maintenance.observeAuthorityState()).toEqual(beforeList);
      const rotatedCredential = await administration.rotateClient(client!.clientId);
      expect(liveAuthority.authenticate(`Bearer ${originalCredential}`)).toBeNull();
      expect(liveAuthority.authenticate(`Bearer ${rotatedCredential}`))
        .toMatchObject({ kind: "client", id: client!.clientId });
      await administration.grantClient(client!.clientId, cubeId, "read");
      expect(runtime.forPrincipal(clientPrincipal(client!.clientId)).getCube(cubeId)).not.toBeNull();
      await administration.ungrantClient(client!.clientId, cubeId);
      expect(runtime.forPrincipal(clientPrincipal(client!.clientId)).getCube(cubeId)).toBeNull();
      await administration.revokeClient(client!.clientId);
      expect(liveAuthority.authenticate(`Bearer ${rotatedCredential}`)).toBeNull();
    } finally {
      await running?.release();
      digester?.destroy();
      runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails invitation contention and exclusive-admin overlap without leaking locks", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-invitation-contention-")));
    try {
      const installation = await bootstrapServer(directory);
      const administration = createOfflineCredentialService(directory);
      const invitationLock = await acquireInvitationMintLock(directory);
      await expect(administration.createClientInvitation(installation.recoveryCredential))
        .rejects.toThrow("Confirm no invitation or offline administration command is running");
      await expect(setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize: true }))
        .rejects.toThrow("Confirm no invitation or offline administration command is running");
      await invitationLock.release();

      const exclusive = await acquireRuntimeLock(directory);
      await expect(administration.createClientInvitation(installation.recoveryCredential))
        .rejects.toThrow("Stop the server before running setup or offline administration.");
      await exclusive.release();
      const recovered = await acquireRuntimeLock(directory);
      await recovered.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps bounded SQLite invitation contention to actionable static copy", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-invitation-sqlite-busy-")));
    let blocker: DatabaseSync | undefined;
    try {
      const installation = await bootstrapServer(directory);
      blocker = new DatabaseSync(installation.paths.database);
      blocker.exec("BEGIN IMMEDIATE");
      const administration = createOfflineCredentialService(directory);

      await expect(administration.listClients())
        .rejects.toThrow("Retry the live client authorization change after the current server database write completes.");

      await expect(administration.createClientInvitation(installation.recoveryCredential))
        .rejects.toThrow("Retry invitation minting after the current server database write completes.");
      expect(await access(join(directory, "invitation-mint.lock")).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      )).toBe(true);
    } finally {
      try { blocker?.exec("ROLLBACK"); } catch { /* Preserve cleanup. */ }
      blocker?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("refuses live invitation minting on a prior schema without migrating or mutating", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-live-prior-schema-")));
    const databasePath = join(directory, "borg.db");
    let running: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;
    try {
      const prior = new DatabaseSync(databasePath);
      prior.exec("PRAGMA journal_mode = WAL");
      applyMigrations(prior, STORE_MIGRATIONS.slice(0, -1));
      const beforeMigrations = prior.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      const beforeSchema = prior.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
      `).all();
      prior.close();

      running = await acquireRuntimeLock(directory, "server");
      const administration = createOfflineCredentialService(directory);
      await expect(administration.createClientInvitation("unused-recovery-value"))
        .rejects.toThrow(
          "Invitation minting is unavailable while a server with an incompatible schema is running. Stop the server and rerun this command, or use the CLI version that matches the running server.",
        );

      const after = new DatabaseSync(databasePath, { readOnly: true });
      expect(after.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all()).toEqual(beforeMigrations);
      expect(after.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
      `).all()).toEqual(beforeSchema);
      expect(after.prepare("SELECT COUNT(*) AS count FROM enrollment_invitations").get())
        .toEqual({ count: 0 });
      after.close();
      await expect(access(join(directory, "invitation-mint.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await running?.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps fresh setup behavior and treats a complete existing installation idempotently", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-setup-existing-")));
    try {
      const first = requireFreshSetup(await setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: false },
      ));
      expect(first.recoveryCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(first.initialInvitation).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const before = await Promise.all(Object.values(first.paths).map((path) => readFile(path)));

      await expect(setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize: false }))
        .resolves.toEqual({ existing: true });
      const after = await Promise.all(Object.values(first.paths).map((path) => readFile(path)));
      expect(after).toEqual(before);
      await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an incomplete existing installation without mutation", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-setup-partial-")));
    try {
      const partial = join(directory, "server.json");
      await writeFile(partial, "partial", { mode: 0o600 });

      await expect(setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize: false }))
        .rejects.toThrow(
          "An installation already exists in BORG_SERVER_DATA_DIR. To destroy and recreate it, stop the server and run borg-mcp-server setup --reinitialize.",
        );
      await expect(readFile(partial, "utf8")).resolves.toBe("partial");
      await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reinitializes only through the explicit destructive path", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-setup-reinitialize-")));
    try {
      const first = requireFreshSetup(await setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: false },
      ));
      const runtime = await openStore({ path: first.paths.database });
      runtime.maintenance.createClient({
        id: "00000000-0000-4000-8000-000000000071",
        name: "Must be removed",
      });
      runtime.maintenance.createCube({
        id: "00000000-0000-4000-8000-000000000072",
        name: "Must be removed",
        directive: "old state",
      });
      runtime.close();
      const unrelated = join(directory, "operator-notes.txt");
      await writeFile(unrelated, "preserve me", { mode: 0o600 });
      const caBefore = await readFile(first.paths.caCertificate);
      const caKeyBefore = await readFile(first.paths.caKey);

      const second = requireFreshSetup(await setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: true },
      ));
      expect(second.serverId).not.toBe(first.serverId);
      expect(second.caFingerprint).toBe(first.caFingerprint);
      expect(await readFile(second.paths.caCertificate)).toEqual(caBefore);
      expect(await readFile(second.paths.caKey)).toEqual(caKeyBefore);
      expect(await readFile(unrelated, "utf8")).toBe("preserve me");
      const freshRuntime = await openStore({ path: second.paths.database });
      expect(freshRuntime.maintenance.observeAuthorityState()).toMatchObject({
        enrolled_clients: 1,
        cubes: 0,
        roles: 0,
        grants: 0,
      });
      freshRuntime.close();
      await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses reinitialization when CA material is incomplete without deleting state", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-setup-missing-ca-")));
    try {
      const first = requireFreshSetup(await setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: false },
      ));
      const before = new Map<string, Buffer>();
      for (const path of Object.values(first.paths)) before.set(path, await readFile(path));
      await unlink(first.paths.caCertificate);

      await expect(setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize: true }))
        .rejects.toThrow("The existing CA certificate and private key are required for reinitialization.");
      await expect(access(first.paths.caCertificate)).rejects.toMatchObject({ code: "ENOENT" });
      for (const [path, bytes] of before) {
        if (path !== first.paths.caCertificate) expect(await readFile(path)).toEqual(bytes);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses all setup modes while the runtime lock is live", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-setup-live-lock-")));
    try {
      const installation = requireFreshSetup(await setupNodeServerInstallation(
        directory,
        "127.0.0.1",
        { reinitialize: false },
      ));
      const before = await Promise.all(Object.values(installation.paths).map((path) => readFile(path)));
      const running = await acquireRuntimeLock(directory);
      try {
        for (const reinitialize of [false, true]) {
          await expect(setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize }))
            .rejects.toThrow("Stop the server before running setup or offline administration.");
        }
        const after = await Promise.all(Object.values(installation.paths).map((path) => readFile(path)));
        expect(after).toEqual(before);
      } finally {
        await running.release();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["onStarted", "waitForShutdown"] as const)(
    "closes the listener before releasing the runtime lock when %s fails",
    async (failurePoint) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-service-cleanup-")));
      try {
        await bootstrapServer(directory);
        const failure = new Error(`${failurePoint} failed`);
        let markCloseStarted!: () => void;
        let releaseClose!: () => void;
        const closeStarted = new Promise<void>((resolve) => { markCloseStarted = resolve; });
        const closeReleased = new Promise<void>((resolve) => { releaseClose = resolve; });
        const close = vi.fn(async () => {
          markCloseStarted();
          await closeReleased;
        });
        const running: RunningServer = {
          origin: "https://127.0.0.1:7091",
          limits: {
            maxConnections: 1,
            maxConnectionsPerAddress: 1,
            maxRequestsPerWindow: 1,
            maxRequestsPerAddressWindow: 1,
            maxRequestsGlobalWindow: 1,
            rateLimitWindowMs: 1,
            maxRateLimitEntries: 1,
            maxStreamsPerCredential: 1,
            maxHeaderBytes: 1,
            maxRequestBodyBytes: 1,
            maxRequestsPerSocket: 1,
            requestTimeoutMs: 1,
            tlsHandshakeTimeoutMs: 1,
            headersTimeoutMs: 1,
            keepAliveTimeoutMs: 1,
            handlerTimeoutMs: 1,
          },
          close,
        };
        const service = createNodeServerService({
          environment: { BORG_SERVER_DATA_DIR: directory },
          readFile: vi.fn().mockResolvedValue(Buffer.from("certificate")),
          readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
          startServer: vi.fn().mockResolvedValue(running),
          onStarted: () => {
            if (failurePoint === "onStarted") throw failure;
          },
          waitForShutdown: failurePoint === "waitForShutdown"
            ? vi.fn().mockRejectedValue(failure)
            : vi.fn().mockResolvedValue(undefined),
        });
        const result = service.start([]).then(() => null, (error: unknown) => error);

        await closeStarted;
        await expect(createOfflineCredentialService(directory).revokeClient(
          "00000000-0000-4000-8000-000000000001",
        )).rejects.toThrow("Provide an existing client name, handle, or ID.");
        releaseClose();

        expect(await result).toBe(failure);
        expect(close).toHaveBeenCalledOnce();
        const offline = await acquireRuntimeLock(directory);
        await offline.release();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["private-key", "certificate", "store", "listener"] as const)(
    "releases partial startup resources when shutdown arrives during %s startup",
    async (phase) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-startup-signal-")));
      try {
        await bootstrapServer(directory);
        const controller = new AbortController();
        const dispose = vi.fn();
        let releasePhase!: () => void;
        const phaseGate = new Promise<void>((resolve) => { releasePhase = resolve; });
        let certificateReads = 0;
        const close = vi.fn().mockResolvedValue(undefined);
        const running: RunningServer = {
          origin: "https://127.0.0.1:7091",
          limits: {
            maxConnections: 1,
            maxConnectionsPerAddress: 1,
            maxRequestsPerWindow: 1,
            maxRequestsPerAddressWindow: 1,
            maxRequestsGlobalWindow: 1,
            rateLimitWindowMs: 1,
            maxRateLimitEntries: 1,
            maxStreamsPerCredential: 1,
            maxHeaderBytes: 1,
            maxRequestBodyBytes: 1,
            maxRequestsPerSocket: 1,
            requestTimeoutMs: 1,
            tlsHandshakeTimeoutMs: 1,
            headersTimeoutMs: 1,
            keepAliveTimeoutMs: 1,
            handlerTimeoutMs: 1,
          },
          close,
        };
        const service = createNodeServerService({
          environment: { BORG_SERVER_DATA_DIR: directory },
          installShutdownHandlers: () => ({ signal: controller.signal, dispose }),
          readPrivateKey: async () => {
            if (phase === "private-key") await phaseGate;
            return Buffer.from("private-key");
          },
          readFile: async () => {
            if (phase === "certificate" && certificateReads++ === 0) await phaseGate;
            return Buffer.from("certificate");
          },
          openStore: async (options) => {
            if (phase === "store") await phaseGate;
            return openStore(options);
          },
          startServer: async () => {
            if (phase === "listener") await phaseGate;
            return running;
          },
          onStarted: vi.fn(),
          waitForShutdown: vi.fn().mockResolvedValue(undefined),
        });
        const startup = service.start([]);
        await vi.waitFor(() => expect(access(join(directory, "runtime.lock"))).resolves.toBeUndefined());
        controller.abort();
        releasePhase();

        await expect(startup).resolves.toBeUndefined();
        await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(close).toHaveBeenCalledTimes(phase === "listener" ? 1 : 0);
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("retains authentication state and runtime lock when listener closure is unconfirmed", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-close-failure-")));
    try {
      await bootstrapServer(directory);
      const primary = new Error("primary shutdown failure");
      const closeFailure = new Error("secret listener failure detail");
      const close = vi.fn().mockRejectedValue(closeFailure);
      let authCloseCalls = 0;
      const service = createNodeServerService({
        environment: { BORG_SERVER_DATA_DIR: directory },
        readFile: vi.fn().mockResolvedValue(Buffer.from("certificate")),
        readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
        openStore: async (options) => {
          const runtime = await openStore(options);
          return Object.freeze({
            ...runtime,
            close: () => {
              authCloseCalls += 1;
              runtime.close();
            },
          });
        },
        startServer: vi.fn().mockResolvedValue({
          origin: "https://127.0.0.1:7091",
          limits: DEFAULT_TEST_LIMITS,
          close,
        }),
        onStarted: vi.fn(),
        waitForShutdown: vi.fn().mockRejectedValue(primary),
      });

      const result = await service.start([]).then(() => null, (error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect(result).toMatchObject({
        message: "Server teardown could not be confirmed; the runtime remains locked.",
        errors: [primary, closeFailure],
      });
      expect((result as Error).message).not.toContain("secret listener failure detail");
      expect(isFatalTeardownError(result)).toBe(true);
      const RecoveredFatal = Object.getPrototypeOf(result).constructor as new (
        capability: object,
        primary: unknown,
        cleanup: unknown,
      ) => unknown;
      for (const invoke of [
        () => new RecoveredFatal({}, primary, closeFailure),
        () => Reflect.construct(RecoveredFatal, [{}, primary, closeFailure]),
        () => Object.create(Object.getPrototypeOf(result)),
        () => Object.freeze({ ...(result as object) }),
      ]) {
        let forged: unknown;
        try { forged = invoke(); } catch (error) { forged = error; }
        expect(isFatalTeardownError(forged)).toBe(false);
      }
      expect(authCloseCalls).toBe(0);
      await expect(createOfflineCredentialService(directory).rotateClient(
        "00000000-0000-4000-8000-000000000001",
      )).rejects.toThrow("Provide an existing active client ID.");
      await expect(acquireRuntimeLock(directory)).rejects.toThrow(
        "Stop the server before running setup or offline administration.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects constructor-recovery attacks against built fatal teardown errors", async () => {
    const serviceModulePath = "../dist/service.js";
    const mainModulePath = "../dist/main.js";
    const builtService = await import(serviceModulePath);
    const builtMain = await import(mainModulePath);
    const primary = new Error("primary");
    const closeFailure = new Error("secret-built-close-detail");
    const service = builtService.createNodeServerService({
      environment: {
        BORG_SERVER_TLS_KEY_FILE: "key",
        BORG_SERVER_TLS_CERT_FILE: "cert",
      },
      readFile: vi.fn().mockResolvedValue(Buffer.from("certificate")),
      readPrivateKey: vi.fn().mockResolvedValue(Buffer.from("private-key")),
      startServer: vi.fn().mockResolvedValue({
        origin: "https://127.0.0.1:7091",
        limits: DEFAULT_TEST_LIMITS,
        close: vi.fn().mockRejectedValue(closeFailure),
      }),
      onStarted: vi.fn(),
      waitForShutdown: vi.fn().mockRejectedValue(primary),
    });
    const legitimate = await service.start([]).then(() => null, (error: unknown) => error);
    expect(builtService.isFatalTeardownError(legitimate)).toBe(true);
    expect(Object.isFrozen(legitimate)).toBe(true);
    const secret = "secret-built-close-detail-/private/fatal-path";
    const Recovered = Object.getPrototypeOf(legitimate).constructor as new (...args: unknown[]) => unknown;
    const proxyTraps = vi.fn(() => { throw new Error(secret); });
    const attempts: Array<() => unknown> = [
      () => new Recovered({}, primary, closeFailure),
      () => Reflect.construct(Recovered, [{}, primary, closeFailure]),
      () => Reflect.construct(Recovered.bind(null, {}), [primary, closeFailure]),
      () => (Recovered as unknown as Function).call({}, {}, primary, closeFailure),
      () => (Recovered as unknown as Function).apply({}, [{}, primary, closeFailure]),
      () => {
        const Base = Recovered as any;
        return new (class extends Base {
          constructor() { super({}, primary, closeFailure); }
        })();
      },
      () => Object.create(Object.getPrototypeOf(legitimate)),
      () => Object.freeze({ ...(legitimate as object), message: secret }),
      () => new Proxy(legitimate as object, {
        get: proxyTraps,
        getPrototypeOf: proxyTraps,
        ownKeys: proxyTraps,
      }),
      () => Object.freeze(Object.fromEntries(
        Reflect.ownKeys(legitimate as object).map((key) => [String(key), secret]),
      )),
    ];
    for (const attempt of attempts) {
      let forged: unknown;
      try { forged = attempt(); } catch (error) { forged = error; }
      expect(builtService.isFatalTeardownError(forged)).toBe(false);
      const previousExitCode = process.exitCode;
      const forgedStderr = vi.fn();
      const forgedFatalExit = vi.fn(() => { throw new Error("forged fatal exit"); });
      try {
        await builtMain.runMain(
          ["start"],
          { start: vi.fn().mockRejectedValue(forged) },
          { stdout: vi.fn(), stderr: forgedStderr },
          forgedFatalExit as never,
        );
        expect(process.exitCode).toBe(1);
        expect(forgedFatalExit).not.toHaveBeenCalled();
        expect(forgedStderr).toHaveBeenCalledWith("Server command failed.");
        expect(JSON.stringify(forgedStderr.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(forgedStderr.mock.calls)).not.toContain("file:///");
        expect(JSON.stringify(forgedStderr.mock.calls)).not.toContain("Fatal teardown error construction");
      } finally {
        process.exitCode = previousExitCode;
      }
    }
    expect(proxyTraps).not.toHaveBeenCalled();
    expect(Reflect.set(legitimate as object, "message", secret)).toBe(false);
    expect(Reflect.ownKeys(legitimate as object)).not.toContain("fatalTeardownCapability");
    expect(Reflect.ownKeys(Object.getPrototypeOf(legitimate))).not.toContain("fatalTeardownCapability");

    const stderr = vi.fn();
    const fatalExit = vi.fn(() => { throw new Error("fatal exit sentinel"); });
    await expect(builtMain.runMain(
      ["start"],
      { start: vi.fn().mockRejectedValue(legitimate) },
      { stdout: vi.fn(), stderr },
      fatalExit as never,
    )).rejects.toThrow("fatal exit sentinel");
    expect(stderr).toHaveBeenCalledWith("Server command failed.");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("secret-built-close-detail");
  });
});

const DEFAULT_TEST_LIMITS: RunningServer["limits"] = {
  maxConnections: 1,
  maxConnectionsPerAddress: 1,
  maxRequestsPerWindow: 1,
  maxRequestsPerAddressWindow: 1,
  maxRequestsGlobalWindow: 1,
  rateLimitWindowMs: 1,
  maxRateLimitEntries: 1,
  maxStreamsPerCredential: 1,
  maxHeaderBytes: 1,
  maxRequestBodyBytes: 1,
  maxRequestsPerSocket: 1,
  requestTimeoutMs: 1,
  tlsHandshakeTimeoutMs: 1,
  headersTimeoutMs: 1,
  keepAliveTimeoutMs: 1,
  handlerTimeoutMs: 1,
};
