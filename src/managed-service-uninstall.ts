import { lstat } from "node:fs/promises";

import type { ManagedServiceDefinition } from "./managed-service.js";
import {
  acquireManagedServiceLock,
  inspectManagedServiceDefinition,
  managedRuntimeIdentitiesMatch,
  removeManagedServiceDefinition,
  runManagedServiceWithDeadline,
  writeManagedServicePrivateFile,
  type ManagedServiceProbeState,
  type ManagedServiceRuntimeState,
} from "./managed-service-install.js";
import { operatorErrors } from "./operator-error.js";
import type { RuntimeBuildIdentity } from "./runtime-identity.js";

export interface ManagedServiceUninstallInput {
  readonly definition: ManagedServiceDefinition;
  readonly dataDirectory: string;
  readonly assertControllerBinding: () => Promise<void>;
  readonly inspectRuntime: () => Promise<ManagedServiceRuntimeState>;
  readonly inspectService: () => Promise<ManagedServiceProbeState>;
  readonly run: (
    command: readonly [string, ...string[]],
    signal: AbortSignal,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly probe: (signal: AbortSignal) => Promise<RuntimeBuildIdentity>;
  readonly timeoutMs: number;
  readonly uid?: number;
}

export interface ManagedServiceUninstallResult {
  readonly outcome: "removed-active" | "removed-inactive" | "already-absent";
  readonly adapter: "launchd" | "systemd";
}

export type ManagedServiceDefinitionDiagnostic = "retained" | "absent" | "changed" | "unknown";
export type ManagedServiceStateDiagnostic = "active" | "inactive" | "absent" | "unknown";

export class ManagedServiceUninstallError extends Error {
  readonly definitionState: ManagedServiceDefinitionDiagnostic;
  readonly serviceState: ManagedServiceStateDiagnostic;
  readonly serviceRecoveryCommand: readonly [string, ...string[]] | null;
  readonly runningIdentityRestored: boolean | null;

  constructor(diagnostic: {
    readonly definitionState: ManagedServiceDefinitionDiagnostic;
    readonly serviceState: ManagedServiceStateDiagnostic;
    readonly serviceRecoveryCommand: readonly [string, ...string[]] | null;
    readonly runningIdentityRestored: boolean | null;
  }) {
    super("Managed service uninstallation did not complete.");
    this.name = "ManagedServiceUninstallError";
    this.definitionState = diagnostic.definitionState;
    this.serviceState = diagnostic.serviceState;
    this.serviceRecoveryCommand = diagnostic.serviceRecoveryCommand;
    this.runningIdentityRestored = diagnostic.runningIdentityRestored;
  }
}

export async function uninstallManagedService(
  input: ManagedServiceUninstallInput,
): Promise<ManagedServiceUninstallResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 300_000) {
    throw new Error("Managed service uninstall timeout is invalid.");
  }
  const lock = await acquireManagedServiceLock(
    input.dataDirectory,
    operatorErrors.MANAGED_SERVICE_UNINSTALL_BUSY,
  );
  try {
    await input.assertControllerBinding();
    const definitionState = await inspectManagedServiceDefinition(input.definition, input.uid);
    const runtime = await input.inspectRuntime();
    let service: ManagedServiceProbeState;
    try {
      service = await input.inspectService();
    } catch {
      throw new ManagedServiceUninstallError({
        definitionState: definitionState.kind === "absent" ? "absent" : "retained",
        serviceState: "unknown",
        serviceRecoveryCommand: null,
        runningIdentityRestored: null,
      });
    }
    if (definitionState.kind === "absent") {
      if (service.state !== "absent") throw operatorErrors.MANAGED_SERVICE_REGISTRATION_LEFTOVER;
      return result("already-absent", input.definition);
    }

    const previousActive = service.state === "active";
    const previousIdentity = previousActive && runtime.running && runtime.mode === "managed"
      ? runtime.identity ?? null
      : null;
    try {
      if (mustRemoveController(input.definition, service)) {
        await runManagedServiceWithDeadline(
          input.timeoutMs,
          (signal) => input.run(input.definition.rollbackRemove, signal),
        );
        if (previousActive && runtime.running && runtime.mode === "managed") {
          await waitForRuntimeStopped(input);
        }
      }
      await removeManagedServiceDefinition(input.definition, definitionState, input.uid);
      if (input.definition.reload !== null) {
        await runManagedServiceWithDeadline(
          input.timeoutMs,
          (signal) => input.run(input.definition.reload!, signal),
        );
      }
      if ((await input.inspectService()).state !== "absent") {
        throw new Error("Managed service controller still reports the service after removal.");
      }
      return result(previousActive ? "removed-active" : "removed-inactive", input.definition);
    } catch {
      throw new ManagedServiceUninstallError(await recoverUninstall(
        input,
        definitionState.content,
        previousActive,
        previousIdentity,
      ));
    }
  } finally {
    await lock.release();
  }
}

