import { randomUUID } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  bootstrapServer,
  loadDigestKey,
  loadTlsPrivateKey,
  type BootstrapResult,
} from "./bootstrap.js";
import { CredentialAuthority, CredentialDigester } from "./credentials.js";
import { CoordinationApi } from "./coordination-api.js";
import { createEnrollmentExchange } from "./enrollment.js";
import {
  DEFAULT_SERVICE_LIMITS,
  startHttpsServer,
  type HttpsServerOptions,
  type RunningServer,
} from "./https-server.js";
import { createPart2ProtocolInfo } from "./protocol-draft.js";
import { resolveBindOptions } from "./network-policy.js";
import { operatorErrors, type OperatorErrorCode } from "./operator-error.js";
import { parseStartOptions } from "./start-options.js";
import { DEFAULT_STORAGE_LIMITS, openStore, type StorageLimits } from "./store.js";
import type { CubeAccess } from "./store.js";

export interface ServerService {
  readonly start: (args: readonly string[]) => Promise<void>;
  readonly setup?: () => Promise<BootstrapResult>;
  readonly rotateClient?: (clientId: string) => Promise<string>;
  readonly revokeClient?: (clientId: string) => Promise<void>;
  readonly grantClient?: (clientId: string, cubeId: string, access: CubeAccess) => Promise<void>;
  readonly ungrantClient?: (clientId: string, cubeId: string) => Promise<void>;
  readonly createClientInvitation?: (recoveryCredential: string) => Promise<string>;
  readonly replaceOwnerInvitation?: (recoveryCredential: string) => Promise<string>;
}

export interface ServerEnvironment {
  readonly BORG_SERVER_TLS_KEY_FILE?: string;
  readonly BORG_SERVER_TLS_CERT_FILE?: string;
  readonly BORG_SERVER_TLS_CA_FILE?: string;
  readonly BORG_SERVER_DATA_DIR?: string;
  readonly BORG_SERVER_BIND_HOST?: string;
  readonly BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE?: string;
  readonly BORG_SERVER_MAX_DATABASE_BYTES?: string;
  readonly BORG_SERVER_MIN_FREE_DISK_BYTES?: string;
}

interface ServiceDependencies {
  readonly environment: ServerEnvironment;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly readPrivateKey: (path: string) => Promise<Buffer>;
  readonly startServer: (options: HttpsServerOptions) => Promise<RunningServer>;
  readonly onStarted: (origin: string) => void;
  readonly waitForShutdown: (server: RunningServer, signal?: AbortSignal) => Promise<void>;
  readonly installShutdownHandlers?: () => { readonly signal: AbortSignal; readonly dispose: () => void };
  readonly openStore?: typeof openStore;
  readonly onStartupPhase?: (
    phase: "pre-lock" | "post-lock" | "pre-listen",
  ) => Promise<void>;
}

interface RuntimeResources {
  readonly running: RunningServer | undefined;
  readonly authRuntime: Awaited<ReturnType<typeof openStore>> | undefined;
  readonly digester: CredentialDigester | undefined;
  readonly runtimeLock: RuntimeLock | undefined;
}

const guardedRuntimeFailures = new Set<RuntimeResources>();

export interface NodeServerTestHooks {
  readonly onStartupPhase?: (phase: "pre-lock" | "post-lock" | "pre-listen") => Promise<void>;
  readonly onSignalObserved?: () => void;
  readonly onListening?: (origin: string) => void;
  readonly wrapRunningServer?: (running: RunningServer) => RunningServer;
}

let nodeServerTestHooks: NodeServerTestHooks | undefined;

export function installNodeServerTestHooks(hooks: NodeServerTestHooks): () => void {
  if (nodeServerTestHooks !== undefined) throw new Error("Node server test hooks are already installed.");
  nodeServerTestHooks = Object.freeze({ ...hooks });
  return () => {
    nodeServerTestHooks = undefined;
  };
}

