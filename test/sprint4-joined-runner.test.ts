import { describe, it } from "vitest";

import { executeJoinedRunner, isJoinedRunEnabled } from "./sprint4-joined-runner.js";
import { SPRINT4_JOINED_TEST_TIMEOUT_MS } from "./sprint4-joined-runner-timeout.js";

const joined = isJoinedRunEnabled() ? it : it.skip;

describe("Sprint 4 opt-in joined runner", () => {
  joined("runs the approved client fixture only with the explicit environment gate", async () => {
    await executeJoinedRunner();
  }, SPRINT4_JOINED_TEST_TIMEOUT_MS);
});
