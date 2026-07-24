import { describe, expect, it, vi } from "vitest";

import { createRuntimeOperator, RuntimeUpdateFailure } from "../src/runtime-operator.js";
import { operatorErrors, operatorPublicMessage } from "../src/operator-error.js";
import { RuntimeActivationError, RuntimeArtifactInstallError } from "../src/runtime-lifecycle.js";
import type { RegistryRuntimeArtifact } from "../src/registry-artifact.js";
import type { RuntimeLifecycle, VerifiedRuntimeArtifact } from "../src/runtime-lifecycle.js";

const artifact: VerifiedRuntimeArtifact = {
  artifactDirectory: "/runtime/artifacts/a",
  packageDirectory: "/runtime/artifacts/a/package",
  version: "0.2.0",
  integrity: `sha512-${"A".repeat(86)}==`,
  sourceSha: "a".repeat(40),
  treeSha256: "b".repeat(64),
};

describe("runtime operator", () => {
  it("prepares a verified fresh artifact without starting a process", async () => {
    const fixture = createFixture(false);
    await expect(fixture.operator.updateLatest(1_000)).resolves.toMatchObject({
      outcome: "prepared",
      runningIdentity: null,
      dataIdentity: "preserved",
    });
    expect(fixture.lifecycle.prepare).toHaveBeenCalledOnce();
    expect(fixture.lifecycle.activate).not.toHaveBeenCalled();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("activates and returns only the exact probed running identity", async () => {
    const fixture = createFixture(true);
    await expect(fixture.operator.updateLatest(1_000)).resolves.toMatchObject({
      outcome: "updated",
      runningIdentity: { package_version: "0.2.0", artifact_integrity: artifact.integrity },
      dataIdentity: "preserved",
    });
    expect(fixture.lifecycle.activate).toHaveBeenCalledWith({
      runtimeRoot: "/runtime",
      artifact,
      timeoutMs: 1_000,
    });
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("fails on a source that ignores cancellation and cleans a late download", async () => {
    let release!: (value: RegistryRuntimeArtifact) => void;
    const cleanup = vi.fn(async () => undefined);
    const download = new Promise<RegistryRuntimeArtifact>((resolve) => { release = resolve; });
    const fixture = createFixture(false);
    const operator = createRuntimeOperator({
      runtimeRoot: "/runtime",
      artifacts: { latest: vi.fn(() => download) },
      lifecycle: fixture.lifecycle,
      isRunning: vi.fn(async () => false),
    });

    await expect(operator.prepareLatest(100)).rejects.toThrow("Runtime artifact download timed out.");
    release({
      tarballPath: "/runtime/download/late.tgz",
      version: artifact.version,
      integrity: artifact.integrity,
      sourceSha: artifact.sourceSha,
      cleanup,
    });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(fixture.lifecycle.stage).not.toHaveBeenCalled();
  });

  it("maps artifact install failure to bounded setup guidance", async () => {
    const fixture = createFixture(false);
    fixture.lifecycle.stage.mockRejectedValueOnce(new RuntimeArtifactInstallError());

    let failure: unknown;
    try {
      await fixture.operator.prepareLatest(1_000);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(operatorErrors.RUNTIME_ARTIFACT_INSTALL_FAILED);
    expect(operatorPublicMessage(failure)).toBe(
      "Setup could not prepare the verified runtime.\n" +
      "Next: check your Node.js and npm installation, then rerun setup.",
    );
  });

  it("reports verification failure before activation and bounded rollback outcome after activation", async () => {
    const verification = createFixture(false);
    verification.lifecycle.stage.mockRejectedValueOnce(new Error("secret verification detail"));
    await expect(verification.operator.updateLatest(1_000)).rejects.toEqual(
      new RuntimeUpdateFailure("ARTIFACT_VERIFICATION_FAILED"),
    );
    expect(verification.lifecycle.activate).not.toHaveBeenCalled();

    const activation = createFixture(true);
    activation.lifecycle.activate.mockRejectedValueOnce(new RuntimeActivationError("restored"));
    await expect(activation.operator.updateLatest(1_000)).rejects.toEqual(
      new RuntimeUpdateFailure("ACTIVATION_FAILED", "restored"),
    );
  });
});

function createFixture(running: boolean) {
  const cleanup = vi.fn(async () => undefined);
  const downloaded: RegistryRuntimeArtifact = {
    tarballPath: "/runtime/download/server.tgz",
    version: artifact.version,
    integrity: artifact.integrity,
    sourceSha: artifact.sourceSha,
    cleanup,
  };
  const lifecycle = {
    stage: vi.fn(async () => artifact),
    prepare: vi.fn(async () => artifact),
    activate: vi.fn(async () => ({
      package_version: artifact.version,
      artifact_integrity: artifact.integrity,
      source_sha: artifact.sourceSha,
      protocol_version: "4",
      started_at: "2026-07-21T12:00:00.000Z",
    })),
  } satisfies RuntimeLifecycle;
  return {
    cleanup,
    lifecycle,
    operator: createRuntimeOperator({
      runtimeRoot: "/runtime",
      artifacts: { latest: vi.fn(async () => downloaded) },
      lifecycle,
      isRunning: vi.fn(async () => running),
    }),
  };
}
