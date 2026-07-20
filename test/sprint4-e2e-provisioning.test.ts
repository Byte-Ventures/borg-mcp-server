import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { provisionSprint4E2e } from "./sprint4-e2e-provisioning.js";

const parents: string[] = [];

afterEach(async () => {
  await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
});

describe("Sprint 4 joined E2E provisioning", () => {
  it("refuses an existing data directory before any setup or listener work", async () => {
    const parent = await mkdtemp(join(tmpdir(), "borg-s4-provision-existing-"));
    parents.push(parent);
    await expect(provisionSprint4E2e({
      testMode: true, dataDirectory: parent, host: "127.0.0.1", port: 0,
    })).rejects.toThrow("refuses an existing data directory");
  });

  it("refuses a nonnumeric loopback listener before any setup or listener work", async () => {
    const parent = await mkdtemp(join(tmpdir(), "borg-s4-provision-host-"));
    parents.push(parent);
    await expect(provisionSprint4E2e({
      testMode: true,
      dataDirectory: join(parent, "server"),
      host: "localhost" as "127.0.0.1",
      port: 0,
    })).rejects.toThrow("numeric loopback listener");
  });

  it("requires explicit test mode before any setup or listener work", async () => {
    const parent = await mkdtemp(join(tmpdir(), "borg-s4-provision-mode-"));
    parents.push(parent);
    await expect(provisionSprint4E2e({
      testMode: false as true,
      dataDirectory: join(parent, "server"),
      host: "127.0.0.1",
      port: 0,
    })).rejects.toThrow("explicit test mode");
  });

  it("uses public setup, enrollment, cube, and recovery-gated invitation flows", async () => {
    const parent = await mkdtemp(join(tmpdir(), "borg-s4-provision-real-"));
    parents.push(parent);
    const dataDirectory = join(parent, "server");
    const run = await provisionSprint4E2e({
      testMode: true, dataDirectory, host: "127.0.0.1", port: 0,
    });
    try {
      expect(run.endpoint).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/u);
      expect(run.cubeId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(new Set(Object.values(run.clientIds)).size).toBe(3);
      expect(run.trustMaterialReference).toMatch(/\/server\/ca\.crt$/u);
      for (const reference of Object.values(run.credentialReferences)) {
        expect((await stat(reference)).mode & 0o777).toBe(0o600);
        const saved = JSON.parse(await readFile(reference, "utf8")) as Record<string, unknown>;
        expect(saved).toMatchObject({ endpoint: run.endpoint, cube_id: run.cubeId });
        expect(JSON.stringify(saved)).not.toContain(run.cubeId + "not-a-secret");
      }
    } finally {
      await run.cleanup();
    }
    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes partial setup state when the owned loopback port is unavailable", async () => {
    const parent = await mkdtemp(join(tmpdir(), "borg-s4-provision-partial-"));
    parents.push(parent);
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP port.");
    const dataDirectory = join(parent, "server");
    try {
      await expect(provisionSprint4E2e({
        testMode: true, dataDirectory, host: "127.0.0.1", port: address.port,
      })).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((error) => error === undefined ? resolve() : reject(error)));
    }
    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
