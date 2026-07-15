import { chmod, copyFile, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrapServer, loadDigestKey, loadTlsPrivateKey } from "../src/bootstrap.js";
import { openStore } from "../src/store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("offline bootstrap", () => {
  it("creates private trust, identity, digest, and one-time bootstrap material", async () => {
    const parent = await temporaryDirectory();
    const result = await bootstrapServer(join(parent, "server"));

    expect(result.recoveryCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.initialInvitation).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.recoveryCredential).not.toBe(result.initialInvitation);
    expect((await stat(join(parent, "server"))).mode & 0o777).toBe(0o700);
    for (const path of Object.values(result.paths)) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    const ca = new X509Certificate(await readFile(result.paths.caCertificate));
    const server = new X509Certificate(await readFile(result.paths.serverCertificate));
    expect(ca.ca).toBe(true);
    expect(server.ca).toBe(false);
    expect(server.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(server.checkIssued(ca)).toBe(true);
    expect(result.caFingerprint).toHaveLength(64);
    const key = await loadDigestKey(result.paths.digestKey);
    expect(key).toHaveLength(32);
    key.fill(0);
    const backup = join(parent, "borg.db.backup");
    await copyFile(result.paths.database, backup);
    const generatedFiles = [
      ...(await readdir(join(parent, "server"))).map((file) => join(parent, "server", file)),
      backup,
      `${result.paths.database}-wal`,
      `${result.paths.database}-shm`,
    ];
    for (const path of generatedFiles) {
      const bytes = await readFile(path).catch(() => Buffer.alloc(0));
      expect(bytes.includes(Buffer.from(result.recoveryCredential)), path).toBe(false);
      expect(bytes.includes(Buffer.from(result.initialInvitation)), path).toBe(false);
    }
    const runtime = await openStore({ path: result.paths.database });
    expect(runtime.maintenance.observeAuthorityState()).toMatchObject({
      cubes: 0,
      roles: 0,
      grants: 0,
      enrolled_clients: 0,
    });
    runtime.close();
  });

  it("fails closed instead of replacing existing trust material", async () => {
    const parent = await temporaryDirectory();
    const dataDirectory = join(parent, "server");
    await bootstrapServer(dataDirectory);

    await expect(bootstrapServer(dataDirectory)).rejects.toThrow();
  });

  it("refuses a digest key file with group or world access", async () => {
    const parent = await temporaryDirectory();
    const result = await bootstrapServer(join(parent, "server"));
    await chmod(result.paths.digestKey, 0o644);

    await expect(loadDigestKey(result.paths.digestKey)).rejects.toThrow(
      "Credential digest key is invalid or not private.",
    );
  });

  it("refuses a group-readable TLS private key", async () => {
    const parent = await temporaryDirectory();
    const result = await bootstrapServer(join(parent, "server"));
    await chmod(result.paths.serverKey, 0o644);

    await expect(loadTlsPrivateKey(result.paths.serverKey)).rejects.toThrow(
      "TLS private key is invalid or not private.",
    );
  });

  it.each([
    ["credential digest key", "digestKey", loadDigestKey],
    ["TLS private key", "serverKey", loadTlsPrivateKey],
  ] as const)("refuses a symlinked %s", async (_label, pathName, load) => {
    const parent = await temporaryDirectory();
    const result = await bootstrapServer(join(parent, "server"));
    const link = join(parent, `${pathName}.link`);
    await symlink(result.paths[pathName], link);

    await expect(load(link)).rejects.toThrow("invalid or not private");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "borg-bootstrap-")));
  directories.push(directory);
  return directory;
}