export function createNodeServerService(dependencies: ServiceDependencies): ServerService {
  return {
    async start(args): Promise<void> {
      const shutdown = dependencies.installShutdownHandlers?.();
      let bind: ReturnType<typeof parseStartOptions>;
      let dataDirectory: string | undefined;
      let storageLimits: StorageLimits;
      try {
        throwIfShutdown(shutdown?.signal);
        await dependencies.onStartupPhase?.("pre-lock");
        throwIfShutdown(shutdown?.signal);
        bind = parseStartOptions(args);
        const bindMode = resolveBindOptions(bind).mode;
        dataDirectory = dependencies.environment.BORG_SERVER_DATA_DIR;
        storageLimits = resolveStorageLimits(dependencies.environment);
        if (bindMode === "lan" && dataDirectory !== undefined) {
          await assertLanCaKeyOffline(dataDirectory);
          throwIfShutdown(shutdown?.signal);
        }
      } catch (error) {
        shutdown?.dispose();
        if (error instanceof ShutdownRequestedError) return;
        throw error;
      }
      const keyPath = dependencies.environment.BORG_SERVER_TLS_KEY_FILE ??
        (dataDirectory === undefined ? undefined : join(dataDirectory, "server.key"));
      const certificatePath = dependencies.environment.BORG_SERVER_TLS_CERT_FILE ??
        (dataDirectory === undefined ? undefined : join(dataDirectory, "server.crt"));
      const caPath = dependencies.environment.BORG_SERVER_TLS_CA_FILE ??
        (dataDirectory === undefined ? undefined : join(dataDirectory, "ca.crt"));
      if (keyPath === undefined || certificatePath === undefined) {
        shutdown?.dispose();
        throw operatorErrors.SERVER_FILES_MISSING;
      }

      let runtimeLock: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;
      try {
        runtimeLock = dataDirectory === undefined ? undefined : await acquireRuntimeLock(dataDirectory);
        await dependencies.onStartupPhase?.("post-lock");
        throwIfShutdown(shutdown?.signal);
      } catch (error) {
        await runtimeLock?.release().catch(() => undefined);
        shutdown?.dispose();
        if (error instanceof ShutdownRequestedError) return;
        throw error;
      }
      let running: RunningServer | undefined;
      let key: Buffer | undefined;
      try {
        throwIfShutdown(shutdown?.signal);
        key = await dependencies.readPrivateKey(keyPath);
        throwIfShutdown(shutdown?.signal);
      } catch (error) {
        key?.fill(0);
        await runtimeLock?.release().catch(() => undefined);
        shutdown?.dispose();
        if (error instanceof ShutdownRequestedError) return;
        throw error;
      }
      if (key === undefined) throw new Error("TLS private key is unavailable.");
      let authRuntime: Awaited<ReturnType<typeof openStore>> | undefined;
      let digester: CredentialDigester | undefined;
      try {
        const cert = await dependencies.readFile(certificatePath);
        throwIfShutdown(shutdown?.signal);
        const ca = caPath === undefined ? undefined : await dependencies.readFile(caPath);
        throwIfShutdown(shutdown?.signal);
        let authority: CredentialAuthority | undefined;
        let coordinationApi: CoordinationApi | undefined;
        if (dataDirectory !== undefined) {
          authRuntime = await (dependencies.openStore ?? openStore)({
            path: join(dataDirectory, "borg.db"),
            storageLimits,
          });
          throwIfShutdown(shutdown?.signal);
          const digestKey = await loadDigestKey(join(dataDirectory, "credential-digest.key"));
          try {
            throwIfShutdown(shutdown?.signal);
            digester = new CredentialDigester(digestKey);
          } finally {
            digestKey.fill(0);
          }
          authority = new CredentialAuthority(authRuntime.credentials, digester);
          coordinationApi = new CoordinationApi(authRuntime, authority);
        }
        await dependencies.onStartupPhase?.("pre-listen");
        throwIfShutdown(shutdown?.signal);
        running = await dependencies.startServer({
          bind,
          tls: { key, cert, ...(ca === undefined ? {} : { ca }) },
          limits: DEFAULT_SERVICE_LIMITS,
          protocolInfo: createPart2ProtocolInfo(DEFAULT_SERVICE_LIMITS),
          authorizeProtocol: async (authorization) => {
            if (authority === undefined) return false;
            const result = authority.authenticateStatus(authorization);
            return typeof result === "object" ? true : result;
          },
          ...(authority === undefined
            ? {}
            : { exchangeEnrollment: createEnrollmentExchange(authority) }),
          ...(authority === undefined
            ? {}
            : {
                authorizeCoordination: async (authorization: string | undefined) => {
                  return authority.authenticateStatus(authorization);
                },
              }),
          ...(coordinationApi === undefined
            ? {}
            : { handleCoordination: (request) => coordinationApi.handle(request) }),
        });
        throwIfShutdown(shutdown?.signal);
      } catch (error) {
        try {
          await teardownRuntime({ running, authRuntime, digester, runtimeLock });
        } catch (cleanupError) {
          shutdown?.dispose();
          throw fatalTeardownError(error, cleanupError);
        }
        shutdown?.dispose();
        if (error instanceof ShutdownRequestedError) return;
        throw error;
      } finally {
        key.fill(0);
      }
      let failed = false;
      let failure: unknown;
      try {
        throwIfShutdown(shutdown?.signal);
        dependencies.onStarted(running.origin);
        await dependencies.waitForShutdown(running, shutdown?.signal);
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await teardownRuntime({ running, authRuntime, digester, runtimeLock });
      } catch (cleanupError) {
        shutdown?.dispose();
        throw fatalTeardownError(failed ? failure : undefined, cleanupError);
      }
      shutdown?.dispose();
      if (failure instanceof ShutdownRequestedError) return;
      if (failed) throw failure;
    },
  };
}

