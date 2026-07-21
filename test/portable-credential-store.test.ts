import { access, chmod, link, lstat, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  portableCredentialAccount,
  readPortableServerCredential,
  writePortableServerCredential,
  type PortableServerCredential,
} from "../src/portable-credential-store.js";

const roots: string[] = [];
const record: PortableServerCredential = Object.freeze({
  version: 2,
  origin: "https://127.0.0.1:7091",
  trustIdentity: `spki-sha256:${"a".repeat(64)}`,
  credential: "c".repeat(43),
  clientId: "00000000-0000-4000-8000-000000000001",
  serverCapabilities: ["create_cube"] as const,
});

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("portable parent credential store", () => {
  it("writes the exact client schema privately and preserves unrelated accounts", async () => {
    const parent = await temporaryDirectory();
    await chmod(parent, 0o755);
    const target = join(parent, "credentials");
    await writePortableServerCredential(target, record);
    expect((await lstat(parent)).mode & 0o777).toBe(0o755);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    await expect(access(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    const document = JSON.parse(await readFile(target, "utf8")) as {
      version: number;
      accounts: Record<string, string>;
    };
    const account = portableCredentialAccount(record.origin, record.trustIdentity);
    expect(document).toEqual({ version: 1, accounts: { [account]: JSON.stringify(record) } });

    const second = { ...record, credential: "d".repeat(43) } as const;
    document.accounts["unrelated-account"] = "opaque unrelated value";
    await writeFile(target, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await writePortableServerCredential(target, second);
    const updated = JSON.parse(await readFile(target, "utf8")) as typeof document;
    expect(updated.accounts["unrelated-account"]).toBe("opaque unrelated value");
    await expect(readPortableServerCredential(target, record.origin, record.trustIdentity))
      .resolves.toEqual(second);
  });

  it("rejects symlinked and non-private roots or files", async () => {
    const parent = await temporaryDirectory();
    const actual = join(parent, "actual");
    await writePortableServerCredential(actual, record);
    const link = join(parent, "link");
    await symlink(actual, link);
    await expect(readPortableServerCredential(link, record.origin, record.trustIdentity))
      .rejects.toThrow("unsafe");
    await chmod(actual, 0o644);
    await expect(readPortableServerCredential(actual, record.origin, record.trustIdentity))
      .rejects.toThrow("unsafe");
  });

  it("does not create state while reading a missing store", async () => {
    const parent = await temporaryDirectory();
    const missing = join(parent, "missing");
    await expect(readPortableServerCredential(missing, record.origin, record.trustIdentity))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a group-writable parent without rewriting its mode", async () => {
    const parent = await temporaryDirectory();
    await chmod(parent, 0o775);
    const target = join(parent, "credentials");
    await expect(writePortableServerCredential(target, record)).rejects.toThrow("unsafe");
    expect((await lstat(parent)).mode & 0o777).toBe(0o775);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a complete client-compatible hard-link lock and treats a live peer as busy", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "credentials");
    let release!: () => void;
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const acquiredGate = new Promise<void>((resolve) => { acquired = resolve; });
    const holdingWrite = writePortableServerCredential(target, record, {
      onAcquired: async (lockPath) => {
        const payload = JSON.parse(await readFile(lockPath, "utf8")) as {
          pid: number;
          startTime: string;
        };
        expect(payload.pid).toBe(process.pid);
        expect(payload.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        expect((await lstat(lockPath)).nlink).toBe(2);
        acquired();
        await releaseGate;
      },
    });
    await acquiredGate;
    await expect(writePortableServerCredential(target, record, { attempts: 4, waitMs: 5 }))
      .rejects.toThrow("Borg seat store is busy");
    release();
    await holdingWrite;
    await expect(readPortableServerCredential(target, record.origin, record.trustIdentity))
      .resolves.toEqual(record);
  });

  it("waits on a client-format live lock without stealing it or losing accounts", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "credentials");
    await writePortableServerCredential(target, record);
    const document = JSON.parse(await readFile(target, "utf8")) as {
      version: 1;
      accounts: Record<string, string>;
    };
    document.accounts["unrelated-account"] = "preserve";
    await writeFile(target, JSON.stringify(document), { mode: 0o600 });
    const lock = `${target}.lock`;
    const stage = `${lock}.${process.pid}.abcdef123456.acq`;
    const payload = JSON.stringify({ pid: process.pid, startTime: "2026-07-21T16:37:00.000Z" });
    await writeFile(stage, payload, { flag: "wx", mode: 0o600 });
    await link(stage, lock);
    await expect(writePortableServerCredential(
      target,
      { ...record, credential: "d".repeat(43) },
      { attempts: 4, waitMs: 5 },
    )).rejects.toThrow("Borg seat store is busy");
    expect(await readFile(lock, "utf8")).toBe(payload);
    expect((JSON.parse(await readFile(target, "utf8")) as typeof document).accounts["unrelated-account"])
      .toBe("preserve");
    await unlink(lock);
    await unlink(stage);
    await writePortableServerCredential(target, { ...record, credential: "d".repeat(43) });
    expect((JSON.parse(await readFile(target, "utf8")) as typeof document).accounts["unrelated-account"])
      .toBe("preserve");
  });

  it.each([
    ["dead holder", JSON.stringify({ pid: 1_073_741_824, startTime: "2020-01-01T00:00:00.000Z" })],
    ["empty holder", ""],
    ["malformed holder", "not-json-garbage"],
  ])("fails closed on a %s without reclaiming it", async (_label, payload) => {
    const parent = await temporaryDirectory();
    const target = join(parent, "credentials");
    const lock = `${target}.lock`;
    await writeFile(lock, payload, { flag: "wx", mode: 0o600 });
    await expect(writePortableServerCredential(target, record, { attempts: 2, waitMs: 0 }))
      .rejects.toThrow(lock);
    expect(await readFile(lock, "utf8")).toBe(payload);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0o644, 0o666])("rejects an unsafe %o client lock without replacing it", async (mode) => {
    const parent = await temporaryDirectory();
    const target = join(parent, "credentials");
    const lock = `${target}.lock`;
    const payload = JSON.stringify({ pid: process.pid, startTime: "2026-07-21T16:37:00.000Z" });
    await writeFile(lock, payload, { flag: "wx", mode });
    await expect(writePortableServerCredential(target, record, { attempts: 2, waitMs: 0 }))
      .rejects.toThrow("unsafe");
    expect(await readFile(lock, "utf8")).toBe(payload);
  });

  it("rejects a symlinked client lock without following or replacing it", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "credentials");
    const actual = join(parent, "actual-lock");
    const lock = `${target}.lock`;
    const payload = JSON.stringify({ pid: process.pid, startTime: "2026-07-21T16:37:00.000Z" });
    await writeFile(actual, payload, { flag: "wx", mode: 0o600 });
    await symlink(actual, lock);
    await expect(writePortableServerCredential(target, record, { attempts: 2, waitMs: 0 }))
      .rejects.toThrow("unsafe");
    expect(await readFile(actual, "utf8")).toBe(payload);
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "borg-portable-credentials-")));
  roots.push(root);
  return root;
}
