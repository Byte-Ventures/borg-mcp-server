import type { RegistryArtifactSource } from "./registry-artifact.js";
import {
  RuntimeActivationError,
  RuntimeArtifactInstallError,
  type RuntimeLifecycle,
  type RuntimeRecoveryState,
  type VerifiedRuntimeArtifact,
} from "./runtime-lifecycle.js";
import { operatorErrors } from "./operator-error.js";
import type { RuntimeBuildIdentity } from "./runtime-identity.js";

export interface RuntimeOperator {
  readonly prepareLatest: (timeoutMs: number) => Promise<VerifiedRuntimeArtifact>;
  readonly updateLatest: (timeoutMs: number) => Promise<RuntimeUpdateResult>;
}

export interface RuntimeUpdateResult {
  readonly outcome: "prepared" | "updated";
  readonly artifact: VerifiedRuntimeArtifact;
  readonly runningIdentity: RuntimeBuildIdentity | null;
  readonly dataIdentity: "preserved";
}

export class RuntimeUpdateFailure extends Error {
  readonly code: "ARTIFACT_VERIFICATION_FAILED" | "ACTIVATION_FAILED";
  readonly recovery: RuntimeRecoveryState | null;

  constructor(
    code: "ARTIFACT_VERIFICATION_FAILED" | "ACTIVATION_FAILED",
    recovery: RuntimeRecoveryState | null = null,
  ) {
    super("Runtime update did not complete.");
    this.name = "RuntimeUpdateFailure";
    this.code = code;
    this.recovery = recovery;
  }
}

export function createRuntimeOperator(options: {
  readonly runtimeRoot: string;
  readonly artifacts: RegistryArtifactSource;
  readonly lifecycle: RuntimeLifecycle;
  readonly isRunning: () => Promise<boolean>;
}): RuntimeOperator {
  const stageLatest = async (timeoutMs: number): Promise<VerifiedRuntimeArtifact> => {
    validateTimeout(timeoutMs);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let downloaded: Awaited<ReturnType<RegistryArtifactSource["latest"]>> | undefined;
    const download = options.artifacts.latest(options.runtimeRoot, controller.signal);
    try {
      downloaded = await Promise.race([
        download,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Runtime artifact download timed out."));
          }, timeoutMs);
        }),
      ]);
      return await options.lifecycle.stage({
        runtimeRoot: options.runtimeRoot,
        tarballPath: downloaded.tarballPath,
        expectedIntegrity: downloaded.integrity,
        expectedVersion: downloaded.version,
        ...(downloaded.sourceSha === null ? {} : { sourceSha: downloaded.sourceSha }),
        timeoutMs,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (downloaded === undefined) {
        void download.then((late) => late.cleanup()).catch(() => undefined);
      }
      await downloaded?.cleanup();
    }
  };
  return {
    async prepareLatest(timeoutMs): Promise<VerifiedRuntimeArtifact> {
      let artifact: VerifiedRuntimeArtifact;
      try {
        artifact = await stageLatest(timeoutMs);
      } catch (error) {
        if (error instanceof RuntimeArtifactInstallError) {
          throw operatorErrors.RUNTIME_ARTIFACT_INSTALL_FAILED;
        }
        throw error;
      }
      return options.lifecycle.prepare({ runtimeRoot: options.runtimeRoot, artifact });
    },
    async updateLatest(timeoutMs): Promise<RuntimeUpdateResult> {
      await options.isRunning();
      let artifact: VerifiedRuntimeArtifact;
      try {
        artifact = await stageLatest(timeoutMs);
      } catch {
        throw new RuntimeUpdateFailure("ARTIFACT_VERIFICATION_FAILED");
      }
      if (!await options.isRunning()) {
        await options.lifecycle.prepare({ runtimeRoot: options.runtimeRoot, artifact });
        return Object.freeze({
          outcome: "prepared",
          artifact,
          runningIdentity: null,
          dataIdentity: "preserved",
        });
      }
      let runningIdentity: RuntimeBuildIdentity;
      try {
        runningIdentity = await options.lifecycle.activate({
          runtimeRoot: options.runtimeRoot,
          artifact,
          timeoutMs,
        });
      } catch (error) {
        throw new RuntimeUpdateFailure(
          "ACTIVATION_FAILED",
          error instanceof RuntimeActivationError ? error.recovery : "failed",
        );
      }
      return Object.freeze({
        outcome: "updated",
        artifact,
        runningIdentity,
        dataIdentity: "preserved",
      });
    },
  };
}

function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) {
    throw new Error("Runtime operator timeout is invalid.");
  }
}
