import { SPRINT4_CLEANUP_TIMEOUT_MS, SPRINT4_RUNNER_TIMEOUT_MS } from "./sprint4-joined-runner.js";

/**
 * The outer Vitest case must contain both the bounded client process and the
 * bounded cleanup path, with one full runner bound left as teardown margin.
 */
export const SPRINT4_JOINED_TEST_TIMEOUT_MS =
  SPRINT4_RUNNER_TIMEOUT_MS + SPRINT4_CLEANUP_TIMEOUT_MS + SPRINT4_RUNNER_TIMEOUT_MS;