function mustRemoveController(
  definition: ManagedServiceDefinition,
  service: ManagedServiceProbeState,
): boolean {
  if (service.state === "active") return true;
  if (service.state === "absent") return false;
  if (definition.platform === "systemd") return true;
  return commandsEqual(service.recoveryCommand, definition.recoverLoaded);
}

function commandsEqual(
  left: readonly string[] | null,
  right: readonly string[],
): boolean {
  return left !== null && left.length === right.length && left.every((value, index) => value === right[index]);
}

async function waitForRuntimeStopped(input: ManagedServiceUninstallInput): Promise<void> {
  await runManagedServiceWithDeadline(input.timeoutMs, async (signal) => {
    while (!signal.aborted) {
      if (!(await input.inspectRuntime()).running) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    throw new Error("Managed runtime stop timed out.");
  });
}

async function recoverUninstall(
  input: ManagedServiceUninstallInput,
  previousContent: string,
  previousActive: boolean,
  previousIdentity: RuntimeBuildIdentity | null,
): Promise<{
  readonly definitionState: ManagedServiceDefinitionDiagnostic;
  readonly serviceState: ManagedServiceStateDiagnostic;
  readonly serviceRecoveryCommand: readonly [string, ...string[]] | null;
  readonly runningIdentityRestored: boolean | null;
}> {
  let definitionState = await observeDefinition(input.definition, previousContent, input.uid);
  if (definitionState === "absent") {
    try {
      await writeManagedServicePrivateFile(
        input.definition.definitionPath,
        previousContent,
        input.uid,
        null,
      );
      definitionState = "retained";
    } catch {
      definitionState = await observeDefinition(input.definition, previousContent, input.uid);
    }
  }

  let service = await observeService(input);
  if (previousActive && definitionState === "retained" && service.state !== "active") {
    try {
      if (input.definition.reload !== null) {
        await runManagedServiceWithDeadline(
          input.timeoutMs,
          (signal) => input.run(input.definition.reload!, signal),
        );
      }
      await runManagedServiceWithDeadline(
        input.timeoutMs,
        (signal) => input.run(input.definition.install, signal),
      );
    } catch {
      // The observed post-recovery state below is the operator-facing result.
    }
    service = await observeService(input);
  }

  let runningIdentityRestored: boolean | null = null;
  if (previousActive && previousIdentity !== null) {
    if (service.state !== "active") {
      runningIdentityRestored = false;
    } else {
      try {
        const identity = await runManagedServiceWithDeadline(input.timeoutMs, input.probe);
        runningIdentityRestored = managedRuntimeIdentitiesMatch(identity, previousIdentity);
      } catch {
        runningIdentityRestored = null;
      }
    }
  }
  return Object.freeze({
    definitionState,
    serviceState: service.state,
    serviceRecoveryCommand: recoveryCommand(input.definition, definitionState, service),
    runningIdentityRestored,
  });
}

function recoveryCommand(
  definition: ManagedServiceDefinition,
  definitionState: ManagedServiceDefinitionDiagnostic,
  service: {
    readonly state: ManagedServiceStateDiagnostic;
    readonly recoveryCommand: readonly [string, ...string[]] | null;
  },
): readonly [string, ...string[]] | null {
  if (definitionState !== "retained" || service.state === "active" || service.state === "unknown") {
    return null;
  }
  if (definition.platform === "systemd" || service.state === "absent") return definition.install;
  return service.recoveryCommand;
}

async function observeDefinition(
  definition: ManagedServiceDefinition,
  previousContent: string,
  uid: number | undefined,
): Promise<ManagedServiceDefinitionDiagnostic> {
  try {
    const state = await inspectManagedServiceDefinition(definition, uid);
    if (state.kind === "absent") return "absent";
    return state.content === previousContent ? "retained" : "changed";
  } catch {
    try {
      await lstat(definition.definitionPath);
      return "changed";
    } catch (inspectionError) {
      return (inspectionError as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
    }
  }
}

async function observeService(input: ManagedServiceUninstallInput): Promise<{
  readonly state: ManagedServiceStateDiagnostic;
  readonly recoveryCommand: readonly [string, ...string[]] | null;
}> {
  try {
    const service = await input.inspectService();
    return Object.freeze({ state: service.state, recoveryCommand: service.recoveryCommand });
  } catch {
    return Object.freeze({ state: "unknown", recoveryCommand: null });
  }
}

function result(
  outcome: ManagedServiceUninstallResult["outcome"],
  definition: ManagedServiceDefinition,
): ManagedServiceUninstallResult {
  return Object.freeze({ outcome, adapter: definition.platform });
}
