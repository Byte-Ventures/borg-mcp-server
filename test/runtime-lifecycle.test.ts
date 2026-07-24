import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeLifecycle,
  createUnixNpmArtifactUnpacker,
  RuntimeArtifactInstallError,
} from "../src/runtime-lifecycle.js";
import type { RuntimeBuildIdentity } from "../src/runtime-identity.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    await makeWritable(directory).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("immutable runtime lifecycle", () => {
  it("uses bounded shell-free Unix tooling and rejects unsafe archive entries before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-runtime-unpacker-"));
    directories.push(root);
    const archive = Buffer.from("verified archive bytes");
    const shrinkwrap = Buffer.from('{"lockfileVersion":3,"packages":{}}\n');
    const staging = join(root, "staging");
    await mkdir(staging);
    const canonicalStaging = await realpath(staging);
    const calls: Array<{ executable: string; args: readonly string[]; cwd?: string }> = [];
    const tarInputs: Buffer[] = [];
    const run = vi.fn(async (executable: string, args: readonly string[], options: {
      readonly cwd?: string;
      readonly signal: AbortSignal;
      readonly stdin?: Buffer;
    }) => {
      calls.push({ executable, args, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
      if (options.stdin !== undefined) tarInputs.push(options.stdin);
      if (args[0] === "-xzf") {
        await mkdir(join(staging, "package"));
        await writeFile(join(staging, "package", "npm-shrinkwrap.json"), shrinkwrap);
      }
      if (executable === "/usr/bin/npm") {
        expect(await readFile(join(staging, "package", "package-lock.json"))).toEqual(shrinkwrap);
      }
      return { stdout: args[0] === "-tzf" ? "package/package.json\npackage/dist/main.js\n" : "", stderr: "" };
    });
    const unpack = createUnixNpmArtifactUnpacker({
      tarExecutable: "/usr/bin/tar",
      npmExecutable: "/usr/bin/npm",
      run,
    });
    await unpack(archive, staging, new AbortController().signal);
    expect(calls).toEqual([
      { executable: "/usr/bin/tar", args: ["-tzf", "-"] },
      { executable: "/usr/bin/tar", args: ["-xzf", "-", "-C", staging] },
      {
        executable: "/usr/bin/npm",
        args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd: join(canonicalStaging, "package"),
      },
    ]);
    expect(tarInputs).toEqual([archive, archive]);
    expect(await readFile(join(staging, "package", "package-lock.json"))).toEqual(shrinkwrap);

    run.mockResolvedValueOnce({ stdout: "package/../escape\n", stderr: "" });
    await expect(unpack(
      archive,
      staging,
      new AbortController().signal,
    )).rejects.toThrow("Runtime artifact archive entries are invalid.");
  });

  it.each(["11.18.0", "12.0.1"])("uses the materialized lock with npm %s", async (npmVersion) => {
    const root = await mkdtemp(join(tmpdir(), "borg-runtime-npm-compat-"));
    directories.push(root);
    const staging = join(root, "staging");
    await mkdir(join(staging, "package"), { recursive: true });
    const shrinkwrap = Buffer.from('{"lockfileVersion":3,"packages":{}}\n');
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "-xzf") {
        await writeFile(join(staging, "package", "npm-shrinkwrap.json"), shrinkwrap);
      }
      if (args[0] === "ci") {
        expect(await readFile(join(staging, "package", "package-lock.json"))).toEqual(shrinkwrap);
      }
      return { stdout: args[0] === "-tzf" ? "package/npm-shrinkwrap.json\n" : "", stderr: "" };
    });

    await createUnixNpmArtifactUnpacker({ npmExecutable: `npm-${npmVersion}`, run })(
      Buffer.from("verified archive"),
      staging,
      new AbortController().signal,
    );
    expect(run).toHaveBeenLastCalledWith(
      `npm-${npmVersion}`,
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("types install failures and removes their partial staging tree", async () => {
    const fixture = await createFixture();
    const archive = await writeArchive(fixture.root, "failed-install");
    const lifecycle = createRuntimeLifecycle({
      unpack: vi.fn(async () => { throw new Error("npm stderr with /private/operator/path"); }),
      restart: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn(),
    });

    await expect(lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: archive.path,
      expectedIntegrity: archive.integrity,
      expectedVersion: "0.2.0",
      timeoutMs: 1_000,
    })).rejects.toEqual(new RuntimeArtifactInstallError());
    expect((await readdir(fixture.runtimeRoot)).filter((name) => name.startsWith(".staging-")))
      .toEqual([]);
  });

  it("rejects an extracted package-root link before materializing or installing the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-runtime-unpacker-link-"));
    directories.push(root);
    const staging = join(root, "staging");
    const outside = join(root, "outside");
    await mkdir(staging);
    await mkdir(outside);
    await writeFile(join(outside, "npm-shrinkwrap.json"), '{"lockfileVersion":3}\n');
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "-xzf") await symlink(outside, join(staging, "package"), "dir");
      return {
        stdout: args[0] === "-tzf" ? "package/npm-shrinkwrap.json\n" : "",
        stderr: "",
      };
    });
    const unpack = createUnixNpmArtifactUnpacker({ run });

    await expect(unpack(
      Buffer.from("verified archive"),
      staging,
      new AbortController().signal,
    )).rejects.toThrow("Runtime artifact package escaped staging.");
    expect(run).toHaveBeenCalledTimes(2);
    await expect(access(join(outside, "package-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies archive bytes and stages a read-only versioned package", async () => {
    const fixture = await createFixture();
    const archive = await writeArchive(fixture.root, "artifact-one");
    const lifecycle = createRuntimeLifecycle({
      unpack: unpackVersion("0.2.0"),
      restart: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn(),
    });

    const artifact = await lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: archive.path,
      expectedIntegrity: archive.integrity,
      expectedVersion: "0.2.0",
      sourceSha: "a".repeat(40),
      timeoutMs: 1_000,
    });

    expect(await readFile(join(artifact.packageDirectory, "package.json"), "utf8"))
      .toContain('"version":"0.2.0"');
    expect(artifact.artifactDirectory).toMatch(/\/artifacts\/[0-9a-f]{64}$/u);
    await expect(lifecycle.prepare({
      runtimeRoot: fixture.runtimeRoot,
      artifact,
    })).resolves.toEqual(artifact);
    expect(await realpath(join(fixture.runtimeRoot, "current"))).toBe(artifact.artifactDirectory);
    await expect(lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: archive.path,
      expectedIntegrity: `sha512-${"A".repeat(86)}==`,
      expectedVersion: "0.2.0",
      timeoutMs: 1_000,
    })).rejects.toThrow("Runtime artifact integrity does not match.");

    await chmod(artifact.packageDirectory, 0o700);
    await chmod(join(artifact.packageDirectory, "dist"), 0o700);
    await chmod(join(artifact.packageDirectory, "dist", "main.js"), 0o600);
    await writeFile(join(artifact.packageDirectory, "dist", "main.js"), "tampered\n");
    await expect(lifecycle.prepare({
      runtimeRoot: fixture.runtimeRoot,
      artifact,
    })).rejects.toThrow("Runtime artifact content changed.");
  });

  it("binds the unpack consumer to verified bytes despite source-path replacement", async () => {
    const fixture = await createFixture();
    const archive = await writeArchive(fixture.root, "verified-original");
    let consumed: Buffer | undefined;
    const lifecycle = createRuntimeLifecycle({
      unpack: async (verifiedBytes, staging) => {
        await writeFile(archive.path, "unverified-replacement");
        const stagingReplacement = join(staging, "replacement.tgz");
        await writeFile(stagingReplacement, "staging-path-replacement");
        consumed = verifiedBytes;
        expect(verifiedBytes.toString("utf8")).toBe("verified-original");
        await rm(stagingReplacement);
        await unpackVersion("0.2.0")(verifiedBytes, staging);
      },
      restart: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn(),
    });

    const artifact = await lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: archive.path,
      expectedIntegrity: archive.integrity,
      expectedVersion: "0.2.0",
      timeoutMs: 1_000,
    });
    expect(consumed?.toString("utf8")).toBe("verified-original");
    expect(await readFile(archive.path, "utf8")).toBe("unverified-replacement");
    expect(await readdir(artifact.artifactDirectory)).not.toContain("verified-artifact.tgz");
    expect((await readdir(fixture.runtimeRoot)).filter((name) => name.startsWith(".staging-")))
      .toEqual([]);
    expect(await readdir(join(fixture.runtimeRoot, "artifacts"))).toHaveLength(1);
  });

  it("rejects a symbolic-link runtime root before staging", async () => {
    const fixture = await createFixture();
    const actualRoot = join(fixture.root, "actual-runtime");
    const linkedRoot = join(fixture.root, "linked-runtime");
    const archive = await writeArchive(fixture.root, "linked-root-artifact");
    await mkdir(actualRoot, { mode: 0o700 });
    await symlink(actualRoot, linkedRoot, "dir");
    const lifecycle = createRuntimeLifecycle({
      unpack: unpackVersion("0.2.0"),
      restart: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn(),
    });

    await expect(lifecycle.stage({
      runtimeRoot: linkedRoot,
      tarballPath: archive.path,
      expectedIntegrity: archive.integrity,
      expectedVersion: "0.2.0",
      timeoutMs: 1_000,
    })).rejects.toThrow("Runtime root must be a private directory.");
    expect(await readdir(actualRoot)).toEqual([]);
  });

  it("removes only owned partial staging after traversal, symlink, or timeout rejection", async () => {
    const fixture = await createFixture();
    const archive = await writeArchive(fixture.root, "hostile-artifact");
    const outside = join(fixture.root, "outside-main.js");
    await writeFile(outside, "preserve\n");
    const lifecycle = createRuntimeLifecycle({
      unpack: async (_tarball, staging) => {
        const packageDirectory = join(staging, "package");
        await mkdir(join(packageDirectory, "dist"), { recursive: true });
        await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
          name: "borgmcp-server",
          version: "0.2.0",
          bin: { "borg-mcp-server": "./dist/main.js" },
        }));
        await symlink(outside, join(packageDirectory, "dist", "main.js"));
      },
      restart: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn(),
    });
    await expect(lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: archive.path,
      expectedIntegrity: archive.integrity,
      expectedVersion: "0.2.0",
      timeoutMs: 1_000,
    })).rejects.toThrow("Runtime artifact entrypoint is invalid.");
    expect(await readFile(outside, "utf8")).toBe("preserve\n");
    expect((await readdir(fixture.runtimeRoot)).filter((name) => name.startsWith(".staging-"))).toEqual([]);

    let aborted = false;
    const stalled = createRuntimeLifecycle({
      unpack: (_tarball, _staging, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
      restart: vi.fn(),
      stop: vi.fn(),
      probe: vi.fn(),
    });
    await expect(stalled.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: archive.path,
      expectedIntegrity: archive.integrity,
      expectedVersion: "0.2.0",
      timeoutMs: 100,
    })).rejects.toEqual(new RuntimeArtifactInstallError());
    expect(aborted).toBe(true);
    expect((await readdir(fixture.runtimeRoot)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
  });

  it("atomically activates, verifies the running build, and rolls back a failed upgrade", async () => {
    const fixture = await createFixture();
    const firstArchive = await writeArchive(fixture.root, "artifact-one");
    const secondArchive = await writeArchive(fixture.root, "artifact-two");
    const firstIdentity = identity("0.2.0", firstArchive.integrity, "a".repeat(40));
    const secondIdentity = identity("0.3.0", secondArchive.integrity, "b".repeat(40));
    const probe = vi.fn<() => Promise<RuntimeBuildIdentity>>()
      .mockResolvedValueOnce(firstIdentity)
      .mockResolvedValueOnce({ ...secondIdentity, artifact_integrity: firstArchive.integrity })
      .mockResolvedValueOnce(firstIdentity);
    const restart = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    let unpackedVersion = "0.2.0";
    const lifecycle = createRuntimeLifecycle({
      unpack: async (_tarball, staging) => unpackVersion(unpackedVersion)(_tarball, staging),
      restart,
      stop,
      probe: async () => probe(),
    });
    const first = await lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: firstArchive.path,
      expectedIntegrity: firstArchive.integrity,
      expectedVersion: "0.2.0",
      sourceSha: "a".repeat(40),
      timeoutMs: 1_000,
    });
    unpackedVersion = "0.3.0";
    const second = await lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: secondArchive.path,
      expectedIntegrity: secondArchive.integrity,
      expectedVersion: "0.3.0",
      sourceSha: "b".repeat(40),
      timeoutMs: 1_000,
    });
    await writeFile(fixture.dataFile, "preserved-identity");

    await expect(lifecycle.activate({
      runtimeRoot: fixture.runtimeRoot,
      artifact: first,
      timeoutMs: 1_000,
    })).resolves.toEqual(firstIdentity);
    await expect(lifecycle.activate({
      runtimeRoot: fixture.runtimeRoot,
      artifact: second,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ name: "RuntimeActivationError", recovery: "restored" });

    expect(await realpath(join(fixture.runtimeRoot, "current"))).toBe(first.artifactDirectory);
    expect(await readFile(fixture.dataFile, "utf8")).toBe("preserved-identity");
    expect(restart).toHaveBeenCalledTimes(3);
    expect(stop).not.toHaveBeenCalled();
  });

  it("leaves a fresh failed activation stopped and reports rollback failure without touching data", async () => {
    const fixture = await createFixture();
    const archive = await writeArchive(fixture.root, "fresh-artifact");
    const stop = vi.fn(async () => undefined);
    const lifecycle = createRuntimeLifecycle({
      unpack: unpackVersion("0.2.0"),
      restart: vi.fn(async () => undefined),
      stop,
      probe: vi.fn(async () => identity("0.2.0", archive.integrity, "b".repeat(40))),
    });
    const artifact = await lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: archive.path,
      expectedIntegrity: archive.integrity,
      expectedVersion: "0.2.0",
      sourceSha: "a".repeat(40),
      timeoutMs: 1_000,
    });
    await writeFile(fixture.dataFile, "preserved-identity");

    await expect(lifecycle.activate({
      runtimeRoot: fixture.runtimeRoot,
      artifact,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ name: "RuntimeActivationError", recovery: "stopped" });
    await expect(access(join(fixture.runtimeRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(stop).toHaveBeenCalledOnce();
    expect(await readFile(fixture.dataFile, "utf8")).toBe("preserved-identity");
  });

  it("fails before restart on descriptor drift and surfaces an independently failed rollback", async () => {
    const fixture = await createFixture();
    const firstArchive = await writeArchive(fixture.root, "rollback-one");
    const secondArchive = await writeArchive(fixture.root, "rollback-two");
    let unpackedVersion = "0.2.0";
    const restart = vi.fn(async () => undefined);
    const probe = vi.fn<() => Promise<RuntimeBuildIdentity>>()
      .mockResolvedValueOnce(identity("0.2.0", firstArchive.integrity, "a".repeat(40)))
      .mockResolvedValueOnce(identity("0.3.0", firstArchive.integrity, "b".repeat(40)));
    const lifecycle = createRuntimeLifecycle({
      unpack: async (tarball, staging) => unpackVersion(unpackedVersion)(tarball, staging),
      restart,
      stop: vi.fn(),
      probe: async () => probe(),
    });
    const first = await lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: firstArchive.path,
      expectedIntegrity: firstArchive.integrity,
      expectedVersion: "0.2.0",
      sourceSha: "a".repeat(40),
      timeoutMs: 1_000,
    });
    await lifecycle.activate({ runtimeRoot: fixture.runtimeRoot, artifact: first, timeoutMs: 1_000 });
    unpackedVersion = "0.3.0";
    const second = await lifecycle.stage({
      runtimeRoot: fixture.runtimeRoot,
      tarballPath: secondArchive.path,
      expectedIntegrity: secondArchive.integrity,
      expectedVersion: "0.3.0",
      sourceSha: "b".repeat(40),
      timeoutMs: 1_000,
    });

    await chmod(second.artifactDirectory, 0o700);
    await chmod(join(second.artifactDirectory, "artifact.json"), 0o600);
    await writeFile(join(second.artifactDirectory, "artifact.json"), JSON.stringify({
      version: "0.3.0",
      integrity: secondArchive.integrity,
      source_sha: "c".repeat(40),
      tree_sha256: second.treeSha256,
    }));
    await expect(lifecycle.activate({
      runtimeRoot: fixture.runtimeRoot,
      artifact: second,
      timeoutMs: 1_000,
    })).rejects.toThrow("Runtime artifact descriptor changed.");
    expect(restart).toHaveBeenCalledOnce();

    await writeFile(join(second.artifactDirectory, "artifact.json"), JSON.stringify({
      version: "0.3.0",
      integrity: secondArchive.integrity,
      source_sha: "b".repeat(40),
      tree_sha256: second.treeSha256,
    }));
    restart.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("rollback restart failed"));
    await expect(lifecycle.activate({
      runtimeRoot: fixture.runtimeRoot,
      artifact: second,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ name: "RuntimeActivationError", recovery: "failed" });
    expect(await realpath(join(fixture.runtimeRoot, "current"))).toBe(first.artifactDirectory);
  });
});

async function createFixture(): Promise<{
  root: string;
  runtimeRoot: string;
  dataFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "borg-runtime-lifecycle-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime");
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory, { mode: 0o700 });
  return { root, runtimeRoot, dataFile: join(dataDirectory, "server.json") };
}

async function writeArchive(root: string, value: string): Promise<{ path: string; integrity: string }> {
  const path = join(root, `${value}.tgz`);
  const bytes = Buffer.from(value);
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    path,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function unpackVersion(version: string): (archive: Buffer, staging: string) => Promise<void> {
  return async (_tarball, staging) => {
    const packageDirectory = join(staging, "package");
    await mkdir(join(packageDirectory, "dist"), { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "borgmcp-server",
      version,
      bin: { "borg-mcp-server": "./dist/main.js" },
    }));
    await writeFile(join(packageDirectory, "dist", "main.js"), "export {};\n");
  };
}

function identity(version: string, integrity: string, sha: string): RuntimeBuildIdentity {
  return {
    package_version: version,
    artifact_integrity: integrity,
    source_sha: sha,
    protocol_version: "4",
    started_at: "2026-07-21T12:00:00.000Z",
  };
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (!metadata.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}
