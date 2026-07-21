import { Socket as DatagramSocket } from "node:dgram";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapServer } from "../src/bootstrap.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("runtime egress boundary", () => {
  it("permits outbound transport only in the canonical verified registry source", async () => {
    const sourceDirectory = new URL("../src/", import.meta.url);
    const runtimeFiles = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    const sources = new Map(await Promise.all(runtimeFiles.map(async (file) => [
      file,
      await readFile(new URL(file, sourceDirectory), "utf8"),
    ] as const)));
    const registrySource = sources.get("registry-artifact.ts") ?? "";
    const otherSource = [...sources]
      .filter(([file]) => file !== "registry-artifact.ts")
      .map(([, source]) => source)
      .join("\n");

    expect(otherSource).not.toMatch(/\bfetch\s*\(/u);
    expect(otherSource).not.toMatch(/\b(?:request|connect)\s*\(/u);
    expect(registrySource).toContain('const registryOrigin = "https://registry.npmjs.org";');
    expect(registrySource).not.toMatch(/borgmcp\.ai|googleapis\.com/u);
  });

  it("confines subprocesses to runtime lifecycle and managed-service execution", async () => {
    const sourceDirectory = new URL("../src/", import.meta.url);
    const runtimeFiles = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    const sources = new Map(await Promise.all(runtimeFiles.map(async (file) => [
      file,
      await readFile(new URL(file, sourceDirectory), "utf8"),
    ] as const)));
    const runtimeSource = [...sources.values()].join("\n");
    const unauthorized = [...sources]
      .filter(([file]) => file !== "runtime-lifecycle.ts" && file !== "service.ts")
      .map(([, source]) => source)
      .join("\n");

    expect(unauthorized).not.toMatch(/node:child_process|\b(?:spawn|execFile|execSync|fork)\s*\(/u);
    expect(runtimeSource).not.toMatch(/\beval\s*\(|new Function\s*\(/u);
    expect(runtimeSource).not.toMatch(/\b(?:mdns|bonjour|zeroconf|multicast|service-discovery)\b/iu);
    expect(runtimeSource).not.toMatch(/remote[_-]?tool|tool[_-]?execution/iu);
  });

  it("performs offline bootstrap while active outbound transports are blocked", async () => {
    const tcpConnect = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("Outbound TCP blocked by test.");
    });
    const udpSend = vi.spyOn(DatagramSocket.prototype, "send").mockImplementation(() => {
      throw new Error("Outbound UDP blocked by test.");
    });
    const fetchRequest = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Outbound fetch blocked by test."),
    );
    const parent = await realpath(await mkdtemp(join(tmpdir(), "borg-no-egress-")));
    directories.push(parent);

    await bootstrapServer(join(parent, "server"));

    expect(tcpConnect).not.toHaveBeenCalled();
    expect(udpSend).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});
