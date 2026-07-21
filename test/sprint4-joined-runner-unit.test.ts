import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SPRINT4_CLIENT_DIRECTORY,
  SPRINT4_JOINED_GATE,
  SPRINT4_CLIENT_FIXTURE_SHA256,
  SPRINT4_CLIENT_SHA,
  assertClientPinValues,
  assertProvisionedRun,
  cleanupJoinedRun,
  isJoinedRunEnabled,
  parseStructuredResult,
  redactOutput,
  runBounded,
  validateJoinedRunnerEnvironment,
} from "./sprint4-joined-runner.js";

describe("Sprint 4 joined runner safeguards", () => {
  it("requires the narrow declaration-time gate and an absolute client directory", () => {
    expect(isJoinedRunEnabled({ [SPRINT4_JOINED_GATE]: "1" })).toBe(true);
    expect(isJoinedRunEnabled({ [SPRINT4_JOINED_GATE]: "true" })).toBe(false);
    expect(() => validateJoinedRunnerEnvironment({})).toThrow("explicit opt-in");
    expect(() => validateJoinedRunnerEnvironment({ [SPRINT4_JOINED_GATE]: "1", [SPRINT4_CLIENT_DIRECTORY]: "relative" })).toThrow("absolute");
    expect(() => validateJoinedRunnerEnvironment({ [SPRINT4_JOINED_GATE]: "1", [SPRINT4_CLIENT_DIRECTORY]: "/tmp/client", BORG_CLOUD: "1" })).toThrow("Cloud");
  });

  it("rejects either client pin before any provisioned state exists", () => {
    expect(() => assertClientPinValues("bad", SPRINT4_CLIENT_FIXTURE_SHA256)).toThrow("SHA");
    expect(() => assertClientPinValues(SPRINT4_CLIENT_SHA, "bad")).toThrow("hash");
  });

  it("parses only the structured result and redacts credential-shaped output", () => {
    expect(parseStructuredResult("noise\nS4_COUPLED_E2E {\"pass\":true}\n")).toEqual({ pass: true });
    expect(() => parseStructuredResult("S4_COUPLED_E2E []")).toThrow("invalid");
    expect(redactOutput("Bearer secret client_credential\":\"also-secret\"")).not.toContain("secret");
  });

  it("rejects an unsafe or non-cleanup provisioner contract before fixture spawn", () => {
    expect(() => assertProvisionedRun({
      endpoint: "https://localhost:1234",
      trustIdentity: "spki-sha256:" + "a".repeat(64),
      credentialReferences: { reader: "/tmp/a", writerA: "/tmp/b", writerB: "/tmp/c" },
      cleanup: async () => {},
    } as never)).toThrow("unsafe");
    expect(() => assertProvisionedRun({
      endpoint: "https://127.0.0.1:1234",
      trustIdentity: "spki-sha256:" + "a".repeat(64),
      credentialReferences: { reader: "/tmp/a", writerA: "/tmp/b", writerB: "/tmp/c" },
      cleanup: undefined,
    } as never)).toThrow("unsafe");
  });

  it("bounds spawn errors and stalled children", async () => {
    await expect(runBounded("definitely-not-a-command", [], { cwd: process.cwd(), env: {} }, 100)).rejects.toThrow();
    await expect(runBounded(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { cwd: process.cwd(), env: process.env }, 10)).rejects.toThrow("timed out");
  });

  it("cleans owned state even if provisioner cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-s4-runner-unit-"));
    await writeFile(join(root, "owned"), "state");
    await expect(cleanupJoinedRun({ cleanup: async () => { throw new Error("cleanup failure"); } }, root)).rejects.toThrow("cleanup failure");
    await expect(rm(root, { recursive: true, force: false })).rejects.toThrow();
  });
});
