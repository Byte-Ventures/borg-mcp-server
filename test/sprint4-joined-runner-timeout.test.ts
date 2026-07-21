import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  SPRINT4_CLEANUP_TIMEOUT_MS,
  SPRINT4_RUNNER_TIMEOUT_MS,
  cleanupJoinedRun,
} from "./sprint4-joined-runner.js";
import { SPRINT4_JOINED_TEST_TIMEOUT_MS } from "./sprint4-joined-runner-timeout.js";

it("keeps the opt-in test above the child and cleanup bounds instead of Vitest's 5s default", () => {
  expect(SPRINT4_JOINED_TEST_TIMEOUT_MS).toBeGreaterThan(
    SPRINT4_RUNNER_TIMEOUT_MS + SPRINT4_CLEANUP_TIMEOUT_MS,
  );
  expect(SPRINT4_JOINED_TEST_TIMEOUT_MS).toBeGreaterThan(5_000);
});

it("keeps stalled cleanup bounded and removes the owned root", async () => {
  const root = await mkdtemp(join(tmpdir(), "borg-s4-runner-timeout-"));
  await writeFile(join(root, "owned"), "state");
  await expect(cleanupJoinedRun(
    { cleanup: () => new Promise<void>(() => {}) },
    root,
    rm,
    10,
  )).rejects.toThrow("cleanup timed out");
  await expect(access(root)).rejects.toThrow();
});
