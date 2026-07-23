import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("server threat model", () => {
  it("documents every release acceptance boundary and preserves release authorization", async () => {
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
    expect(releaseWorkflow).toContain('test "${release_commit}" = "${GITHUB_SHA}"');
    expect(releaseWorkflow).toContain("git merge-base --is-ancestor");
    expect(releaseWorkflow).toContain(
      'test "$(sha256sum LICENSE | cut -d \' \' -f1)" = "9535abd9881dc5af88523e24e0bed77df8dddd0f255bb74710533ac71140d2a1"',
    );
    expect(manifest).toMatchObject({
      private: false,
      version: "0.1.15",
      license: "SEE LICENSE IN LICENSE",
    });
  });
});
