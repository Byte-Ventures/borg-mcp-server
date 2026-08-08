import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
const execute = promisify(execFile);

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  vi.doUnmock("../src/runtime-identity.js");
  vi.doUnmock("../src/runtime-lifecycle.js");
  vi.resetModules();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("controller and runtime update completion", () => {
  it("directs an older installed controller to the exact running version", async () => {
    vi.doMock("../src/runtime-identity.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../src/runtime-identity.js")>(),
      SERVER_PACKAGE_VERSION: "0.2.0",
    }));
    const { acquireRuntimeLock, inspectNodeRuntime } = await import("../src/service.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "borg-controller-update-")));
    directories.push(root);
    const dataDirectory = join(root, "data");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(dataDirectory);
    await mkdir(runtimeDirectory);
    const lock = await acquireRuntimeLock(dataDirectory, "server", {
      package_version: "0.3.0",
      artifact_integrity: `sha512-${"A".repeat(86)}==`,
      source_sha: "a".repeat(40),
      protocol_version: "8",
      started_at: "2026-07-26T12:00:00.000Z",
    }, "managed");

    try {
      const status = await inspectNodeRuntime(dataDirectory, runtimeDirectory);
      expect(status.nextAction).toEqual({
        kind: "install-controller",
        version: "0.3.0",
      });
    } finally {
      await lock.release();
    }
  });

  it("directs an older installed controller to the prepared version when stopped", async () => {
    vi.doMock("../src/runtime-identity.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../src/runtime-identity.js")>(),
      SERVER_PACKAGE_VERSION: "0.2.0",
    }));
    vi.doMock("../src/runtime-lifecycle.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../src/runtime-lifecycle.js")>(),
      inspectActiveRuntimeArtifact: vi.fn().mockResolvedValue({
        artifactDirectory: "/runtime/artifacts/candidate",
        packageDirectory: "/runtime/artifacts/candidate/package",
        version: "0.3.0",
        integrity: `sha512-${"A".repeat(86)}==`,
        sourceSha: "a".repeat(40),
        treeSha256: "b".repeat(64),
      }),
    }));
    const { inspectNodeRuntime } = await import("../src/service.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "borg-controller-prepared-")));
    directories.push(root);
    const dataDirectory = join(root, "data");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(dataDirectory);
    await mkdir(runtimeDirectory);

    const status = await inspectNodeRuntime(dataDirectory, runtimeDirectory);
    expect(status.nextAction).toEqual({
      kind: "install-controller",
      version: "0.3.0",
    });
  });

  it("keeps runtime activation as the recovery when the controller is newer", async () => {
    vi.doMock("../src/runtime-identity.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../src/runtime-identity.js")>(),
      SERVER_PACKAGE_VERSION: "0.3.0",
    }));
    const { acquireRuntimeLock, inspectNodeRuntime } = await import("../src/service.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-update-")));
    directories.push(root);
    const dataDirectory = join(root, "data");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(dataDirectory);
    await mkdir(runtimeDirectory);
    const lock = await acquireRuntimeLock(dataDirectory, "server", {
      package_version: "0.2.0",
      artifact_integrity: `sha512-${"A".repeat(86)}==`,
      source_sha: "a".repeat(40),
      protocol_version: "8",
      started_at: "2026-07-26T12:00:00.000Z",
    }, "managed");

    try {
      const status = await inspectNodeRuntime(dataDirectory, runtimeDirectory);
      expect(status.nextAction).toEqual({ kind: "update-runtime" });
    } finally {
      await lock.release();
    }
  });

  it("replaces the installed controller before a candidate-only command becomes invocable", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "borg-controller-replacement-")));
    directories.push(root);
    const previousTarball = await packControllerFixture(root, "0.2.0", false);
    const candidateTarball = await packControllerFixture(root, "0.3.0", true);
    const prefix = join(root, "prefix");
    await installController(prefix, previousTarball);
    const executable = join(prefix, "bin", "borg-mcp-server");

    await expect(execute(executable, ["sentinel"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown command."),
    });

    const { createRuntimeOperator } = await import("../src/runtime-operator.js");
    const { completeRuntimeUpdate } = await import("../src/service.js");
    const { runCli } = await import("../src/cli.js");
    const candidateBytes = await readFile(candidateTarball);
    const integrity = `sha512-${createHash("sha512").update(candidateBytes).digest("base64")}`;
    const cleanup = vi.fn(async () => undefined);
    const artifact = {
      artifactDirectory: join(root, "runtime", "artifacts", "candidate"),
      packageDirectory: join(root, "runtime", "artifacts", "candidate", "package"),
      version: "0.3.0",
      integrity,
      sourceSha: "a".repeat(40),
      treeSha256: "b".repeat(64),
    };
    const operator = createRuntimeOperator({
      runtimeRoot: join(root, "runtime"),
      artifacts: {
        latest: vi.fn(async () => ({
          tarballPath: candidateTarball,
          version: artifact.version,
          integrity,
          sourceSha: artifact.sourceSha,
          cleanup,
        })),
      },
      lifecycle: {
        stage: vi.fn(async () => artifact),
        prepare: vi.fn(async () => artifact),
        activate: vi.fn(async () => ({
          package_version: "0.3.0",
          artifact_integrity: integrity,
          source_sha: artifact.sourceSha,
          protocol_version: "8",
          started_at: "2026-07-26T12:00:00.000Z",
        })),
      },
      isRunning: vi.fn(async () => true),
    });
    const update = completeRuntimeUpdate(await operator.updateLatest(1_000), "0.2.0");
    const stdout: string[] = [];
    expect(await runCli(["update"], {
      start: vi.fn(),
      update: vi.fn(async () => update),
    }, {
      stdout: (message) => stdout.push(message),
      stderr: vi.fn(),
      isTTY: true,
    })).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("Next: npm install --global borgmcp-server@0.3.0");
    expect(cleanup).toHaveBeenCalledOnce();

    await installController(prefix, candidateTarball);
    await expect(execute(executable, ["--version"])).resolves.toMatchObject({
      stdout: "borgmcp-server@0.3.0\n",
    });
    await expect(execute(executable, ["sentinel"])).resolves.toMatchObject({
      stdout: "candidate sentinel\n",
    });
    expect(completeRuntimeUpdate(await operator.updateLatest(1_000), "0.3.0")).toMatchObject({
      controllerVersion: "0.3.0",
      artifact: { version: "0.3.0" },
      runningIdentity: { package_version: "0.3.0" },
      nextAction: null,
    });
  });
});

