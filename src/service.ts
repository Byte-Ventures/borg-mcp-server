import { createPrivateKey, createPublicKey, randomUUID, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import {
  bootstrapServer,
  loadDigestKey,
  loadTlsPrivateKey,
  reissueServerCertificate,
  type PreservedCertificateAuthority,
  type BootstrapResult,
} from "./bootstrap.js";
import {
  CredentialAuthority,
  CredentialDigester,
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
  portableCredentialAccountHasNonOwner,
  readPortableServerCredentialForTrustIdentity,
  rebindPortableServerCredential,
  type PortableServerCredential,
  writePortableServerCredential,
} from "./portable-credential-store.js";
import { operatorErrors, type OperatorErrorCode } from "./operator-error.js";
import { parseStartOptions } from "./start-options.js";
import {
  DEFAULT_STORAGE_LIMITS,
  openStore,
  preparePrivateDataDirectory,
  type ClientAdministrationRecord,
  type LivenessStore,
  type StorageLimits,
} from "./store.js";
import type { CubeAccess } from "./store.js";
import { fileURLToPath } from "node:url";
import {
  loadRuntimeBuildIdentity,
  SERVER_PACKAGE_VERSION,
  type RuntimeBuildIdentity,
} from "./runtime-identity.js";
import {
  createRuntimeLifecycle,
  createUnixNpmArtifactUnpacker,
  inspectActiveRuntimeArtifact,
} from "./runtime-lifecycle.js";
import { createRegistryArtifactSource } from "./registry-artifact.js";
import { createRuntimeOperator, type RuntimeUpdateResult } from "./runtime-operator.js";
import {
  createManagedServiceDefinition,
  type ManagedServiceDefinition,
  type ManagedServicePlatform,
} from "./managed-service.js";
import {
  installManagedService,
  type ManagedServiceInstallResult,
} from "./managed-service-install.js";
import {
  uninstallManagedService,
  type ManagedServiceUninstallResult,
} from "./managed-service-uninstall.js";
import {
  createDashboardRenderer,
  dashboardColorEnabled,
  EMBEDDED_DASHBOARD_FOOTER,
  STANDALONE_DASHBOARD_FOOTER,
  rankDashboardSnapshot,
  renderPlainDashboard,
  selectDashboardGlyphMode,
  startForegroundDashboard,
  type DashboardServerIdentity,
  type DashboardSnapshotSource,
  type DashboardTerminal,
  type ForegroundDashboard,
} from "./dashboard.js";
import {
  assertReadonlyDashboardInstallation,
  openReadonlyDashboardSnapshotSource,
} from "./dashboard-source.js";

export interface ServerService {
  readonly start: (args: readonly string[]) => Promise<void>;
  readonly dashboard?: (options: DashboardCommandOptions) => Promise<void>;
  readonly setup?: (options: SetupOptions) => Promise<ServerSetupResult>;
  readonly status?: () => Promise<ServerRuntimeStatus>;
  readonly installService?: () => Promise<ManagedServiceInstallResult>;
  readonly uninstallService?: () => Promise<ManagedServiceUninstallResult>;
  readonly update?: () => Promise<ServerUpdateResult>;
  readonly recoverStaleLock?: () => Promise<StaleRuntimeLockRecovery>;
  readonly rotateClient?: (clientId: string) => Promise<string>;
  readonly listClients?: () => Promise<readonly ClientAdministrationRecord[]>;
  readonly revokeClient?: (clientSelector: string) => Promise<void>;
  readonly grantClient?: (clientSelector: string, cubeId: string, access: CubeAccess) => Promise<void>;
  readonly ungrantClient?: (clientSelector: string, cubeId: string) => Promise<void>;
  readonly invite?: (clientName?: string) => Promise<InvitationResult>;
  readonly reissueCertificate?: (additionalHost: string) => Promise<CertificateReissueResult>;
}

export interface DashboardCommandOptions {
  readonly ascii: boolean;
}

export interface SetupOptions {
  readonly reinitialize: boolean;
}

export interface CertificateReissueResult {
  readonly caFingerprint: string;
  readonly hosts: readonly string[];
}

export interface InvitationResult {
  readonly invitation: string;
  readonly endpoint: string;
  readonly loopbackOnly: boolean;
}

export type ServerSetupResult =
  | (Omit<BootstrapResult, "initialInvitation"> & {
      readonly artifact?: { readonly version: string; readonly integrity: string; readonly sourceSha: string | null };
    })
  | {
      readonly existing: true;
      readonly bindHost: string;
      readonly artifact?: { readonly version: string; readonly integrity: string; readonly sourceSha: string | null };
    };

export interface ServerRuntimeStatus {
  readonly status: "running" | "stopped";
  readonly controllerVersion: string;
  readonly preparedArtifact: { readonly version: string; readonly integrity: string } | null;
  readonly runningArtifact: { readonly version: string; readonly integrity: string | null } | null;
  readonly buildIdentity: string | null;
  readonly endpoint: string | null;
  readonly mode: "foreground" | "managed" | "legacy" | "stopped";
  readonly serviceAdapter: "launchd" | "systemd" | null;
  readonly serviceState: "active" | "inactive" | "absent";
  readonly serviceRecoveryCommand: readonly [string, ...string[]] | null;
  readonly runtimeLock: ServerRuntimeLockDiagnostic;
  readonly dataIdentity: "available" | "unavailable";
  readonly nextAction: ServerNextAction | null;
}

export type ServerNextAction =
  | { readonly kind: "update-runtime" }
  | { readonly kind: "install-controller"; readonly version: string };

export interface ServerUpdateResult extends RuntimeUpdateResult {
  readonly controllerVersion: string;
  readonly serviceAdapter: "launchd" | "systemd" | null;
  readonly serviceState: "active" | "inactive" | "absent";
  readonly serviceRecoveryCommand: readonly [string, ...string[]] | null;
  readonly nextAction: ServerNextAction | null;
}

export type ManagedServiceStatus =
  | {
      readonly state: "active";
      readonly adapter: ManagedServicePlatform;
      readonly recoveryCommand: null;
    }
  | {
      readonly state: "inactive";
      readonly adapter: ManagedServicePlatform;
      readonly recoveryCommand: readonly [string, ...string[]];
    }
  | {
      readonly state: "absent";
      readonly adapter: null;
      readonly recoveryCommand: null;
    };

export interface StaleRuntimeLockEvidence {
  readonly pid: number;
  readonly identity: RuntimeBuildIdentity;
  readonly endpoint: string | null;
  readonly mode: "foreground" | "managed" | "legacy";
}

export type ServerRuntimeLockDiagnostic =
  | { readonly state: "clear" }
  | {
      readonly state: "stale";
      readonly pid: number;
      readonly processState: "absent";
      readonly identity: RuntimeBuildIdentity;
      readonly endpoint: string | null;
      readonly mode: "foreground" | "managed" | "legacy";
      readonly recoveryAction: "borg-mcp-server recover-stale-lock";
    };

export interface StaleRuntimeLockRecovery {
  readonly backupPath: string;
  readonly stale: StaleRuntimeLockEvidence;
}

interface ServerStopResult {
  readonly outcome: "stopped" | "already-stopped" | "foreground-action-required";
}

export interface ServerEnvironment {
  readonly BORG_SERVER_TLS_KEY_FILE?: string;
  readonly BORG_SERVER_TLS_CERT_FILE?: string;
  readonly BORG_SERVER_TLS_CA_FILE?: string;
  readonly BORG_SERVER_DATA_DIR?: string;
  readonly BORG_SERVER_BIND_HOST?: string;
  readonly BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE?: string;
  readonly BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE?: string;
  readonly BORG_SERVER_CONTEXT_GUIDELINE_BYTES?: string;
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
  readonly onStarted: (
    origin: string,
    identity: RuntimeBuildIdentity,
    binding: ServerBindOutput,
  ) => void;
  readonly bindOwnerCredential?: (origin: string) => Promise<void>;
  readonly startForegroundDashboard?: (input: {
    readonly source: DashboardSnapshotSource;
    readonly server: DashboardServerIdentity;
    readonly asciiRequested: boolean;
  }) => ForegroundDashboard | undefined;
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

export interface ServerBindOutput {
  readonly bindHost: string | null;
  readonly bindMode: "loopback" | "lan";
  readonly remedy: string | null;
}

interface RuntimeResources {
  readonly running: RunningServer | undefined;
  readonly authRuntime: Awaited<ReturnType<typeof openStore>> | undefined;
  readonly digester: CredentialDigester | undefined;
  readonly runtimeLock: RuntimeLock | undefined;
  readonly livenessScheduler: { readonly stop: () => void } | undefined;
  readonly dashboard: ForegroundDashboard | undefined;
}

export type RuntimeLockStatus =
  | { readonly running: false; readonly stale?: StaleRuntimeLockEvidence }
  | {
      readonly running: true;
      readonly pid: number;
      readonly identity: RuntimeBuildIdentity | null;
      readonly endpoint: string | null;
      readonly mode: "foreground" | "managed" | "legacy";
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
      let asciiRequested = false;
      let compatibilityLoopbackHost: "127.0.0.1" | "::1" | undefined;
      let bindMode: "loopback" | "lan";
      let preparedBindHost: string | null = null;
      let bindRemedy: string | null = null;
      try {
        throwIfShutdown(shutdown?.signal);
        await dependencies.onStartupPhase?.("pre-lock");
        throwIfShutdown(shutdown?.signal);
        const parsed = parseStartOptions(args);
        bind = parsed.bind;
        asciiRequested = parsed.ascii;
        debugLogger = createDebugLogger(parsed.logLevel === "debug" ? dependencies.debugOutput : undefined);
        const resolvedBind = resolveBindOptions(bind);
        bindMode = resolvedBind.mode;
        dataDirectory = dependencies.environment.BORG_SERVER_DATA_DIR;
        storageLimits = resolveStorageLimits(dependencies.environment);
        debugLogger.emit({
          event: "startup",
          bindMode,
          port: resolvedBind.port,
          dataDirectory: dataDirectory === undefined ? "tls_only" : "configured",
        });
        if (dataDirectory !== undefined) {
          const installationConfig = JSON.parse(
            (await readFile(join(dataDirectory, "server.json"))).toString("utf8"),
          ) as { readonly bind_host?: unknown };
          if (typeof installationConfig.bind_host !== "string") {
            throw new Error("Server identity is invalid.");
          }
          preparedBindHost = installationConfig.bind_host;
          const preparedBind = resolveBindOptions({
            host: installationConfig.bind_host,
            lanConsent: true,
          });
          if (bindMode === "loopback" && preparedBind.mode === "lan") {
            bindRemedy = `borg server start --host ${installationConfig.bind_host} --lan`;
          }
          if (bindMode === "lan") {
            compatibilityLoopbackHost = installationConfig.bind_host.includes(":") ? "::1" : "127.0.0.1";
            await assertLanCaKeyOffline(dataDirectory);
            throwIfShutdown(shutdown?.signal);
          }
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
      let dashboard: ForegroundDashboard | undefined;
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
          coordinationApi = new CoordinationApi(
            authRuntime,
            authority,
            debugLogger,
            undefined,
            storageLimits.contextGuidelineBytes,
          );
        }
        await dependencies.onStartupPhase?.("pre-listen");
        throwIfShutdown(shutdown?.signal);
        const serverOptions = {
          bind,
          tls: { key, cert, ...(ca === undefined ? {} : { ca }) },
          limits: DEFAULT_SERVICE_LIMITS,
          ...(authority === undefined
            ? {}
             : { exchangeEnrollment: createEnrollmentExchange(authority, false) }),
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
        } satisfies HttpsServerOptions;
        running = await dependencies.startServer(serverOptions);
        if (resolveBindOptions(bind).mode === "lan") {
          const primary = running;
          const loopback = await dependencies.startServer({
            ...serverOptions,
            bind: {
              host: compatibilityLoopbackHost ?? (bind.host?.includes(":") === true ? "::1" : "127.0.0.1"),
              port: runtimeOriginPort(primary.origin),
            },
          });
          running = {
            origin: primary.origin,
            limits: primary.limits,
            close: async () => {
              await Promise.all([primary.close(), loopback.close()]);
            },
          };
        }
        throwIfShutdown(shutdown?.signal);
        if (authRuntime !== undefined) {
          livenessScheduler = (dependencies.startLivenessScheduler ?? startLivenessScheduler)(
            authRuntime.liveness,
          );
        }
      } catch (error) {
        try {
          await teardownRuntime({
            running,
            authRuntime,
            digester,
            runtimeLock,
            livenessScheduler,
            dashboard,
          });
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
        await dependencies.bindOwnerCredential?.(running.origin);
        throwIfShutdown(shutdown?.signal);
        await runtimeLock?.updateOrigin?.(running.origin);
        dependencies.onStarted(running.origin, runtimeIdentity, {
          bindHost: preparedBindHost,
          bindMode,
          remedy: bindRemedy,
        });
        if (authRuntime !== undefined) {
          dashboard = dependencies.startForegroundDashboard?.({
            source: authRuntime.dashboard,
            server: Object.freeze({
              name: "borgmcp-server",
              version: runtimeIdentity.package_version,
              endpoint: running.origin,
              bind_mode: bindMode,
              state: "online",
              started_at: new Date().toISOString(),
            }),
            asciiRequested,
          });
        }
        debugLogger.emit({ event: "lifecycle", action: "listening" });
        const shutdownWait = dependencies.waitForShutdown(running, shutdown?.signal);
        if (dashboard === undefined) await shutdownWait;
        else await Promise.race([shutdownWait, dashboard.failure]);
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await teardownRuntime({
          running,
          authRuntime,
          digester,
          runtimeLock,
          livenessScheduler,
          dashboard,
        });
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
  const maxActiveDecisionBytes = environment["BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE"];
  const contextGuidelineBytes = environment["BORG_SERVER_CONTEXT_GUIDELINE_BYTES"];
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
    ...(maxActiveDecisionBytes === undefined
      ? {}
      : { BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE: maxActiveDecisionBytes }),
    ...(contextGuidelineBytes === undefined
      ? {}
      : { BORG_SERVER_CONTEXT_GUIDELINE_BYTES: contextGuidelineBytes }),
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
    maxActiveDecisionBytesPerCube: positiveEnvironmentInteger(
      environment.BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE,
      DEFAULT_STORAGE_LIMITS.maxActiveDecisionBytesPerCube!,
      "BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE",
    ),
    contextGuidelineBytes: positiveEnvironmentInteger(
      environment.BORG_SERVER_CONTEXT_GUIDELINE_BYTES,
      DEFAULT_STORAGE_LIMITS.contextGuidelineBytes!,
      "BORG_SERVER_CONTEXT_GUIDELINE_BYTES",
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
  if (name === "BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE") return "DECISION_BUDGET_INVALID";
  if (name === "BORG_SERVER_CONTEXT_GUIDELINE_BYTES") return "CONTEXT_GUIDELINE_INVALID";
  if (name === "BORG_SERVER_MAX_DATABASE_BYTES") return "DATABASE_LIMIT_INVALID";
  if (name === "BORG_SERVER_MIN_FREE_DISK_BYTES") return "DISK_RESERVE_INVALID";
  throw new Error("Unknown storage environment setting.");
}

const serverEnvironment = selectServerEnvironment(process.env);
const dataDirectory = serverEnvironment.BORG_SERVER_DATA_DIR ?? join(homedir(), ".borg", "server");
const runtimeDirectory = serverEnvironment.BORG_SERVER_RUNTIME_DIR ?? join(homedir(), ".borg", "server-runtime");
const credentialFile = join(homedir(), ".borg", "credentials");
const nodeRuntimeController = createNodeRuntimeOperator(runtimeDirectory, dataDirectory);
const startOnlyService = createNodeServerService({
  environment: { ...serverEnvironment, BORG_SERVER_DATA_DIR: dataDirectory },
  readFile,
  readPrivateKey: loadTlsPrivateKey,
  startServer: async (options) => {
    const running = await startHttpsServer(options);
    return nodeServerTestHooks?.wrapRunningServer?.(running) ?? running;
  },
  onStarted: (origin, identity, binding) => {
    if (supportsForegroundDashboard()) {
      if (binding.remedy !== null) console.error(renderBindIntentMismatch(binding));
    } else {
      console.error(renderStartMachineOutput(
        origin,
        identity,
        binding,
        serverEnvironment.BORG_SERVER_PROCESS_MODE ?? "foreground",
      ));
    }
    nodeServerTestHooks?.onListening?.(origin);
  },
  startForegroundDashboard: ({ source, server, asciiRequested }) => {
    if (!supportsForegroundDashboard()) return undefined;
    const navigation = supportsDashboardNavigation();
    return startForegroundDashboard({
      source,
      server,
      terminal: createNodeDashboardTerminal(navigation),
      renderer: createDashboardRenderer({
        glyphMode: selectDashboardGlyphMode({
          asciiRequested,
          environment: process.env,
        }),
        color: dashboardColorEnabled(process.env),
        footer: EMBEDDED_DASHBOARD_FOOTER,
        navigation,
      }),
      fallbackFooter: EMBEDDED_DASHBOARD_FOOTER,
    });
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
  bindOwnerCredential: (origin) =>
    bindPortableOwnerCredentialPort(dataDirectory, credentialFile, runtimeOriginPort(origin), origin),
  debugOutput: (line) => console.error(line),
});
export const nodeServerService: ServerService = {
  start: startOnlyService.start,
  dashboard: (options) => runNodeDashboardViewer(dataDirectory, options),
  setup: async (options) => {
    const bindHost = resolveSetupBindHost(serverEnvironment);
    if ((await inspectRuntimeLock(dataDirectory)).running) throw operatorErrors.RUNTIME_ACTIVE;
    const artifact = await nodeRuntimeController.prepareLatest(30_000);
    const result = await setupNodeServerInstallation(
      dataDirectory,
      bindHost,
      options,
      credentialFile,
    );
    if (!("existing" in result)) {
      const { initialInvitation: _invitation, ...publicResult } = result;
      return {
        ...publicResult,
        artifact: {
          version: artifact.version,
          integrity: artifact.integrity,
          sourceSha: artifact.sourceSha,
        },
      };
    }
    return {
      ...result,
      artifact: {
        version: artifact.version,
        integrity: artifact.integrity,
        sourceSha: artifact.sourceSha,
      },
    };
  },
  status: () => inspectNodeRuntime(
    dataDirectory,
    runtimeDirectory,
    nodeRuntimeController.inspectManagedService,
  ),
  update: async () => completeRuntimeUpdate(
    await nodeRuntimeController.updateLatest(30_000),
    SERVER_PACKAGE_VERSION,
    await nodeRuntimeController.inspectManagedService(),
  ),
  installService: () => nodeRuntimeController.installService(20_000),
  uninstallService: () => nodeRuntimeController.uninstallService(20_000),
  recoverStaleLock: () => recoverStaleRuntimeLock(dataDirectory),
  reissueCertificate: (additionalHost) => reissueNodeServerCertificate(dataDirectory, additionalHost),
  ...createOfflineCredentialService(dataDirectory, credentialFile),
};

async function runNodeDashboardViewer(
  runtimeDataDirectory: string,
  options: DashboardCommandOptions,
): Promise<void> {
  // Preserve the installation/symlink diagnostics before consulting the
  // runtime lock; the source performs the same checks again when it pins.
  assertReadonlyDashboardInstallation(runtimeDataDirectory);
  const runtime = await inspectRuntimeLock(runtimeDataDirectory);
  if (!runtime.running) throw operatorErrors.DASHBOARD_SERVER_STOPPED;
  if (runtime.identity === null || runtime.endpoint === null) {
    throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
  }
  const expectedRuntime = runtime;
  const validateRuntime = async (): Promise<void> => {
    const current = await inspectRuntimeLock(runtimeDataDirectory);
    if (!current.running ||
        current.pid !== expectedRuntime.pid ||
        current.endpoint !== expectedRuntime.endpoint ||
        current.identity?.started_at !== expectedRuntime.identity?.started_at) {
      throw operatorErrors.DASHBOARD_SERVER_STOPPED;
    }
  };
  const source = await openReadonlyDashboardSnapshotSource({
    dataDirectory: runtimeDataDirectory,
    validate: validateRuntime,
  });
  try {
    const server: DashboardServerIdentity = Object.freeze({
      name: "borgmcp-server",
      version: runtime.identity.package_version,
      endpoint: runtime.endpoint,
      bind_mode: bindModeForOrigin(runtime.endpoint),
      state: "online",
      started_at: runtime.identity.started_at,
    });
    await validateRuntime();
    if (!supportsStandaloneDashboard()) {
      process.stdout.write(`${renderPlainDashboard(
        rankDashboardSnapshot(source.read(), server),
        80,
        20,
      )}\n`);
      return;
    }
    const shutdown = installProcessShutdownHandlers();
    const navigation = supportsDashboardNavigation();
    const dashboard = startForegroundDashboard({
      source,
      server,
      terminal: createNodeDashboardTerminal(navigation),
      renderer: createDashboardRenderer({
        glyphMode: selectDashboardGlyphMode({
          asciiRequested: options.ascii,
          environment: process.env,
        }),
        color: dashboardColorEnabled(process.env),
        footer: STANDALONE_DASHBOARD_FOOTER,
        navigation,
      }),
      fallbackFooter: STANDALONE_DASHBOARD_FOOTER,
    });
    try {
      await Promise.race([dashboard.failure, waitForAbort(shutdown.signal)]);
    } finally {
      dashboard.close();
      shutdown.dispose();
    }
  } finally {
    source.close();
  }
}

function createNodeRuntimeOperator(managedRuntimeDirectory: string, runtimeDataDirectory: string) {
  const platform = process.platform === "darwin" ? "launchd" : "systemd";
  const definition = createManagedServiceDefinition({
    platform,
    nodeExecutable: process.execPath,
    nodeVersion: process.versions.node,
    runtimeRoot: managedRuntimeDirectory,
    dataDirectory: runtimeDataDirectory,
    definitionPath: platform === "launchd"
      ? join(homedir(), "Library", "LaunchAgents", "ai.borgmcp.server.plist")
      : join(homedir(), ".config", "systemd", "user", "ai.borgmcp.server.service"),
    ...(platform === "launchd" ? { launchdDomain: `gui/${process.getuid?.() ?? 0}` } : {}),
  });
  const run = async (
    command: readonly [string, ...string[]],
    signal: AbortSignal,
  ): Promise<{ readonly stdout: string; readonly stderr: string }> => {
    const [executable, ...args] = command;
    return promisify(execFile)(executable, args, {
      signal,
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
  };
  const lifecycle = createRuntimeLifecycle({
    unpack: createUnixNpmArtifactUnpacker(),
    restart: async (signal) => { await run(definition.restart, signal); },
    stop: async (signal) => { await run(definition.unload, signal); },
    probe: (signal) => waitForRuntimeIdentity(runtimeDataDirectory, signal),
  });
  const inspectManagedService = (): Promise<ManagedServiceStatus> =>
    inspectManagedServiceState(definition, run);
  const isManagedServiceActive = async (): Promise<boolean> =>
    (await inspectManagedService()).state === "active";
  const operator = createRuntimeOperator({
    runtimeRoot: managedRuntimeDirectory,
    artifacts: createRegistryArtifactSource(),
    lifecycle,
    isRunning: async () => {
      const status = await inspectRuntimeLock(runtimeDataDirectory);
      if (!status.running && status.stale !== undefined) throw operatorErrors.RUNTIME_LOCK_STALE;
      if (status.running && status.mode === "legacy" && await isManagedServiceActive()) {
        return true;
      }
      if (status.running && status.mode !== "managed") {
        throw new Error("Foreground runtime must be stopped before artifact activation.");
      }
      return status.running;
    },
  });
  return Object.freeze({
    ...operator,
    inspectManagedService,
    stopRuntime: (timeoutMs: number) => stopServerRuntime({
      runtimeDataDirectory,
      timeoutMs,
      isManagedServiceActive,
      stopManaged: async (signal) => { await run(definition.unload, signal); },
    }),
    installService: async (timeoutMs: number) => {
      if (process.platform !== "darwin" && process.platform !== "linux") {
        throw operatorErrors.MANAGED_SERVICE_PLATFORM_UNSUPPORTED;
      }
      await assertManagedServiceInstallation(runtimeDataDirectory);
      let artifact;
      try {
        artifact = await inspectActiveRuntimeArtifact(managedRuntimeDirectory);
      } catch {
        throw operatorErrors.MANAGED_SERVICE_RUNTIME_UNPREPARED;
      }
      if (artifact === null) throw operatorErrors.MANAGED_SERVICE_RUNTIME_UNPREPARED;
      return installManagedService({
        definition,
        artifact,
        dataDirectory: runtimeDataDirectory,
        assertInstallation: () => assertManagedServiceInstallation(runtimeDataDirectory),
        inspectRuntime: async () => {
          const status = await inspectRuntimeLock(runtimeDataDirectory);
          return status.running
            ? { running: true, mode: status.mode, identity: status.identity }
            : { running: false, stale: status.stale !== undefined };
        },
        inspectService: () => inspectManagedService(),
        run,
        probe: (signal) => waitForRuntimeIdentity(runtimeDataDirectory, signal),
        timeoutMs,
      });
    },
    uninstallService: async (timeoutMs: number) => {
      if (process.platform !== "darwin" && process.platform !== "linux") {
        throw operatorErrors.MANAGED_SERVICE_UNINSTALL_PLATFORM_UNSUPPORTED;
      }
      return uninstallManagedService({
        definition,
        dataDirectory: runtimeDataDirectory,
        inspectRuntime: async () => {
          const status = await inspectRuntimeLock(runtimeDataDirectory);
          return status.running
            ? { running: true, mode: status.mode, identity: status.identity }
            : { running: false, stale: status.stale !== undefined };
        },
        inspectService: () => inspectManagedService(),
        run,
        probe: (signal) => waitForRuntimeIdentity(runtimeDataDirectory, signal),
        timeoutMs,
      });
    },
  });
}

export async function inspectManagedServiceState(
  definition: ManagedServiceDefinition,
  run: (
    command: readonly [string, ...string[]],
    signal: AbortSignal,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>,
): Promise<ManagedServiceStatus> {
  let active = false;
  let loaded = false;
  try {
    const result = await run(definition.status, new AbortController().signal);
    if (definition.platform === "launchd") {
      const state = /(?:^|\n)\s*state = ([a-z-]+)\s*(?:\n|$)/u.exec(result.stdout)?.[1];
      if (state === undefined) throw new Error("launchd returned no service state.");
      loaded = true;
      active = state === "running";
    } else {
      const loadState = /(?:^|\n)LoadState=([a-z-]+)(?:\n|$)/u.exec(result.stdout)?.[1];
      const activeState = /(?:^|\n)ActiveState=([a-z-]+)(?:\n|$)/u.exec(result.stdout)?.[1];
      if (loadState === undefined || activeState === undefined) {
        throw new Error("systemd returned no service state.");
      }
      loaded = loadState !== "not-found";
      active = loaded && activeState === "active";
    }
  } catch (error) {
    if (!isExpectedUnloadedServiceProbe(definition, error)) throw error;
  }
  if (active) {
    return Object.freeze({
      state: "active",
      adapter: definition.platform,
      recoveryCommand: null,
    });
  }

  let metadata;
  try {
    metadata = await lstat(definition.definitionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (loaded) {
        return Object.freeze({
          state: "inactive",
          adapter: definition.platform,
          recoveryCommand: definition.recoverLoaded,
        });
      }
      return Object.freeze({
        state: "absent",
        adapter: null,
        recoveryCommand: null,
      });
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw operatorErrors.MANAGED_SERVICE_DEFINITION_UNSAFE;
  }
  return Object.freeze({
    state: "inactive",
    adapter: definition.platform,
    recoveryCommand: loaded ? definition.recoverLoaded : definition.install,
  });
}

function isExpectedUnloadedServiceProbe(
  definition: ManagedServiceDefinition,
  error: unknown,
): boolean {
  return definition.platform === "launchd" &&
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 113;
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
      if (error !== operatorErrors.RUNTIME_LOCK_STALE &&
          error !== operatorErrors.RUNTIME_LOCK_INVALID) throw error;
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
  inspectManagedService: () => Promise<ManagedServiceStatus> = async () => Object.freeze({
    state: "absent",
    adapter: null,
    recoveryCommand: null,
  }),
): Promise<ServerRuntimeStatus> {
  const [lock, activeArtifact, dataIdentity, managedService] = await Promise.all([
    inspectRuntimeLock(runtimeDataDirectory),
    inspectActiveRuntimeArtifact(managedRuntimeDirectory),
    hasDataIdentity(runtimeDataDirectory),
    inspectManagedService(),
  ]);
  const identity = lock.running ? lock.identity : null;
  const runningArtifact = identity === null ? null : {
    version: identity.package_version,
    integrity: identity.artifact_integrity,
  };
  const effectiveRuntime = runningArtifact ?? activeArtifact;
  const nextAction = effectiveRuntime === null
    ? null
    : resolveControllerNextAction(SERVER_PACKAGE_VERSION, effectiveRuntime.version);
  return Object.freeze({
    status: lock.running ? "running" : "stopped",
    controllerVersion: SERVER_PACKAGE_VERSION,
    preparedArtifact: activeArtifact,
    runningArtifact,
    buildIdentity: identity?.source_sha ?? null,
    endpoint: lock.running ? lock.endpoint : null,
    mode: lock.running ? lock.mode : "stopped",
    serviceAdapter: managedService.adapter,
    serviceState: managedService.state,
    serviceRecoveryCommand: managedService.recoveryCommand,
    runtimeLock: lock.running || lock.stale === undefined
      ? Object.freeze({ state: "clear" })
      : Object.freeze({
          state: "stale",
          pid: lock.stale.pid,
          processState: "absent",
          identity: lock.stale.identity,
          endpoint: lock.stale.endpoint,
          mode: lock.stale.mode,
          recoveryAction: "borg-mcp-server recover-stale-lock",
        }),
    dataIdentity,
    nextAction,
  });
}

export async function stopServerRuntime(input: {
  readonly runtimeDataDirectory: string;
  readonly timeoutMs: number;
  readonly isManagedServiceActive: () => Promise<boolean>;
  readonly stopManaged: (signal: AbortSignal) => Promise<void>;
  readonly inspect?: typeof inspectRuntimeLock;
}): Promise<ServerStopResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 300_000) {
    throw new Error("Runtime stop timeout is invalid.");
  }
  const inspect = input.inspect ?? inspectRuntimeLock;
  const initial = await inspect(input.runtimeDataDirectory);
  if (!initial.running && initial.stale !== undefined) throw operatorErrors.RUNTIME_LOCK_STALE;
  if (!initial.running) return Object.freeze({ outcome: "already-stopped" });
  const managed = initial.mode === "managed" ||
    (initial.mode === "legacy" && await input.isManagedServiceActive());
  if (!managed) return Object.freeze({ outcome: "foreground-action-required" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    await input.stopManaged(controller.signal);
    while (!controller.signal.aborted) {
      if (!(await inspect(input.runtimeDataDirectory)).running) {
        return Object.freeze({ outcome: "stopped" });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Managed server stop timed out.");
  } finally {
    clearTimeout(timer);
  }
}

export function completeRuntimeUpdate(
  result: RuntimeUpdateResult,
  controllerVersion = SERVER_PACKAGE_VERSION,
  managedService: ManagedServiceStatus = Object.freeze({
    state: "absent",
    adapter: null,
    recoveryCommand: null,
  }),
): ServerUpdateResult {
  return Object.freeze({
    ...result,
    controllerVersion,
    serviceAdapter: managedService.adapter,
    serviceState: managedService.state,
    serviceRecoveryCommand: managedService.recoveryCommand,
    nextAction: resolveControllerNextAction(controllerVersion, result.artifact.version),
  });
}

function resolveControllerNextAction(
  controllerVersion: string,
  runtimeVersion: string,
): ServerNextAction | null {
  if (versionIsNewer(controllerVersion, runtimeVersion)) {
    return Object.freeze({ kind: "update-runtime" });
  }
  if (versionIsNewer(runtimeVersion, controllerVersion)) {
    return Object.freeze({ kind: "install-controller", version: runtimeVersion });
  }
  return null;
}

function versionIsNewer(candidate: string, current: string): boolean {
  const parse = (value: string): readonly number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(value);
    return match === null ? null : match.slice(1).map(Number);
  };
  const left = parse(candidate);
  const right = parse(current);
  if (left === null || right === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return false;
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
const requiredManagedInstallationFiles = Object.freeze([
  "borg.db",
  "credential-digest.key",
  "ca.crt",
  "server.key",
  "server.crt",
  "server.json",
]);

export async function setupNodeServerInstallation(
  setupDataDirectory: string,
  bindHost: string,
  options: SetupOptions,
  credentialRoot?: string,
): Promise<BootstrapResult | { readonly existing: true; readonly bindHost: string }> {
  const directory = await preparePrivateDataDirectory(setupDataDirectory);
  const runtimeLock = await acquireRuntimeLock(directory);
  let invitationLock: RuntimeLock | undefined;
  try {
    invitationLock = await acquireInvitationMintLock(directory);
    const existing = await inspectManagedInstallation(directory);
    if (existing.length !== 0 && !options.reinitialize) {
      const names = new Set(existing.map((path) => basename(path)));
      const complete = requiredManagedInstallationFiles.every((name) => names.has(name));
      if (!complete) throw operatorErrors.INSTALLATION_EXISTS;
      if (credentialRoot !== undefined) {
        await readPortableOwnerCredentialForInstallation(directory, credentialRoot, 7_091);
      }
      const config = JSON.parse((await readFile(join(directory, "server.json"))).toString("utf8")) as {
        readonly bind_host?: unknown;
      };
      if (typeof config.bind_host !== "string") throw new Error("Server identity is invalid.");
      return Object.freeze({ existing: true, bindHost: config.bind_host });
    }
    if (bindHost.includes("%")) throw operatorErrors.SETUP_BIND_SCOPE_UNSUPPORTED;
    if (options.reinitialize) {
      const names = new Set(existing.map((path) => basename(path)));
      const preservedCertificateAuthority = existing.length === 0
        ? undefined
        : await readPreservedCertificateAuthority(setupDataDirectory, names);
      for (const path of existing) {
        const name = basename(path);
        if (preservedCertificateAuthority !== undefined && (name === "ca.key" || name === "ca.crt")) continue;
        await unlink(path);
      }
      return await bootstrapServer(
        setupDataDirectory,
        bindHost,
        () => new Date(),
        credentialRoot === undefined
          ? async () => undefined
          : (record) => persistSetupOwnerCredential(credentialRoot, record),
        preservedCertificateAuthority,
      );
    }
    return await bootstrapServer(
      directory,
      bindHost,
      () => new Date(),
      credentialRoot === undefined
        ? async () => undefined
        : (record) => persistSetupOwnerCredential(credentialRoot, record),
    );
  } finally {
    if (invitationLock === undefined) await runtimeLock.release();
    else await invitationLock.release().finally(() => runtimeLock.release());
  }
}

async function persistSetupOwnerCredential(
  credentialRoot: string,
  record: PortableServerCredential,
): Promise<void> {
  try {
    await writePortableServerCredential(credentialRoot, record);
  } catch {
    throw operatorErrors.SETUP_OWNER_CREDENTIAL_FAILED;
  }
}

async function readPreservedCertificateAuthority(
  directory: string,
  names: ReadonlySet<string>,
): Promise<PreservedCertificateAuthority> {
  if (!names.has("ca.key") || !names.has("ca.crt")) throw operatorErrors.CA_MATERIAL_UNAVAILABLE;
  let key: Buffer | undefined;
  try {
    key = await loadTlsPrivateKey(join(directory, "ca.key"));
    const certificate = await readFile(join(directory, "ca.crt"));
    const ca = new X509Certificate(certificate);
    const publicKey = createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "der" });
    if (!ca.ca || !publicKey.equals(ca.publicKey.export({ type: "spki", format: "der" }))) {
      throw new Error("CA material does not match.");
    }
    return { key: key.toString("utf8"), certificate: certificate.toString("utf8") };
  } catch {
    throw operatorErrors.CA_MATERIAL_UNAVAILABLE;
  } finally {
    key?.fill(0);
  }
}

async function reissueNodeServerCertificate(
  dataDirectory: string,
  additionalHost: string,
): Promise<CertificateReissueResult> {
  const host = resolveBindOptions({ host: additionalHost, lanConsent: true }).host;
  const runtimeLock = await acquireRuntimeLock(dataDirectory);
  try {
    return await reissueServerCertificate(dataDirectory, host);
  } finally {
    await runtimeLock.release();
  }
}

export async function bindPortableOwnerCredentialPort(
  setupDataDirectory: string,
  credentialRoot: string,
  port: number,
  runningOrigin?: string,
): Promise<void> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Server listener port is invalid.");
  }
  const portableOwner = await readPortableOwnerCredentialForInstallation(
    setupDataDirectory,
    credentialRoot,
    port,
  );
  if (portableOwner === null) return;
  const { config, record } = portableOwner;
  const displayHost = config.bind_host.includes(":") ? `[${config.bind_host}]` : config.bind_host;
  const origin = runningOrigin ?? `https://${displayHost}:${port}`;
  const legacyOrigin = `https://${displayHost}:7091`;
  await rebindPortableServerCredential(
    credentialRoot,
    { ...record, origin },
    [legacyOrigin, origin],
  );
}

async function readPortableOwnerCredentialForInstallation(
  setupDataDirectory: string,
  credentialRoot: string,
  port: number,
): Promise<{
  readonly config: { readonly bind_host: string; readonly ca_spki_sha256: string };
  readonly record: Awaited<ReturnType<typeof readPortableServerCredentialForTrustIdentity>>;
} | null> {
  const config = JSON.parse((await readFile(join(setupDataDirectory, "server.json"))).toString("utf8")) as {
    bind_host?: unknown;
    ca_spki_sha256?: unknown;
  };
  if (typeof config.bind_host !== "string" ||
      typeof config.ca_spki_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(config.ca_spki_sha256)) {
    throw new Error("Server identity is invalid.");
  }
  const trustIdentity = `spki-sha256:${config.ca_spki_sha256}`;
  try {
    return {
      config: { bind_host: config.bind_host, ca_spki_sha256: config.ca_spki_sha256 },
      record: await readPortableServerCredentialForTrustIdentity(credentialRoot, trustIdentity),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "Local owner credential is unavailable.") {
      const displayHost = config.bind_host.includes(":") ? `[${config.bind_host}]` : config.bind_host;
      for (const candidatePort of new Set([7_091, port])) {
        if (await portableCredentialAccountHasNonOwner(
          credentialRoot,
          `https://${displayHost}:${candidatePort}`,
          trustIdentity,
        )) throw operatorErrors.OWNER_CREDENTIAL_UNAVAILABLE;
      }
      return null;
    }
    throw error;
  }
}

function runtimeOriginPort(origin: string): number {
  const port = Number(new URL(origin).port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Runtime endpoint is invalid.");
  }
  return port;
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

export async function assertManagedServiceInstallation(directory: string): Promise<void> {
  const existing = await inspectManagedInstallation(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const names = new Set(existing.map((path) => basename(path)));
  if (!requiredManagedInstallationFiles.every((name) => names.has(name))) {
    throw operatorErrors.MANAGED_SERVICE_DATA_UNINITIALIZED;
  }
  let config: { readonly bind_host?: unknown };
  try {
    config = JSON.parse((await readFile(join(directory, "server.json"))).toString("utf8")) as {
      readonly bind_host?: unknown;
    };
  } catch {
    throw operatorErrors.MANAGED_SERVICE_DATA_UNINITIALIZED;
  }
  if (typeof config.bind_host !== "string") throw operatorErrors.MANAGED_SERVICE_DATA_UNINITIALIZED;
  if (resolveBindOptions({ host: config.bind_host, lanConsent: true }).mode !== "loopback") {
    throw operatorErrors.MANAGED_SERVICE_LAN_UNSUPPORTED;
  }
}

function resolveSetupBindHost(environment: ServerEnvironment): string {
  return resolveBindOptions({
    ...(environment.BORG_SERVER_BIND_HOST === undefined
      ? {}
      : { host: environment.BORG_SERVER_BIND_HOST }),
    lanConsent: true,
  }).host;
}

export function renderBindIntentMismatch(binding: ServerBindOutput): string {
  if (binding.bindHost === null || binding.remedy === null) {
    throw new Error("Bind intent mismatch output is incomplete.");
  }
  return `WARNING: This server is prepared for ${binding.bindHost}, but this start is listening on loopback only.\n` +
    "To use the prepared bind address, stop the server, then run:\n" +
    `  ${binding.remedy}`;
}

export function renderStartMachineOutput(
  origin: string,
  identity: RuntimeBuildIdentity,
  binding: ServerBindOutput,
  processMode: "foreground" | "managed",
): string {
  return JSON.stringify({
    status: "running",
    artifact: `borgmcp-server@${identity.package_version}`,
    artifact_integrity: identity.artifact_integrity,
    build_identity: identity.source_sha,
    endpoint: origin,
    bind_host: binding.bindHost,
    bind_mode: binding.bindMode,
    bind_remedy: binding.remedy,
    mode: processMode,
    data_identity: "available",
  });
}

function bindModeForOrigin(origin: string): "loopback" | "lan" {
  const hostname = new URL(origin).hostname.replace(/^\[|\]$/gu, "");
  return resolveBindOptions({ host: hostname, lanConsent: true }).mode;
}

export function createOfflineCredentialService(
  offlineDataDirectory: string,
  credentialRoot?: string,
): Pick<Required<ServerService>,
  "rotateClient" | "listClients" | "revokeClient" | "grantClient" | "ungrantClient" | "invite"
> {
  const withInvitationAuthority = async <T>(
    operation: (
      authority: CredentialAuthority,
      runtime: Awaited<ReturnType<typeof openStore>>,
    ) => T | Promise<T>,
    contentionError = operatorErrors.INVITATION_CONTENTION,
  ): Promise<T> => {
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
      return await operation(new CredentialAuthority(runtime.credentials, digester), runtime);
    } catch (error) {
      if (error instanceof MigrationCompatibilityError) throw operatorErrors.INVITATION_SCHEMA_MISMATCH;
      if (isSqliteContention(error)) throw contentionError;
      throw error;
    } finally {
      digester?.destroy();
      runtime?.close();
      if (offlineRuntimeLock === undefined) await invitationLock.release();
      else await offlineRuntimeLock.release().finally(() => invitationLock.release());
    }
  };
  return {
    rotateClient: (clientId) => withInvitationAuthority(
      (authority) => authority.rotateClient(clientId),
      operatorErrors.LIVE_ADMIN_CONTENTION,
    ),
    listClients: () => withInvitationAuthority(
      (_authority, runtime) => runtime.maintenance.listClients(),
      operatorErrors.LIVE_ADMIN_CONTENTION,
    ),
    revokeClient: (selector) => withInvitationAuthority(
      (authority) => authority.revokeClient(selector),
      operatorErrors.LIVE_ADMIN_CONTENTION,
    ),
    grantClient: (selector, cubeId, access) => withInvitationAuthority((_authority, runtime) => {
      runtime.maintenance.grantClientCubeBySelector({ selector, cubeId, access });
    }, operatorErrors.LIVE_ADMIN_CONTENTION),
    ungrantClient: (selector, cubeId) => withInvitationAuthority((_authority, runtime) => {
      if (!runtime.maintenance.removeClientCubeGrantBySelector(selector, cubeId)) {
        throw operatorErrors.GRANT_NOT_FOUND;
      }
    }, operatorErrors.LIVE_ADMIN_CONTENTION),
    invite: async (clientName) => {
      const runtime = await inspectRuntimeLock(offlineDataDirectory);
      return withInvitationAuthority(async (authority) => {
        if (credentialRoot === undefined) throw new Error("Local owner credential store is unavailable.");
        const config = JSON.parse((await readFile(join(offlineDataDirectory, "server.json"))).toString("utf8")) as {
          bind_host?: unknown;
          ca_spki_sha256?: unknown;
        };
        if (typeof config.bind_host !== "string" || typeof config.ca_spki_sha256 !== "string") {
          throw new Error("Server identity is invalid.");
        }
        const trustIdentity = `spki-sha256:${config.ca_spki_sha256}`;
        const record = await readPortableServerCredentialForTrustIdentity(credentialRoot, trustIdentity);
        const endpoint = runtime.running && runtime.endpoint !== null
          ? runtime.endpoint
          : `https://${config.bind_host.includes(":") ? `[${config.bind_host}]` : config.bind_host}:7091`;
        const invitation = authority.createInvitationArtifactForOwnerCredential(
          record.credential,
          15 * 60_000,
          endpoint,
          config.ca_spki_sha256,
          clientName,
        );
        if (invitation === null) throw new Error("Local owner credential is invalid.");
        return { invitation, endpoint, loopbackOnly: isLoopbackEndpoint(endpoint) };
      });
    },
  };
}

function isLoopbackEndpoint(endpoint: string): boolean {
  const host = new URL(endpoint).hostname;
  return host === "127.0.0.1" || host === "[::1]" || host === "::1" || /^127\./u.test(host);
}

const canonicalRuntimeLockNonce = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface RuntimeLock {
  readonly release: () => Promise<void>;
  readonly updateOrigin?: (origin: string) => Promise<void>;
}

async function teardownRuntime(resources: RuntimeResources): Promise<void> {
  let dashboardFailure: unknown;
  try {
    resources.dashboard?.close();
  } catch (error) {
    dashboardFailure = error;
  }
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
  if (dashboardFailure !== undefined) throw dashboardFailure;
}

function supportsForegroundDashboard(): boolean {
  return process.stdout.isTTY === true &&
    serverEnvironment.BORG_SERVER_PROCESS_MODE !== "managed" &&
    process.env["TERM"] !== "dumb";
}

function supportsStandaloneDashboard(): boolean {
  return process.stdout.isTTY === true && process.env["TERM"] !== "dumb";
}

function supportsDashboardNavigation(): boolean {
  return process.stdin.isTTY === true && process.stdin.setRawMode !== undefined;
}

export function createNodeDashboardTerminal(
  navigation: boolean,
  streams: {
    readonly stdin: typeof process.stdin;
    readonly stdout: typeof process.stdout;
  } = { stdin: process.stdin, stdout: process.stdout },
): DashboardTerminal {
  const { stdin, stdout } = streams;
  const base = {
    write: (value: string): void => { stdout.write(value); },
    dimensions: (): { readonly columns: number; readonly rows: number } => ({
      columns: stdout.columns ?? 80,
      rows: stdout.rows ?? 24,
    }),
    onResize: (listener: () => void): (() => void) => {
      stdout.on("resize", listener);
      return () => stdout.off("resize", listener);
    },
  };
  if (!navigation) return base;
  return {
    ...base,
    onInput: (listener) => {
      const wasFlowing = stdin.readableFlowing === true;
      const wasRaw = stdin.isRaw === true;
      const onData = (value: Buffer | string): void => {
        listener(Buffer.from(value));
      };
      let subscribed = false;
      const restoreInput = (): void => {
        if (subscribed) {
          stdin.off("data", onData);
          subscribed = false;
        }
        try {
          stdin.setRawMode!(wasRaw);
        } finally {
          if (!wasFlowing) stdin.pause();
        }
      };
      stdin.setRawMode!(true);
      try {
        stdin.resume();
        stdin.on("data", onData);
        subscribed = true;
      } catch (error) {
        restoreInput();
        throw error;
      }
      return restoreInput;
    },
    requestInterrupt: () => { process.kill(process.pid, "SIGINT"); },
    ...(process.platform === "win32"
      ? {}
      : {
          requestSuspend: (resume: () => void) => {
            process.once("SIGCONT", resume);
            try {
              // Raw mode turns ^Z into a byte. Stop the entire foreground group
              // so every terminal process suspends and the shell can resume the
              // job as one unit. SIGSTOP also works for orphaned PTY groups.
              process.kill(0, "SIGSTOP");
            } catch (error) {
              process.off("SIGCONT", resume);
              throw error;
            }
          },
        }),
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), {
    once: true,
  }));
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
  return (await inspectRuntimeLockFile(runtimeDataDirectory)).status;
}

interface RuntimeLockFileInspection {
  readonly status: RuntimeLockStatus;
  readonly raw: string | null;
  readonly nonce: string | null;
  readonly device: number | null;
  readonly inode: number | null;
}

async function inspectRuntimeLockFile(
  runtimeDataDirectory: string,
  concurrentRecovery = false,
): Promise<RuntimeLockFileInspection> {
  const path = join(runtimeDataDirectory, "runtime.lock");
  let metadata;
  let liveOwner = false;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({
        status: Object.freeze({ running: false }),
        raw: null,
        nonce: null,
        device: null,
        inode: null,
      });
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
      metadata.size > 8 * 1024) {
    throw operatorErrors.RUNTIME_LOCK_UNSAFE;
  }
  try {
    const raw = await readFile(path, "utf8");
    const confirmedMetadata = await lstat(path);
    if (!confirmedMetadata.isFile() || confirmedMetadata.isSymbolicLink() ||
        confirmedMetadata.dev !== metadata.dev || confirmedMetadata.ino !== metadata.ino ||
        confirmedMetadata.size !== Buffer.byteLength(raw) ||
        (confirmedMetadata.mode & 0o077) !== 0) {
      throw new Error();
    }
    const value = JSON.parse(raw) as {
      pid?: unknown;
      nonce?: unknown;
      purpose?: unknown;
      runtime_identity?: unknown;
      endpoint?: unknown;
      mode?: unknown;
    };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) throw new Error();
    const pid = value.pid as number;
    liveOwner = processIsAlive(pid);
    if (typeof value.nonce !== "string" || !canonicalRuntimeLockNonce.test(value.nonce) ||
        value.purpose !== "server" ||
        (value.endpoint !== undefined &&
          (typeof value.endpoint !== "string" || !isRuntimeEndpoint(value.endpoint))) ||
        (value.mode !== undefined && value.mode !== "foreground" && value.mode !== "managed")) {
      throw new Error();
    }
    const identity = decodeRuntimeLockIdentity(value.runtime_identity);
    const endpoint = value.endpoint ?? null;
    const mode = value.mode ?? "legacy";
    if (!liveOwner) {
      if (identity === null) throw new Error();
      return Object.freeze({
        status: Object.freeze({
          running: false,
          stale: Object.freeze({ pid, identity, endpoint, mode }),
        }),
        raw,
        nonce: value.nonce,
        device: confirmedMetadata.dev,
        inode: confirmedMetadata.ino,
      });
    }
    return Object.freeze({
      status: Object.freeze({
        running: true,
        pid,
        identity,
        endpoint,
        mode,
      }),
      raw,
      nonce: value.nonce,
      device: confirmedMetadata.dev,
      inode: confirmedMetadata.ino,
    });
  } catch (error) {
    if (concurrentRecovery && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw operatorErrors.RUNTIME_LOCK_RECOVERY_CONCURRENT;
    }
    if (liveOwner) throw operatorErrors.RUNTIME_LOCK_LIVE_UNRECOGNIZED;
    throw operatorErrors.RUNTIME_LOCK_INVALID;
  }
}

export async function recoverStaleRuntimeLock(
  runtimeDataDirectory: string,
  now: () => Date | Promise<Date> = () => new Date(),
): Promise<StaleRuntimeLockRecovery> {
    const initial = await inspectRuntimeLockFile(runtimeDataDirectory, true);
    if (initial.status.running || initial.status.stale === undefined) {
      throw operatorErrors.RUNTIME_LOCK_NOT_STALE;
    }
    const confirmed = await inspectRuntimeLockFile(runtimeDataDirectory, true);
    if (confirmed.raw === null) throw operatorErrors.RUNTIME_LOCK_RECOVERY_CONCURRENT;
    if (!sameRuntimeLockFile(initial, confirmed) ||
        confirmed.status.running || confirmed.status.stale === undefined ||
        processIsAlive(confirmed.status.stale.pid)) {
      throw operatorErrors.RUNTIME_LOCK_NOT_STALE;
    }

    const timestamp = (await now()).toISOString().replaceAll(/[-:.]/gu, "");
    const beforePreservation = await inspectRuntimeLockFile(runtimeDataDirectory, true);
    if (beforePreservation.raw === null) throw operatorErrors.RUNTIME_LOCK_RECOVERY_CONCURRENT;
    if (!sameRuntimeLockFile(confirmed, beforePreservation) ||
        beforePreservation.status.running || beforePreservation.status.stale === undefined ||
        processIsAlive(beforePreservation.status.stale.pid)) {
      throw operatorErrors.RUNTIME_LOCK_NOT_STALE;
    }

    const path = join(runtimeDataDirectory, "runtime.lock");
    const backupPath = join(
      runtimeDataDirectory,
      `runtime.lock.stale-${timestamp}-${randomUUID()}`,
    );
    try {
      await rename(path, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw operatorErrors.RUNTIME_LOCK_RECOVERY_CONCURRENT;
      }
      throw error;
    }
    return Object.freeze({ backupPath, stale: beforePreservation.status.stale });
}

function sameRuntimeLockFile(
  left: RuntimeLockFileInspection,
  right: RuntimeLockFileInspection,
): boolean {
  return left.raw !== null &&
    left.raw === right.raw &&
    left.nonce === right.nonce &&
    left.device === right.device &&
    left.inode === right.inode;
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
  const stop = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      if (signal === "SIGINT") process.exit(130);
      if (signal === "SIGTERM") process.exit(143);
      return;
    }
    controller.abort();
  };
  // Keep the listener present through signal dispatch so Ink's signal-exit hook
  // does not mistake the one-shot wrapper's removal for an unhandled signal.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
    },
  };
}

function waitForShutdown(_server: RunningServer, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}
