import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareRelease, verifyReleaseIdentity } from "../scripts/release-identity.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("release identity", () => {
  it("prepares and verifies package, lock, runtime, and pinned versions without tree coupling", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-release-identity-"));
    roots.push(root);
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "borgmcp-server", version: "1.0.0" }, null, 2) + "\n");
    await writeFile(join(root, "npm-shrinkwrap.json"), JSON.stringify({
      name: "borgmcp-server", version: "1.0.0", packages: { "": { name: "borgmcp-server", version: "1.0.0" } },
    }, null, 2) + "\n");
    await writeFile(join(root, "src/runtime-identity.ts"), 'export const SERVER_PACKAGE_VERSION = "1.0.0";\n');
    await writeFile(join(root, "test/pin.ts"), 'expect(version).toBe("1.0.0");\n');
    await writeFile(join(root, "scripts/release-identity-allowlist.json"), JSON.stringify({ versionPins: ["test/pin.ts"] }, null, 2) + "\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await prepareRelease(root, "1.1.0");
    await writeFile(join(root, "unrelated.txt"), "allowed post-prep correction\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "release"], { cwd: root });
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(verifyReleaseIdentity(root, base, candidate)).toMatchObject({ oldVersion: "1.0.0", newVersion: "1.1.0" });
    expect(await readFile(join(root, "unrelated.txt"), "utf8")).toContain("post-prep");
  });
});
