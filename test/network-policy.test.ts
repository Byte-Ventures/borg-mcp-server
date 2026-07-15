import { describe, expect, it } from "vitest";

import {
  DEFAULT_BIND_HOST,
  DEFAULT_PORT,
  resolveBindOptions,
} from "../src/network-policy.js";

describe("resolveBindOptions", () => {
  it("defaults to an explicit IPv4 loopback endpoint", () => {
    expect(DEFAULT_PORT).toBe(7_091);
    expect(resolveBindOptions({})).toEqual({
      host: DEFAULT_BIND_HOST,
      port: DEFAULT_PORT,
      mode: "loopback",
    });
  });

  it.each(["127.0.0.1", "127.10.20.30", "::1"])(
    "allows the explicit loopback address %s",
    (host) => {
      expect(resolveBindOptions({ host }).mode).toBe("loopback");
    },
  );

  it.each(["0.0.0.0", "::"])("rejects wildcard bind %s even with LAN consent", (host) => {
    expect(() => resolveBindOptions({ host, lanConsent: true })).toThrow(
      "Choose a specific loopback or private-LAN IP; wildcard binds are prohibited.",
    );
  });

  it.each(["10.0.0.4", "172.20.0.4", "192.168.1.4", "fd00::4"])(
    "requires fresh LAN consent for private address %s",
    (host) => {
      expect(() => resolveBindOptions({ host })).toThrow(
        "Add --lan to consent to this private-LAN start.",
      );
      expect(resolveBindOptions({ host, lanConsent: true }).mode).toBe("lan");
    },
  );

  it.each(["8.8.8.8", "2001:4860:4860::8888"])(
    "rejects public address %s",
    (host) => {
      expect(() => resolveBindOptions({ host, lanConsent: true })).toThrow(
        "Choose a loopback or private-LAN IP; public-routable binds are unsupported.",
      );
    },
  );

  it("rejects hostnames to avoid DNS-dependent bind policy", () => {
    expect(() => resolveBindOptions({ host: "localhost" })).toThrow(
      "Configure --host as an explicit IP address.",
    );
  });

  it.each([-1, 65_536, 1.5])("rejects invalid port %s", (port) => {
    expect(() => resolveBindOptions({ port })).toThrow(
      "Configure the listen port as an integer from 0 to 65535.",
    );
  });
});