async function packControllerFixture(
  root: string,
  version: string,
  supportsSentinel: boolean,
): Promise<string> {
  const directory = join(root, `controller-${version}`);
  const destination = join(root, `packed-${version}`);
  await mkdir(directory);
  await mkdir(destination);
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "borgmcp-server",
    version,
    bin: { "borg-mcp-server": "./cli.js" },
  })}\n`);
  const sentinel = supportsSentinel
    ? 'if (command === "sentinel") { console.log("candidate sentinel"); process.exit(0); }\n'
    : "";
  await writeFile(join(directory, "cli.js"), [
    "#!/usr/bin/env node",
    `const version = ${JSON.stringify(version)};`,
    "const command = process.argv[2];",
    'if (command === "--version") { console.log(`borgmcp-server@${version}`); process.exit(0); }',
    sentinel.trimEnd(),
    'console.error("Unknown command.");',
    "process.exit(1);",
    "",
  ].filter((line) => line !== "").join("\n"));
  await chmod(join(directory, "cli.js"), 0o755);
  const packed = await execute("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    destination,
  ], { cwd: directory });
  const result = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
  const filename = result[0]?.filename;
  if (typeof filename !== "string") throw new Error("Fixture package did not produce a tarball.");
  return join(destination, filename);
}

async function installController(prefix: string, tarball: string): Promise<void> {
  await execute("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ]);
}
