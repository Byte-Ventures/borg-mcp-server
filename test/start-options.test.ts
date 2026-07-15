import { describe, expect, it } from "vitest";

import { parseStartOptions } from "../src/start-options.js";

describe("parseStartOptions", () => {
  it("parses an explicit endpoint and per-start LAN consent", () => {
    expect(parseStartOptions(["--host", "192.168.10.8", "--port", "8123", "--lan"])).toEqual({
      host: "192.168.10.8",
      port: 8_123,
      lanConsent: true,
    });
  });

  it.each([
    ["--host"],
    ["--port"],
    ["--port", "secret"],
    ["--lan", "--lan"],
    ["--unknown"],
  ])("rejects malformed or ambiguous options: %j", (...args) => {
    expect(() => parseStartOptions(args)).toThrow();
  });
});
