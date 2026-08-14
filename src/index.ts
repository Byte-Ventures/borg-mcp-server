export { runCli } from "./cli.js";
export type { CliIo } from "./cli.js";
export {
  inspectManagedServiceState,
  inspectRuntimeLock,
  recoverStaleRuntimeLock,
} from "./service.js";
export { inspectNodeRuntime } from "./service.js";
export type {
  DashboardCommandOptions,
  RuntimeLockStatus,
  ManagedServiceStatus,
  ServerRuntimeLockDiagnostic,
  StaleRuntimeLockEvidence,
  StaleRuntimeLockRecovery,
  ServerNextAction,
  ServerRuntimeStatus,
  ServerSetupResult,
  ServerService,
  ServerUpdateResult,
  SetupOptions,
} from "./service.js";
export {
  createRuntimeBuildIdentity,
  loadRuntimeBuildIdentity,
  RUNTIME_INFO_PATH,
  SERVER_PACKAGE_VERSION,
} from "./runtime-identity.js";
export type {
  LoadRuntimeBuildIdentityInput,
  RuntimeBuildIdentity,
  RuntimeBuildIdentityInput,
} from "./runtime-identity.js";
export { createManagedServiceDefinition } from "./managed-service.js";
export type {
  ManagedServiceDefinition,
  ManagedServiceInput,
  ManagedServicePlatform,
} from "./managed-service.js";
export type { ManagedServiceInstallResult } from "./managed-service-install.js";
export type { ManagedServiceUninstallResult } from "./managed-service-uninstall.js";
export {
  createRuntimeLifecycle,
  RuntimeActivationError,
  createUnixNpmArtifactUnpacker,
  inspectActiveRuntimeArtifact,
} from "./runtime-lifecycle.js";
export { createRegistryArtifactSource } from "./registry-artifact.js";
export type { RegistryArtifactSource, RegistryRuntimeArtifact } from "./registry-artifact.js";
export {
  createDashboardRenderer,
  dashboardColorEnabled,
  rankDashboardSnapshot,
  renderPlainDashboard,
  sanitizeTerminalText,
  selectDashboardGlyphMode,
} from "./dashboard.js";
export type {
  DashboardCubeData,
  DashboardCubeSnapshot,
  DashboardDataSnapshot,
  DashboardGlyphMode,
  DashboardRenderOptions,
  DashboardRenderer,
  DashboardServerIdentity,
  DashboardSnapshot,
  DashboardSnapshotSource,
  DashboardViewState,
} from "./dashboard.js";
export { createRuntimeOperator } from "./runtime-operator.js";
export { RuntimeUpdateFailure } from "./runtime-operator.js";
export type { RuntimeOperator, RuntimeUpdateResult } from "./runtime-operator.js";
export type {
  ActivateRuntimeArtifactInput,
  RuntimeLifecycle,
  RuntimeLifecycleDependencies,
  RuntimeCommandResult,
  RuntimeCommandRunner,
  StageRuntimeArtifactInput,
  VerifiedRuntimeArtifact,
} from "./runtime-lifecycle.js";
