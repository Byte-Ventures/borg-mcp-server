import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import {
  bootstrapServer,
  loadDigestKey,
  loadTlsPrivateKey,
  type BootstrapResult,
} from "./bootstrap.js";
import {
  CredentialAuthority,
  CredentialDigester,
  type CubeInvitationResult,
} from "./credentials.js";
import { CoordinationApi } from "./coordination-api.js";
import { createDebugLogger, disabledDebugLogger } from "./debug-log.js";
import { MigrationCompatibilityError } from "./migrations.js";
import { createEnrollmentExchange } from "./enrollment.js";
import {
  DEFAULT_SERVICE_LIMITS,
  startHttpsServer,
  type HttpsServerOptions,
  type RunningServer,
} from "./https-server.js";
import { resolveBindOptions } from "./network-policy.js";
import {
  invitationCubeAmbiguousError,
  operatorErrors,
  type OperatorErrorCode,
} from "./operator-error.js";
import { parseStartOptions } from "./start-options.js";
import {
  DEFAULT_STORAGE_LIMITS,
  openStore,
  preparePrivateDataDirectory,
  InvitationCubeAmbiguousError,
  InvitationCubeNotFoundError,
  type LivenessStore,
  type StorageLimits,
} from "./store.js";
import type { CubeAccess } from "./store.js";
import { fileURLToPath } from "node:url";
import { loadRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./runtime-identity.js";
import {
  createRuntimeLifecycle,
  createUnixNpmArtifactUnpacker,
  inspectActiveRuntimeArtifact,
} from "./runtime-lifecycle.js";
import { createRegistryArtifactSource } from "./registry-artifact.js";
import { createRuntimeOperator, type RuntimeUpdateResult } from "./runtime-operator.js";
import { createManagedServiceDefinition } from "./managed-service.js";

export interface ServerService {
  readonly start: (args: readonly string[]) => Promise<void>;
  readonly setup?: (options: SetupOptions) => Promise<ServerSetupResult>;
  readonly status?: () => Promise<ServerRuntimeStatus>;
  readonly update?: () => Promise<RuntimeUpdateResult>;
  readonly rotateClient?: (clientId: string) => Promise<string>;
  readonly revokeClient?: (clientId: string) => Promise<void>;
  readonly grantClient?: (clientId: string, cubeId: string, access: CubeAccess) => Promise<void>;
  readonly ungrantClient?: (clientId: string, cubeId: string) => Promise<void>;
  readonly createClientInvitation?: (
    recoveryCredential: string,
    cubeSelector?: string,
    access?: CubeAccess,
  ) => Promise<string | CubeInvitationResult>;
  readonly replaceOwnerInvitation?: (recoveryCredential: string) => Promise<string>;
}

export interface SetupOptions {
  readonly reinitialize: boolean;
}

export type ServerSetupResult =
  | (BootstrapResult & {
      readonly artifact?: { readonly version: string; readonly integrity: string; readonly sourceSha: string | null };
    })
  | {
      readonly existing: true;
      readonly artifact?: { readonly version: string; readonly integrity: string; readonly sourceSha: string | null };
    };

export interface ServerRuntimeStatus {
  readonly status: "running" | "stopped";
  readonly artifact: { readonly version: string; readonly integrity: string } | null;
  readonly buildIdentity: string | null;
  readonly endpoint: string | null;
  readonly mode: "foreground" | "managed" | "stopped";
  readonly dataIdentity: "available" | "unavailable";
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
  readonly BORG_SERVER_SOURCE_SHA?: string;
  readonly BORG_SERVER_ARTIFACT_INTEGRITY?: string;
  readonly BORG_SERVER_PROCESS_MODE?: "foreground" | "managed";
  readonly BORG_SERVER_RUNTIME_DIR?: string;
}

interface ServiceDependencies {
  readonly environment: ServerEnvironment;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly readPrivateKey: (path: string) => Promise<Buffer>;
  readonly startServer: (options: HttpsServerOptions) => Promise<RunningServer>;
  readonly onStarted: (origin: string, identity: RuntimeBuildIdentity) => void;
  readonly waitForShutdown: (server: RunningServer, signal?: AbortSignal) => Promise<void>;
  readonly debugOutput?: (line: string) => void;
  readonly installShutdownHandlers?: () => { readonly signal: AbortSignal; readonly dispose: () => void };
  readonly openStore?: typeof openStore;
  readonly startLivenessScheduler?: (
    liveness: LivenessStore,
  ) => { readonly stop: () => void };
  readonly onStartupPhase?: (
    phase: "pre-lock" | "post-lock" | "pre-listen",
  ) => Promise<void>;
}

interface RuntimeResources {
  readonly running: RunningServer | undefined;
  readonly authRuntime: Awaited<ReturnType<typeof openStore>> | undefined;
  readonly digester: CredentialDigester | undefined;
  readonly runtimeLock: RuntimeLock | undefined;
  readonly livenessScheduler: { readonly stop: () => void } | undefined;
}

export type RuntimeLockStatus =
  | { readonly running: false }
  | {
      readonly running: true;
      readonly pid: number;
      readonly identity: RuntimeBuildIdentity | null;
      readonly endpoint: string | null;
      readonly mode: "foreground" | "managed";
    };

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
      let bind: ReturnType<typeof parseStartOptions>["bind"];
      let debugLogger = disabledDebugLogger;
      let dataDirectory: string | undefined;
      let storageLimits: StorageLimits;
      try {
        throwIfShutdown(shutdown?.signal);
        await dependencies.onStartupPhase?.("pre-lock");
        throwIfShutdown(shutdown?.signal);
        const parsed = parseStartOptions(args);
        bind = parsed.bind;
        debugLogger = createDebugLogger(parsed.logLevel === "debug" ? dependencies.debugOutput : undefined);
        const resolvedBind = resolveBindOptions(bind);
        const bindMode = resolvedBind.mode;
        dataDirectory = dependencies.environment.BORG_SERVER_DATA_DIR;
        storageLimits = resolveStorageLimits(dependencies.environment);
        debugLogger.emit({
          event: "startup",
          bindMode,
          port: resolvedBind.port,
          dataDirectory: dataDirectory === undefined ? "tls_only" : "configured",
        });
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
      let runtimeIdentity: RuntimeBuildIdentity;
      try {
        runtimeIdentity = await loadRuntimeBuildIdentity({
          ...(dependencies.environment.BORG_SERVER_SOURCE_SHA === undefined
            ? {}
            : { sourceSha: dependencies.environment.BORG_SERVER_SOURCE_SHA }),
          ...(dependencies.environment.BORG_SERVER_ARTIFACT_INTEGRITY === undefined
            ? {}
            : { artifactIntegrity: dependencies.environment.BORG_SERVER_ARTIFACT_INTEGRITY }),
          artifactDescriptorPath: fileURLToPath(new URL("../../artifact.json", import.meta.url)),
        });
        runtimeLock = dataDirectory === undefined
          ? undefined
          : await acquireRuntimeLock(
              dataDirectory,
              "server",
              runtimeIdentity,
              dependencies.environment.BORG_SERVER_PROCESS_MODE ?? "foreground",
            );
        await dependencies.onStartupPhase?.("post-lock");
        throwIfShutdown(shutdown?.signal);
      } catch (error) {
        await runtimeLock?.release().catch(() => undefined);
        shutdown?.dispose();
        if (error instanceof ShutdownRequestedError) return;
        throw error;
      }
      let running: RunningServer | undefined;
      let livenessScheduler: { readonly stop: () => void } | undefined;
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
          authority = new CredentialAuthority(
            authRuntime.credentials,
            digester,
            () => new Date(),
            undefined,
            debugLogger,
          );
          coordinationApi = new CoordinationApi(authRuntime, authority, debugLogger);
        }
        await dependencies.onStartupPhase?.("pre-listen");
        throwIfShutdown(shutdown?.signal);
        running = await dependencies.startServer({
          bind,
          tls: { key, cert, ...(ca === undefined ? {} : { ca }) },
          limits: DEFAULT_SERVICE_LIMITS,
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
          debugLogger,
          runtimeIdentity,
        });
        throwIfShutdown(shutdown?.signal);
        if (authRuntime !== undefined) {
          livenessScheduler = (dependencies.startLivenessScheduler ?? startLivenessScheduler)(
            authRuntime.liveness,
          );
        }
      } catch (error) {
        try {
          await teardownRuntime({ running, authRuntime, digester, runtimeLock, livenessScheduler });
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
        await runtimeLock?.updateOrigin?.(running.origin);
        dependencies.onStarted(running.origin, runtimeIdentity);
        debugLogger.emit({ event: "lifecycle", action: "listening" });
        await dependencies.waitForShutdown(running, shutdown?.signal);
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await teardownRuntime({ running, authRuntime, digester, runtimeLock, livenessScheduler });
        debugLogger.emit({ event: "lifecycle", action: "stopped" });
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
  const sourceSha = environment["BORG_SERVER_SOURCE_SHA"];
  const artifactIntegrity = environment["BORG_SERVER_ARTIFACT_INTEGRITY"];
  const processMode = environment["BORG_SERVER_PROCESS_MODE"];
  const runtimeDirectory = environment["BORG_SERVER_RUNTIME_DIR"];
  if (processMode !== undefined && processMode !== "foreground" && processMode !== "managed") {
    throw new Error("BORG_SERVER_PROCESS_MODE is invalid.");
  }
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
    ...(sourceSha === undefined ? {} : { BORG_SERVER_SOURCE_SHA: sourceSha }),
    ...(artifactIntegrity === undefined ? {} : { BORG_SERVER_ARTIFACT_INTEGRITY: artifactIntegrity }),
    ...(processMode === undefined ? {} : { BORG_SERVER_PROCESS_MODE: processMode }),
    ...(runtimeDirectory === undefined ? {} : { BORG_SERVER_RUNTIME_DIR: runtimeDirectory }),
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
const runtimeDirectory = serverEnvironment.BORG_SERVER_RUNTIME_DIR ?? join(homedir(), ".borg", "server-runtime");
const nodeRuntimeOperator = createNodeRuntimeOperator(runtimeDirectory, dataDirectory);
const startOnlyService = createNodeServerService({
  environment: { ...serverEnvironment, BORG_SERVER_DATA_DIR: dataDirectory },
  readFile,
  readPrivateKey: loadTlsPrivateKey,
  startServer: async (options) => {
    const running = await startHttpsServer(options);
    return nodeServerTestHooks?.wrapRunningServer?.(running) ?? running;
  },
  onStarted: (origin, identity) => {
    if (process.stderr.isTTY !== true || serverEnvironment.BORG_SERVER_PROCESS_MODE === "managed") {
      console.error(JSON.stringify({
        status: "running",
        artifact: `borgmcp-server@${identity.package_version}`,
        artifact_integrity: identity.artifact_integrity,
        build_identity: identity.source_sha,
        endpoint: origin,
        mode: serverEnvironment.BORG_SERVER_PROCESS_MODE ?? "foreground",
        data_identity: "available",
      }));
    } else {
      console.error([
        "Starting verified local server in the foreground.",
        `Artifact: borgmcp-server@${identity.package_version} (${identity.artifact_integrity ?? "unavailable"})`,
        `Build identity: ${identity.source_sha ?? "unavailable"}`,
        `Endpoint: ${origin}`,
        "Data and identity: preserved",
        "Ctrl-C stops the foreground process.",
        "Foreground mode does not manage persistence.",
      ].join("\n"));
    }
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
  debugOutput: (line) => console.error(line),
});
export const nodeServerService: ServerService = {
  start: startOnlyService.start,
  setup: async (options) => {
    const bindHost = resolveSetupBindHost(serverEnvironment);
    if ((await inspectRuntimeLock(dataDirectory)).running) throw operatorErrors.RUNTIME_ACTIVE;
    const artifact = await nodeRuntimeOperator.prepareLatest(30_000);
    const result = await setupNodeServerInstallation(
      dataDirectory,
      bindHost,
      options,
    );
    return {
      ...result,
      artifact: {
        version: artifact.version,
        integrity: artifact.integrity,
        sourceSha: artifact.sourceSha,
      },
    };
  },
  status: () => inspectNodeRuntime(dataDirectory, runtimeDirectory),
  update: () => nodeRuntimeOperator.updateLatest(30_000),
  ...createOfflineCredentialService(dataDirectory),
};

function createNodeRuntimeOperator(managedRuntimeDirectory: string, runtimeDataDirectory: string) {
  const platform = process.platform === "darwin" ? "launchd" : "systemd";
  const definition = createManagedServiceDefinition({
    platform,
    nodeExecutable: process.execPath,
    runtimeRoot: managedRuntimeDirectory,
    dataDirectory: runtimeDataDirectory,
    definitionPath: platform === "launchd"
      ? join(homedir(), "Library", "LaunchAgents", "ai.borgmcp.server.plist")
      : join(homedir(), ".config", "systemd", "user", "ai.borgmcp.server.service"),
    ...(platform === "launchd" ? { launchdDomain: `gui/${process.getuid?.() ?? 0}` } : {}),
  });
  const run = async (command: readonly [string, ...string[]], signal: AbortSignal): Promise<void> => {
    const [executable, ...args] = command;
    await promisify(execFile)(executable, args, {
      signal,
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
  };
  const lifecycle = createRuntimeLifecycle({
    unpack: createUnixNpmArtifactUnpacker(),
    restart: (signal) => run(definition.restart, signal),
    stop: (signal) => run(definition.stop, signal),
    probe: (signal) => waitForRuntimeIdentity(runtimeDataDirectory, signal),
  });
  return createRuntimeOperator({
    runtimeRoot: managedRuntimeDirectory,
    artifacts: createRegistryArtifactSource(),
    lifecycle,
    isRunning: async () => {
      const status = await inspectRuntimeLock(runtimeDataDirectory);
      if (status.running && status.mode !== "managed") {
        throw new Error("Foreground runtime must be stopped before artifact activation.");
      }
      return status.running;
    },
  });
}

async function waitForRuntimeIdentity(
  runtimeDataDirectory: string,
  signal: AbortSignal,
): Promise<RuntimeBuildIdentity> {
  while (!signal.aborted) {
    try {
      const status = await inspectRuntimeLock(runtimeDataDirectory);
      if (status.running && status.identity !== null) return status.identity;
    } catch (error) {
      if (error !== operatorErrors.RUNTIME_LOCK_STALE) throw error;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  throw new Error("Managed runtime identity probe was cancelled.");
}

export async function inspectNodeRuntime(
  runtimeDataDirectory: string,
  managedRuntimeDirectory: string,
): Promise<ServerRuntimeStatus> {
  const [lock, activeArtifact, dataIdentity] = await Promise.all([
    inspectRuntimeLock(runtimeDataDirectory),
    inspectActiveRuntimeArtifact(managedRuntimeDirectory),
    hasDataIdentity(runtimeDataDirectory),
  ]);
  const identity = lock.running ? lock.identity : null;
  const artifact = identity?.artifact_integrity === null || identity === null
    ? activeArtifact === null ? null : { version: activeArtifact.version, integrity: activeArtifact.integrity }
    : { version: identity.package_version, integrity: identity.artifact_integrity };
  return Object.freeze({
    status: lock.running ? "running" : "stopped",
    artifact,
    buildIdentity: identity?.source_sha ?? null,
    endpoint: lock.running ? lock.endpoint : null,
    mode: lock.running ? lock.mode : "stopped",
    dataIdentity,
  });
}

async function hasDataIdentity(directory: string): Promise<"available" | "unavailable"> {
  try {
    const metadata = await lstat(join(directory, "server.json"));
    return metadata.isFile() && !metadata.isSymbolicLink() ? "available" : "unavailable";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unavailable";
    throw error;
  }
}

const managedInstallationFiles = Object.freeze([
  "borg.db",
  "borg.db-wal",
  "borg.db-shm",
  "borg.db-journal",
  "credential-digest.key",
  "ca.key",
  "ca.crt",
  "server.key",
  "server.crt",
  "server.json",
]);

export async function setupNodeServerInstallation(
  setupDataDirectory: string,
  bindHost: string,
  options: SetupOptions,
): Promise<BootstrapResult | { readonly existing: true }> {
  const directory = await preparePrivateDataDirectory(setupDataDirectory);
  const runtimeLock = await acquireRuntimeLock(directory);
  let invitationLock: RuntimeLock | undefined;
  try {
    invitationLock = await acquireInvitationMintLock(directory);
    const existing = await inspectManagedInstallation(directory);
    if (existing.length !== 0 && !options.reinitialize) {
      const names = new Set(existing.map((path) => basename(path)));
      const complete = [
        "borg.db",
        "credential-digest.key",
        "ca.crt",
        "server.key",
        "server.crt",
        "server.json",
      ].every((name) => names.has(name));
      if (!complete) throw operatorErrors.INSTALLATION_EXISTS;
      return Object.freeze({ existing: true });
    }
    if (options.reinitialize) {
      for (const path of existing) await unlink(path);
    }
    return await bootstrapServer(directory, bindHost);
  } finally {
    if (invitationLock === undefined) await runtimeLock.release();
    else await invitationLock.release().finally(() => runtimeLock.release());
  }
}

async function inspectManagedInstallation(directory: string): Promise<string[]> {
  const existing: string[] = [];
  for (const name of managedInstallationFiles) {
    const path = join(directory, name);
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw operatorErrors.DATA_PATH_SYMLINK;
      if (!metadata.isFile()) throw new Error("Managed installation paths must be regular files.");
      existing.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

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
    let invitationLock: RuntimeLock | undefined;
    let runtime: Awaited<ReturnType<typeof openStore>> | undefined;
    let digester: CredentialDigester | undefined;
    try {
      invitationLock = await acquireInvitationMintLock(offlineDataDirectory);
      runtime = await openStore({ path: join(offlineDataDirectory, "borg.db") });
      const digestKey = await loadDigestKey(join(offlineDataDirectory, "credential-digest.key"));
      digester = new CredentialDigester(digestKey);
      digestKey.fill(0);
      return operation(new CredentialAuthority(runtime.credentials, digester), runtime);
    } finally {
      digester?.destroy();
      runtime?.close();
      if (invitationLock === undefined) await runtimeLock.release();
      else await invitationLock.release().finally(() => runtimeLock.release());
    }
  };
  const withInvitationAuthority = async <T>(operation: (authority: CredentialAuthority) => T): Promise<T> => {
    const invitationLock = await acquireInvitationMintLock(offlineDataDirectory);
    let offlineRuntimeLock: RuntimeLock | undefined;
    let runtime: Awaited<ReturnType<typeof openStore>> | undefined;
    let digester: CredentialDigester | undefined;
    try {
      const runtimeState = await invitationRuntimeState(offlineDataDirectory);
      if (runtimeState === "offline") offlineRuntimeLock = await acquireRuntimeLock(offlineDataDirectory);
      runtime = await openStore({
        path: join(offlineDataDirectory, "borg.db"),
        migrationMode: runtimeState === "live" ? "require-current" : "apply",
      });
      const digestKey = await loadDigestKey(join(offlineDataDirectory, "credential-digest.key"));
      digester = new CredentialDigester(digestKey);
      digestKey.fill(0);
      return operation(new CredentialAuthority(runtime.credentials, digester));
    } catch (error) {
      if (error instanceof MigrationCompatibilityError) throw operatorErrors.INVITATION_SCHEMA_MISMATCH;
      if (isSqliteContention(error)) throw operatorErrors.INVITATION_CONTENTION;
      throw error;
    } finally {
      digester?.destroy();
      runtime?.close();
      if (offlineRuntimeLock === undefined) await invitationLock.release();
      else await offlineRuntimeLock.release().finally(() => invitationLock.release());
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
    createClientInvitation: (recoveryCredential, cubeSelector, access) => withInvitationAuthority((authority) => {
      if (cubeSelector === undefined && access !== undefined) {
        throw operatorErrors.INVITATION_CUBE_SELECTOR_INVALID;
      }
      const selector = cubeSelector === undefined ? undefined : parseInvitationCubeSelector(cubeSelector);
      const invitation = selector === undefined
        ? authority.createInvitation(recoveryCredential, 15 * 60_000)
        : authority.createCubeInvitation(recoveryCredential, selector, access ?? "write", 15 * 60_000);
      if (invitation === null) throw operatorErrors.RECOVERY_INVALID;
      return invitation;
    }).catch((error: unknown) => {
      if (error instanceof InvitationCubeNotFoundError) throw operatorErrors.INVITATION_CUBE_NOT_FOUND;
      if (error instanceof InvitationCubeAmbiguousError) {
        throw invitationCubeAmbiguousError(error.candidateIds);
      }
      throw error;
    }),
    replaceOwnerInvitation: (recoveryCredential) => withInvitationAuthority((authority) => {
      const invitation = authority.replaceOwnerInvitation(recoveryCredential, 15 * 60_000);
      if (invitation === null) throw operatorErrors.RECOVERY_INVALID;
      return invitation;
    }),
  };
}

const canonicalCubeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uuidLikeCubeSelector = /^[0-9a-fA-F-]{32,36}$/u;

function parseInvitationCubeSelector(
  value: string,
): { readonly kind: "id" | "name"; readonly value: string } {
  if (canonicalCubeUuid.test(value)) return { kind: "id", value };
  if (value.length === 0 || value.length > 120 || uuidLikeCubeSelector.test(value)) {
    throw operatorErrors.INVITATION_CUBE_SELECTOR_INVALID;
  }
  return { kind: "name", value };
}

interface RuntimeLock {
  readonly release: () => Promise<void>;
  readonly updateOrigin?: (origin: string) => Promise<void>;
}

async function teardownRuntime(resources: RuntimeResources): Promise<void> {
  resources.livenessScheduler?.stop();
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

function startLivenessScheduler(liveness: { readonly scan: () => unknown }): { readonly stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const schedule = (): void => {
    timer = setTimeout(() => {
      if (stopped) return;
      try { liveness.scan(); } catch { /* Retry on the next bounded tick. */ }
      schedule();
    }, 60_000);
    timer.unref();
  };
  schedule();
  return { stop: () => { stopped = true; clearTimeout(timer); } };
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

export async function acquireRuntimeLock(
  runtimeDataDirectory: string,
  purpose: "server" | "exclusive-admin" = "exclusive-admin",
  identity?: RuntimeBuildIdentity,
  mode: "foreground" | "managed" = "foreground",
): Promise<RuntimeLock> {
  const path = join(runtimeDataDirectory, "runtime.lock");
  const nonce = randomUUID();
  try {
    const handle = await open(path, "wx", 0o600);
    const record: {
      readonly pid: number;
      readonly nonce: string;
      readonly purpose: "server" | "exclusive-admin";
      readonly mode: "foreground" | "managed";
      readonly runtime_identity?: RuntimeBuildIdentity;
      endpoint?: string;
    } = {
      pid: process.pid,
      nonce,
      purpose,
      mode,
      ...(identity === undefined ? {} : { runtime_identity: identity }),
    };
    try {
      await handle.writeFile(JSON.stringify(record));
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return {
      updateOrigin: async (origin) => {
        if (!/^https:\/\/(?:\[[0-9a-f:]+\]|[0-9.]+):[0-9]{1,5}$/u.test(origin)) {
          throw new Error("Runtime endpoint is invalid.");
        }
        record.endpoint = origin;
        await handle.truncate(0);
        await handle.write(JSON.stringify(record), 0, "utf8");
        await handle.sync();
      },
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

export async function inspectRuntimeLock(runtimeDataDirectory: string): Promise<RuntimeLockStatus> {
  const path = join(runtimeDataDirectory, "runtime.lock");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ running: false });
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
      metadata.size > 8 * 1024) {
    throw operatorErrors.RUNTIME_LOCK_UNSAFE;
  }
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      pid?: unknown;
      purpose?: unknown;
      runtime_identity?: unknown;
      endpoint?: unknown;
      mode?: unknown;
    };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || value.purpose !== "server" ||
        (value.endpoint !== undefined &&
          (typeof value.endpoint !== "string" || !isRuntimeEndpoint(value.endpoint))) ||
        (value.mode !== "foreground" && value.mode !== "managed")) {
      throw new Error();
    }
    const pid = value.pid as number;
    if (!processIsAlive(pid)) throw operatorErrors.RUNTIME_LOCK_STALE;
    return Object.freeze({
      running: true,
      pid,
      identity: decodeRuntimeLockIdentity(value.runtime_identity),
      endpoint: value.endpoint ?? null,
      mode: value.mode,
    });
  } catch (error) {
    if (error === operatorErrors.RUNTIME_LOCK_STALE) throw error;
    throw operatorErrors.RUNTIME_LOCK_INVALID;
  }
}

function isRuntimeEndpoint(value: string): boolean {
  if (value.length > 512) return false;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" ||
        endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== "") return false;
    const host = endpoint.hostname.startsWith("[") && endpoint.hostname.endsWith("]")
      ? endpoint.hostname.slice(1, -1)
      : endpoint.hostname;
    resolveBindOptions({ host, port: Number(endpoint.port || "443"), lanConsent: true });
    return true;
  } catch {
    return false;
  }
}

function decodeRuntimeLockIdentity(value: unknown): RuntimeBuildIdentity | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  const identity = value as Record<string, unknown>;
  const packageVersion = identity["package_version"];
  const sourceSha = identity["source_sha"];
  const artifactIntegrity = identity["artifact_integrity"];
  const protocolVersion = identity["protocol_version"];
  const startedAt = identity["started_at"];
  if (typeof packageVersion !== "string" ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion) ||
      (sourceSha !== null &&
        (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(sourceSha))) ||
      (artifactIntegrity !== null &&
        (typeof artifactIntegrity !== "string" ||
          !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(artifactIntegrity))) ||
      typeof protocolVersion !== "string" || protocolVersion.length < 1 || protocolVersion.length > 32 ||
      typeof startedAt !== "string" || startedAt.length > 64 ||
      !Number.isFinite(Date.parse(startedAt)) || new Date(startedAt).toISOString() !== startedAt) {
    throw new Error();
  }
  return Object.freeze({
    package_version: packageVersion,
    source_sha: sourceSha as string | null,
    artifact_integrity: artifactIntegrity as string | null,
    protocol_version: protocolVersion,
    started_at: startedAt,
  });
}

export async function acquireInvitationMintLock(runtimeDataDirectory: string): Promise<RuntimeLock> {
  const path = join(runtimeDataDirectory, "invitation-mint.lock");
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
    throw operatorErrors.INVITATION_BUSY;
  }
}

async function invitationRuntimeState(runtimeDataDirectory: string): Promise<"live" | "offline"> {
  const path = join(runtimeDataDirectory, "runtime.lock");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "offline";
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw operatorErrors.RUNTIME_LOCK_UNSAFE;
  }
  let pid: number;
  let purpose: unknown;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; purpose?: unknown };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) throw new Error();
    pid = value.pid as number;
    purpose = value.purpose;
  } catch {
    throw operatorErrors.RUNTIME_LOCK_INVALID;
  }
  if (!processIsAlive(pid)) throw operatorErrors.RUNTIME_LOCK_STALE;
  if (purpose !== "server") throw operatorErrors.RUNTIME_ACTIVE;
  return "live";
}

function isSqliteContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; errcode?: unknown };
  return value.code === "ERR_SQLITE_ERROR" && (value.errcode === 5 || value.errcode === 6);
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
