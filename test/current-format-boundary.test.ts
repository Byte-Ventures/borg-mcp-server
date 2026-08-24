import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  managedServiceControllerMismatch,
  operatorErrors,
} from "../src/operator-error.js";
import { createRuntimeBuildIdentity } from "../src/runtime-identity.js";

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
  it("documents distinct recovery commands for install and uninstall refusals", async () => {
    const reference = await readFile(
      new URL("../docs/operator-reference.md", import.meta.url),
      "utf8",
    );
    expect(reference).toContain(operatorErrors.RUNTIME_LOCK_LIVE_UNRECOGNIZED.message);
    expect(reference).toContain(operatorErrors.MANAGED_SERVICE_DEFINITION_FOREIGN.message);
    expect(reference).toContain(operatorErrors.MANAGED_SERVICE_REGISTRATION_LEFTOVER.message);
    expect(reference).toContain(managedServiceControllerMismatch(
      "/isolated/Library/LaunchAgents/ai.borgmcp.server.plist",
      "/foreign/Library/LaunchAgents/ai.borgmcp.server.plist",
    ).message);
    expect(reference).toContain(
      "If install refuses a historical definition, stop the service with the platform\n" +
      "command below, preserve or remove the old definition manually, then rerun\n" +
      "`borg-mcp-server service install`. If uninstall refuses that definition, perform\n" +
      "the same manual cleanup, then rerun `borg-mcp-server service uninstall`. If the\n" +
      "definition is already absent but its registration remains, use the leftover\n" +
      "registration commands reported by uninstall.",
    );
    expect(reference).toContain(
      "Automated lifecycle exercises must use a fixture controller for every\n" +
      "`launchctl` and `systemctl` call. Isolating `HOME`, the data directory, and the\n" +
      "runtime root is not sufficient because controller labels are user-global. Any\n" +
      "exercise that requires the real controller is operator-run.",
    );
    const contributorGuidance = await readFile(
      new URL("../AGENTS.md", import.meta.url),
      "utf8",
    );
    expect(contributorGuidance).toContain(
      "Lifecycle tests and review harnesses must use fixture controllers for every `launchctl` and `systemctl` call.",
    );
  });

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

  it("refuses an isolated update when the fixture controller reports a foreign loaded definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "borg-controller-root-update-"));
    directories.push(root);
    const dataDirectory = join(root, "data");
    const runtimeDirectory = join(root, "runtime");
    const homeDirectory = join(root, "home");
    const binDirectory = join(root, "bin");
    const controllerLog = join(root, "controller.log");
    await Promise.all([
      mkdir(dataDirectory),
      mkdir(runtimeDirectory),
      mkdir(homeDirectory),
      mkdir(binDirectory),
    ]);
    await writeFile(join(dataDirectory, "runtime.lock"), JSON.stringify({
      pid: process.pid,
      nonce: randomUUID(),
      purpose: "server",
      mode: "managed",
      runtime_identity: createRuntimeBuildIdentity({
        startedAt: new Date("2026-08-24T00:00:00.000Z"),
      }),
    }), { mode: 0o600 });
    const launchd = process.platform === "darwin";
    const controller = launchd ? "launchctl" : "systemctl";
    const controllerPath = join(binDirectory, controller);
    const foreignPath = launchd
      ? "/Users/operator/Library/LaunchAgents/ai.borgmcp.server.plist"
      : "/home/operator/.config/systemd/user/ai.borgmcp.server.service";
    await writeFile(
      controllerPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${controllerLog}"\nprintf 'path = ${foreignPath}\\nstate = running\\nLoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=123\\nFragmentPath=${foreignPath}\\n'\n`,
      { mode: 0o700 },
    );
    await chmod(controllerPath, 0o700);
    const latest = vi.fn(async () => { throw new Error("Artifact download must not begin."); });

    vi.stubEnv("HOME", homeDirectory);
    vi.stubEnv("BORG_SERVER_DATA_DIR", dataDirectory);
    vi.stubEnv("BORG_SERVER_RUNTIME_DIR", runtimeDirectory);
    vi.stubEnv("PATH", `${binDirectory}:${process.env["PATH"] ?? ""}`);
    vi.doMock("../src/registry-artifact.js", () => ({
      createRegistryArtifactSource: () => ({ latest }),
    }));

    const expectedPath = launchd
      ? join(homeDirectory, "Library", "LaunchAgents", "ai.borgmcp.server.plist")
      : join(homeDirectory, ".config", "systemd", "user", "ai.borgmcp.server.service");
    const { nodeServerService } = await import("../src/service.js");
    await expect(nodeServerService.update!()).rejects.toThrow(
      managedServiceControllerMismatch(expectedPath, foreignPath).message,
    );
    expect(latest).not.toHaveBeenCalled();
    expect((await readFile(controllerLog, "utf8")).trim()).toBe(
      launchd
        ? `print gui/${process.getuid?.() ?? 0}/ai.borgmcp.server`
        : "--user show ai.borgmcp.server --property=LoadState,ActiveState,SubState,MainPID,FragmentPath",
    );
  });
});
