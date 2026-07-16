import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { bootstrapServer, loadDigestKey } from "../src/bootstrap.js";
import { CredentialAuthority, CredentialDigester, generateSecret } from "../src/credentials.js";
import { applyMigrations, STORE_MIGRATIONS } from "../src/migrations.js";
import type { HttpsServerOptions, RunningServer } from "../src/https-server.js";
import { openStore } from "../src/store.js";
import {
  assertLanCaKeyOffline,
  acquireRuntimeLock,
  acquireInvitationMintLock,
  createNodeServerService,
  createOfflineCredentialService,
  isFatalTeardownError,
  resolveStorageLimits,
  selectServerEnvironment,
  setupNodeServerInstallation,
} from "../src/service.js";

describe("node server service", () => {
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
    expect(options?.protocolInfo.capabilities).toEqual([
      "coordination.core",
      "auth.bearer",
      "auth.revocation",
      "auth.retry-safe-enrollment",
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
    expect(onStarted).toHaveBeenCalledWith("https://127.0.0.1:7091");
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
      BORG_TOKEN: "must-not-cross-boundary",
      GOOGLE_REFRESH_TOKEN: "must-not-cross-boundary",
    })).toEqual({
      BORG_SERVER_TLS_KEY_FILE: "/private/server.key",
      BORG_SERVER_TLS_CERT_FILE: "/private/server.crt",
      BORG_SERVER_TLS_CA_FILE: "/private/ca.crt",
      BORG_SERVER_MAX_DATABASE_BYTES: "2000000000",
    });
  });

  it("parses bounded storage settings and rejects ambiguous values", () => {
    expect(resolveStorageLimits({
      BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE: "2500",
      BORG_SERVER_MAX_DATABASE_BYTES: "500000000",
      BORG_SERVER_MIN_FREE_DISK_BYTES: "50000000",
    })).toEqual({
      maxActivityEntriesPerCube: 2_500,
      maxDatabaseBytes: 500_000_000,
      minFreeDiskBytes: 50_000_000,
    });
    expect(() => resolveStorageLimits({ BORG_SERVER_MAX_DATABASE_BYTES: "1e9" }))
      .toThrow("Set BORG_SERVER_MAX_DATABASE_BYTES to a positive integer.");
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

  it("mints owner and client invitations beside a live server and enrolls immediately", async () => {
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
      running = await acquireRuntimeLock(directory, "server");
      const administration = createOfflineCredentialService(directory);

      const ownerInvitation = await administration.replaceOwnerInvitation(installation.recoveryCredential);
      const owner = liveAuthority.exchangeInvitation({
        invitation: ownerInvitation,
        retryKey: randomUUID(),
        clientCredential: generateSecret(),
      });
      expect(owner).toMatchObject({ purpose: "owner", serverCapabilities: ["create_cube"] });

      const clientInvitation = await administration.createClientInvitation(installation.recoveryCredential);
      const client = liveAuthority.exchangeInvitation({
        invitation: clientInvitation,
        retryKey: randomUUID(),
        clientCredential: generateSecret(),
      });
      expect(client).toMatchObject({ purpose: "client", serverCapabilities: [] });

      await expect(administration.rotateClient(client!.clientId)).rejects.toThrow(
        "Stop the server before running setup or offline administration.",
      );
      await expect(administration.revokeClient(client!.clientId)).rejects.toThrow(
        "Stop the server before running setup or offline administration.",
      );
      await expect(administration.grantClient(
        client!.clientId,
        "00000000-0000-4000-8000-000000000081",
        "read",
      )).rejects.toThrow("Stop the server before running setup or offline administration.");
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

  it("keeps fresh setup behavior and refuses an existing installation without mutation", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-setup-existing-")));
    try {
      const first = await setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize: false });
      expect(first.recoveryCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(first.initialInvitation).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const before = await Promise.all(Object.values(first.paths).map((path) => readFile(path)));

      await expect(setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize: false }))
        .rejects.toThrow(
          "An installation already exists in BORG_SERVER_DATA_DIR. To destroy and recreate it, stop the server and run borg-mcp-server setup --reinitialize.",
        );
      const after = await Promise.all(Object.values(first.paths).map((path) => readFile(path)));
      expect(after).toEqual(before);
      await expect(access(join(directory, "runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reinitializes only through the explicit destructive path", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-setup-reinitialize-")));
    try {
      const first = await setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize: false });
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

      const second = await setupNodeServerInstallation(directory, "127.0.0.1", { reinitialize: true });
      expect(second.serverId).not.toBe(first.serverId);
      expect(second.caFingerprint).not.toBe(first.caFingerprint);
      expect(await readFile(unrelated, "utf8")).toBe("preserve me");
      const freshRuntime = await openStore({ path: second.paths.database });
      expect(freshRuntime.maintenance.observeAuthorityState()).toMatchObject({
        enrolled_clients: 0,
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

  it("refuses all setup modes while the runtime lock is live", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-setup-live-lock-")));
    try {
      const installation = await setupNodeServerInstallation(directory, "127.0.0.1", {
        reinitialize: false,
      });
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
        )).rejects.toThrow("Stop the server before running setup or offline administration.");
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
      )).rejects.toThrow("Stop the server before running setup or offline administration.");
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
