import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  vi.doUnmock("../src/registry-artifact.js");
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("current lifecycle format boundary", () => {
  it("refuses update through an incomplete historical runtime lock before external work", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-current-format-update-"));
    directories.push(root);
    const dataDirectory = join(root, "data");
    const runtimeDirectory = join(root, "runtime");
    const binDirectory = join(root, "bin");
    const controllerProbe = join(root, "controller-probed");
    await Promise.all([
      mkdir(dataDirectory),
      mkdir(runtimeDirectory),
      mkdir(binDirectory),
    ]);
    await writeFile(join(dataDirectory, "runtime.lock"), JSON.stringify({
      pid: process.pid,
      nonce: randomUUID(),
      purpose: "server",
      endpoint: "https://127.0.0.1:7091",
    }), { mode: 0o600 });
    const controller = process.platform === "darwin" ? "launchctl" : "systemctl";
    const controllerPath = join(binDirectory, controller);
    await writeFile(
      controllerPath,
      `#!/bin/sh\ntouch "${controllerProbe}"\nprintf 'state = running\\nLoadState=loaded\\nActiveState=active\\n'\n`,
      { mode: 0o700 },
    );
    await chmod(controllerPath, 0o700);

    vi.stubEnv("BORG_SERVER_DATA_DIR", dataDirectory);
    vi.stubEnv("BORG_SERVER_RUNTIME_DIR", runtimeDirectory);
    vi.stubEnv("PATH", `${binDirectory}:${process.env["PATH"] ?? ""}`);
    vi.doMock("../src/registry-artifact.js", () => ({
      createRegistryArtifactSource: () => ({
        latest: async () => { throw new Error("Artifact download must not begin."); },
      }),
    }));

    const { nodeServerService } = await import("../src/service.js");
    await expect(nodeServerService.update!()).rejects.toThrow(
      "A live process owns an obsolete or invalid runtime.lock. Stop that process through its original terminal or service manager. After it exits, remove runtime.lock and retry.",
    );
    await expect(access(controllerProbe)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
