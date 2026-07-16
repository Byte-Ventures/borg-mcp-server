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
  it("contains no outbound network client calls or cloud endpoints", async () => {
    const sourceDirectory = new URL("../src/", import.meta.url);
    const runtimeFiles = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    const sources = await Promise.all(
      runtimeFiles.map((file) => readFile(new URL(file, sourceDirectory), "utf8")),
    );
    const runtimeSource = sources.join("\n");

    expect(runtimeSource).not.toMatch(/\bfetch\s*\(/u);
    expect(runtimeSource).not.toMatch(/\b(?:request|connect)\s*\(/u);
    expect(runtimeSource).not.toMatch(/borgmcp\.ai|googleapis\.com/u);
  });

  it("contains no discovery, remote-tool, dynamic-code, or subprocess execution surface", async () => {
    const sourceDirectory = new URL("../src/", import.meta.url);
    const runtimeFiles = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    const sources = await Promise.all(
      runtimeFiles.map((file) => readFile(new URL(file, sourceDirectory), "utf8")),
    );
    const runtimeSource = sources.join("\n");

    expect(runtimeSource).not.toMatch(/node:child_process|\b(?:spawn|execFile|execSync|fork)\s*\(/u);
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
