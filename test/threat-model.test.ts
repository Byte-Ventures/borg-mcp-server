import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("server threat model", () => {
  it("documents every #1016 acceptance boundary and preserves release authorization", async () => {
    const threatModel = await readFile("docs/threat-model.md", "utf8");
    const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      private: boolean;
      version: string;
      license: string;
    };

    for (const boundary of [
      "Separate least-privilege credentials",
      "Loopback default, explicit LAN consent, no discovery",
      "Verified TLS for non-loopback",
      "Authentication on all REST and SSE",
      "Hashed per-client rotate/revoke tokens",
      "Rate, body, connection, and storage limits",
      "No remote tool or subprocess execution",
      "Negative bind/auth/CORS/log-secret tests",
      "secret-output exceptions",
      "move `ca.key` to offline storage",
    ]) {
      expect(threatModel).toContain(boundary);
    }
    expect(releaseWorkflow).toContain('test "${SERVER_1016_APPROVED_SHA}" = "${release_commit}"');
    expect(manifest).toMatchObject({
      private: false,
      version: "0.1.3",
      license: "SEE LICENSE IN LICENSE",
    });
  });
});
