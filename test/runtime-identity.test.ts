import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntimeBuildIdentity,
  loadRuntimeBuildIdentity,
  RUNTIME_INFO_PATH,
  SERVER_PACKAGE_VERSION,
} from "../src/runtime-identity.js";

describe("runtime build identity", () => {
  it("reports exact embedded and artifact identities without checkout inference", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(SERVER_PACKAGE_VERSION).toBe(manifest.version);
    expect(createRuntimeBuildIdentity({
      sourceSha: "a".repeat(40),
      artifactIntegrity: `sha512-${"A".repeat(86)}==`,
      startedAt: new Date("2026-07-21T12:00:00.000Z"),
    })).toEqual({
      package_version: SERVER_PACKAGE_VERSION,
      source_sha: "a".repeat(40),
      artifact_integrity: `sha512-${"A".repeat(86)}==`,
      protocol_version: "2",
      started_at: "2026-07-21T12:00:00.000Z",
    });
    expect(RUNTIME_INFO_PATH).toBe("/api/runtime");
  });

  it("represents unavailable build metadata explicitly and rejects guessed identities", () => {
    expect(createRuntimeBuildIdentity({ startedAt: new Date(0) })).toMatchObject({
      source_sha: null,
      artifact_integrity: null,
    });
    expect(() => createRuntimeBuildIdentity({ sourceSha: "checkout-main" })).toThrow(
      "Server source identity is invalid.",
    );
    expect(() => createRuntimeBuildIdentity({ artifactIntegrity: "sha512-unverified" })).toThrow(
      "Server artifact identity is invalid.",
    );
  });

  it("binds managed starts to the adjacent activated artifact descriptor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "borg-runtime-identity-"));
    const path = join(directory, "artifact.json");
    const integrity = `sha512-${"A".repeat(86)}==`;
    try {
      await writeFile(path, JSON.stringify({
        version: SERVER_PACKAGE_VERSION,
        integrity,
        source_sha: "a".repeat(40),
      }));
      await expect(loadRuntimeBuildIdentity({
        artifactDescriptorPath: path,
        startedAt: new Date(0),
      })).resolves.toMatchObject({
        package_version: SERVER_PACKAGE_VERSION,
        artifact_integrity: integrity,
        source_sha: "a".repeat(40),
      });
      await expect(loadRuntimeBuildIdentity({
        artifactDescriptorPath: path,
        artifactIntegrity: `sha512-${"B".repeat(86)}==`,
      })).rejects.toThrow("Runtime artifact identity conflicts with the activated artifact.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
