import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertTrustIdentityContract,
  closeSprint4Server,
  getSprint4Status,
  provisionSprint4E2e,
  SPRINT4_TRANSPORT_TIMEOUT_MS,
} from "./sprint4-e2e-provisioning.js";

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
      expect(new Set(Object.values(run.seats).map((seat) => seat.droneId)).size).toBe(3);
      expect(run.trustMaterialReference).toMatch(/\/server\/ca\.crt$/u);
      expect(run.trustIdentity).toMatch(/^[0-9a-f]{64}$/u);
      const setupConfig = JSON.parse(await readFile(join(dataDirectory, "server.json"), "utf8")) as {
        ca_spki_sha256: string;
      };
      expect(run.trustIdentity).toBe(setupConfig.ca_spki_sha256);
      for (const [identity, reference] of Object.entries(run.credentialReferences)) {
        expect((await stat(reference)).mode & 0o777).toBe(0o600);
        const saved = JSON.parse(await readFile(reference, "utf8")) as Record<string, unknown>;
        const seat = run.seats[identity as keyof typeof run.seats];
        expect(saved).toMatchObject({
          endpoint: run.endpoint,
          cube_id: run.cubeId,
          trust_identity: run.trustIdentity,
          role_id: seat.roleId,
          drone_id: seat.droneId,
          session_id: seat.sessionId,
        });
        expect(saved["session_credential"]).toEqual(expect.any(String));
        expect(saved["client_credential"]).toEqual(expect.any(String));
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

  it("bounds a stalled TLS transport and a stalled server close", async () => {
    const stalled = createServer((socket) => socket.on("data", () => undefined));
    await listen(stalled);
    const address = stalled.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP port.");
    const startedAt = Date.now();
    try {
      await expect(getSprint4Status(
        `https://127.0.0.1:${address.port}`,
        Buffer.alloc(0),
        "/stalled",
        "credential-is-not-sent-to-any-log",
      )).rejects.toThrow("HTTPS GET timed out");
      expect(Date.now() - startedAt).toBeLessThan(SPRINT4_TRANSPORT_TIMEOUT_MS + 500);
      await expect(closeSprint4Server({
        origin: "https://127.0.0.1:1",
        limits: {} as never,
        close: async () => await new Promise<void>(() => undefined),
      })).rejects.toThrow("HTTPS server close timed out");
    } finally {
      await closeServer(stalled);
    }
  });

  it("rejects a missing or mismatched emitted trust identity before handoff", () => {
    const identity = "a".repeat(64);
    expect(() => assertTrustIdentityContract(identity, undefined))
      .toThrow("trust identity mismatch");
    expect(() => assertTrustIdentityContract(identity, "b".repeat(64)))
      .toThrow("trust identity mismatch");
    expect(() => assertTrustIdentityContract(identity, identity)).not.toThrow();
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
