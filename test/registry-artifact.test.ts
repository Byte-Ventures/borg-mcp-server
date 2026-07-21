import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRegistryArtifactSource } from "../src/registry-artifact.js";

const directories: string[] = [];
const integrity = `sha512-${"A".repeat(86)}==`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("registry runtime artifact", () => {
  it("accepts only canonical bounded metadata and tarball responses and cleans owned download state", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-registry-artifact-"));
    directories.push(root);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(JSON.stringify({
        name: "borgmcp-server",
        version: "0.2.0",
        gitHead: "a".repeat(40),
        dist: {
          integrity,
          tarball: "https://registry.npmjs.org/borgmcp-server/-/borgmcp-server-0.2.0.tgz",
        },
      }), "https://registry.npmjs.org/borgmcp-server/latest"))
      .mockResolvedValueOnce(response(
        "verified tarball",
        "https://registry.npmjs.org/borgmcp-server/-/borgmcp-server-0.2.0.tgz",
      ));

    const artifact = await createRegistryArtifactSource(request).latest(
      join(root, "runtime"),
      new AbortController().signal,
    );
    expect(await readFile(artifact.tarballPath, "utf8")).toBe("verified tarball");
    expect(artifact).toMatchObject({ version: "0.2.0", integrity, sourceSha: "a".repeat(40) });
    await artifact.cleanup();
    await expect(access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects redirected or noncanonical metadata before downloading an artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-registry-artifact-hostile-"));
    directories.push(root);
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({
      name: "borgmcp-server",
      version: "0.2.0",
      dist: { integrity, tarball: "https://attacker.invalid/server.tgz" },
    }), "https://registry.npmjs.org/borgmcp-server/latest"));
    await expect(createRegistryArtifactSource(request).latest(
      join(root, "runtime"),
      new AbortController().signal,
    )).rejects.toThrow("Server artifact metadata verification failed.");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a symbolic-link runtime root before any registry request", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-registry-root-"));
    directories.push(root);
    const target = join(root, "target");
    const linked = join(root, "linked");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked, "dir");
    const request = vi.fn<typeof fetch>();

    await expect(createRegistryArtifactSource(request).latest(
      linked,
      new AbortController().signal,
    )).rejects.toThrow("Runtime root must be a private directory.");
    expect(request).not.toHaveBeenCalled();
  });
});

function response(body: string, url: string): Response {
  const value = new Response(body, { status: 200 });
  Object.defineProperty(value, "url", { value: url });
  return value;
}
