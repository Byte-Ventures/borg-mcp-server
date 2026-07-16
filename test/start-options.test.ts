import { describe, expect, it } from "vitest";

import { parseStartOptions } from "../src/start-options.js";

describe("parseStartOptions", () => {
  it("parses an explicit endpoint and per-start LAN consent", () => {
    expect(parseStartOptions(["--host", "192.168.10.8", "--port", "8123", "--lan"])).toEqual({
      bind: {
        host: "192.168.10.8",
        port: 8_123,
        lanConsent: true,
      },
    });
  });

  it("enables only the explicit debug level without leaking it into bind options", () => {
    expect(parseStartOptions(["--log-level", "debug"])).toEqual({
      bind: {},
      logLevel: "debug",
    });
  });

  it.each([
    ["--host"],
    ["--port"],
    ["--port", "secret"],
    ["--lan", "--lan"],
    ["--log-level"],
    ["--log-level", "secret"],
    ["--log-level", "debug", "--log-level", "debug"],
    ["--unknown"],
  ])("rejects malformed or ambiguous options: %j", (...args) => {
    expect(() => parseStartOptions(args)).toThrow();
  });
});