export async function assertLanCaKeyOffline(runtimeDataDirectory: string): Promise<void> {
  try {
    await lstat(join(runtimeDataDirectory, "ca.key"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw operatorErrors.LAN_CA_KEY_ONLINE;
}

export function selectServerEnvironment(environment: NodeJS.ProcessEnv): ServerEnvironment {
  const keyFile = environment["BORG_SERVER_TLS_KEY_FILE"];
  const certificateFile = environment["BORG_SERVER_TLS_CERT_FILE"];
  const caFile = environment["BORG_SERVER_TLS_CA_FILE"];
  const dataDirectory = environment["BORG_SERVER_DATA_DIR"];
  const bindHost = environment["BORG_SERVER_BIND_HOST"];
  const maxActivityEntries = environment["BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE"];
  const maxDatabaseBytes = environment["BORG_SERVER_MAX_DATABASE_BYTES"];
  const minFreeDiskBytes = environment["BORG_SERVER_MIN_FREE_DISK_BYTES"];
  return {
    ...(keyFile === undefined ? {} : { BORG_SERVER_TLS_KEY_FILE: keyFile }),
    ...(certificateFile === undefined
      ? {}
      : { BORG_SERVER_TLS_CERT_FILE: certificateFile }),
    ...(caFile === undefined ? {} : { BORG_SERVER_TLS_CA_FILE: caFile }),
    ...(dataDirectory === undefined ? {} : { BORG_SERVER_DATA_DIR: dataDirectory }),
    ...(bindHost === undefined ? {} : { BORG_SERVER_BIND_HOST: bindHost }),
    ...(maxActivityEntries === undefined
      ? {}
      : { BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE: maxActivityEntries }),
    ...(maxDatabaseBytes === undefined ? {} : { BORG_SERVER_MAX_DATABASE_BYTES: maxDatabaseBytes }),
    ...(minFreeDiskBytes === undefined ? {} : { BORG_SERVER_MIN_FREE_DISK_BYTES: minFreeDiskBytes }),
  };
}

export function resolveStorageLimits(environment: ServerEnvironment): StorageLimits {
  return {
    maxActivityEntriesPerCube: positiveEnvironmentInteger(
      environment.BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE,
      DEFAULT_STORAGE_LIMITS.maxActivityEntriesPerCube,
      "BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE",
    ),
    maxDatabaseBytes: positiveEnvironmentInteger(
      environment.BORG_SERVER_MAX_DATABASE_BYTES,
      DEFAULT_STORAGE_LIMITS.maxDatabaseBytes,
      "BORG_SERVER_MAX_DATABASE_BYTES",
    ),
    minFreeDiskBytes: positiveEnvironmentInteger(
      environment.BORG_SERVER_MIN_FREE_DISK_BYTES,
      DEFAULT_STORAGE_LIMITS.minFreeDiskBytes,
      "BORG_SERVER_MIN_FREE_DISK_BYTES",
    ),
  };
}

function positiveEnvironmentInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const code = storageOperatorErrorCode(name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw operatorErrors[code];
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw operatorErrors[code];
  return parsed;
}

function storageOperatorErrorCode(name: string): OperatorErrorCode {
  if (name === "BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE") return "ACTIVITY_LIMIT_INVALID";
  if (name === "BORG_SERVER_MAX_DATABASE_BYTES") return "DATABASE_LIMIT_INVALID";
  if (name === "BORG_SERVER_MIN_FREE_DISK_BYTES") return "DISK_RESERVE_INVALID";
  throw new Error("Unknown storage environment setting.");
}

const serverEnvironment = selectServerEnvironment(process.env);
const dataDirectory = serverEnvironment.BORG_SERVER_DATA_DIR ?? join(homedir(), ".borg", "server");
const startOnlyService = createNodeServerService({
  environment: { ...serverEnvironment, BORG_SERVER_DATA_DIR: dataDirectory },
  readFile,
  readPrivateKey: loadTlsPrivateKey,
  startServer: async (options) => {
    const running = await startHttpsServer(options);
    return nodeServerTestHooks?.wrapRunningServer?.(running) ?? running;
  },
  onStarted: (origin) => {
    console.error(`Borg server listening on ${origin}`);
    nodeServerTestHooks?.onListening?.(origin);
  },
  onStartupPhase: (phase) => nodeServerTestHooks?.onStartupPhase?.(phase) ?? Promise.resolve(),
  installShutdownHandlers: () => {
    const handlers = installProcessShutdownHandlers();
    handlers.signal.addEventListener("abort", () => nodeServerTestHooks?.onSignalObserved?.(), {
      once: true,
    });
    return handlers;
  },
  waitForShutdown,
});
export const nodeServerService: ServerService = {
  start: startOnlyService.start,
  setup: () => bootstrapServer(dataDirectory, resolveSetupBindHost(serverEnvironment)),
  ...createOfflineCredentialService(dataDirectory),
};

function resolveSetupBindHost(environment: ServerEnvironment): string {
  return resolveBindOptions({
    ...(environment.BORG_SERVER_BIND_HOST === undefined
      ? {}
      : { host: environment.BORG_SERVER_BIND_HOST }),
    lanConsent: true,
  }).host;
}

export function createOfflineCredentialService(
  offlineDataDirectory: string,
): Pick<Required<ServerService>,
  "rotateClient" | "revokeClient" | "grantClient" | "ungrantClient" |
  "createClientInvitation" | "replaceOwnerInvitation"
> {
  const withAuthority = async <T>(operation: (
    authority: CredentialAuthority,
    runtime: Awaited<ReturnType<typeof openStore>>,
  ) => T): Promise<T> => {
    const runtimeLock = await acquireRuntimeLock(offlineDataDirectory);
    let runtime: Awaited<ReturnType<typeof openStore>> | undefined;
    let digester: CredentialDigester | undefined;
    try {
      runtime = await openStore({ path: join(offlineDataDirectory, "borg.db") });
      const digestKey = await loadDigestKey(join(offlineDataDirectory, "credential-digest.key"));
      digester = new CredentialDigester(digestKey);
      digestKey.fill(0);
      return operation(new CredentialAuthority(runtime.credentials, digester), runtime);
    } finally {
      digester?.destroy();
      runtime?.close();
      await runtimeLock.release();
    }
  };
  return {
    rotateClient: (clientId) => withAuthority((authority) => authority.rotateClient(clientId)),
    revokeClient: (clientId) => withAuthority((authority) => authority.revokeClient(clientId)),
    grantClient: (clientId, cubeId, access) => withAuthority((_authority, runtime) => {
      if (!runtime.credentials.clientIsActive(clientId)) {
        throw operatorErrors.CLIENT_NOT_FOUND;
      }
      runtime.maintenance.grantClientCube({ clientId, cubeId, access });
    }),
    ungrantClient: (clientId, cubeId) => withAuthority((_authority, runtime) => {
      if (!runtime.credentials.clientIsActive(clientId)) throw operatorErrors.CLIENT_NOT_FOUND;
      if (!runtime.maintenance.removeClientCubeGrant(clientId, cubeId)) {
        throw operatorErrors.GRANT_NOT_FOUND;
      }
    }),
    createClientInvitation: (recoveryCredential) => withAuthority((authority) => {
      const invitation = authority.createInvitation(recoveryCredential, 15 * 60_000);
      if (invitation === null) throw operatorErrors.RECOVERY_INVALID;
      return invitation;
    }),
    replaceOwnerInvitation: (recoveryCredential) => withAuthority((authority) => {
      const invitation = authority.replaceOwnerInvitation(recoveryCredential, 15 * 60_000);
      if (invitation === null) throw operatorErrors.RECOVERY_INVALID;
      return invitation;
    }),
  };
}

interface RuntimeLock {
  readonly release: () => Promise<void>;
}

async function teardownRuntime(resources: RuntimeResources): Promise<void> {
  try {
    await resources.running?.close();
  } catch (error) {
    guardedRuntimeFailures.add(Object.freeze({ ...resources }));
    throw error;
  }
  try {
    resources.authRuntime?.close();
    resources.digester?.destroy();
  } catch (error) {
    guardedRuntimeFailures.add(Object.freeze({ ...resources, running: undefined }));
    throw error;
  }
  await resources.runtimeLock?.release();
}

const fatalTeardownErrors = new WeakSet<object>();
const fatalTeardownCapability = Object.freeze({});

class FatalTeardownError extends AggregateError {
  constructor(capability: object, primary: unknown, cleanup: unknown) {
    super(
      primary === undefined ? [cleanup] : [primary, cleanup],
      "Server teardown could not be confirmed; the runtime remains locked.",
    );
    if (capability !== fatalTeardownCapability) {
      throw new Error("Fatal teardown error construction is unavailable.");
    }
    this.name = "FatalTeardownError";
    fatalTeardownErrors.add(this);
    Object.freeze(this);
  }
}

export function isFatalTeardownError(error: unknown): boolean {
  return typeof error === "object" && error !== null && fatalTeardownErrors.has(error);
}

function fatalTeardownError(primary: unknown, cleanup: unknown): FatalTeardownError {
  return new FatalTeardownError(fatalTeardownCapability, primary, cleanup);
}

export async function acquireRuntimeLock(runtimeDataDirectory: string): Promise<RuntimeLock> {
  const path = join(runtimeDataDirectory, "runtime.lock");
  const nonce = randomUUID();
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return {
      release: async () => {
        await handle.close();
        try {
          const current = JSON.parse(await readFile(path, "utf8")) as { nonce?: unknown };
          if (current.nonce === nonce) await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw operatorErrors.RUNTIME_LOCK_UNSAFE;
    }
    let pid: number;
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
      if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) throw new Error();
      pid = value.pid as number;
    } catch {
      throw operatorErrors.RUNTIME_LOCK_INVALID;
    }
    if (processIsAlive(pid)) throw operatorErrors.RUNTIME_ACTIVE;
    throw operatorErrors.RUNTIME_LOCK_STALE;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

class ShutdownRequestedError extends Error {}

function throwIfShutdown(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ShutdownRequestedError("Server shutdown requested.");
}

export function installProcessShutdownHandlers(): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}

function waitForShutdown(_server: RunningServer, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}
