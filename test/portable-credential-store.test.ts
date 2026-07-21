import { access, chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    const root = join(parent, "credentials");
    await writePortableServerCredential(root, record);
    const target = join(root, "credentials.json");
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    const document = JSON.parse(await readFile(target, "utf8")) as {
      version: number;
      accounts: Record<string, string>;
    };
    const account = portableCredentialAccount(record.origin, record.trustIdentity);
    expect(document).toEqual({ version: 1, accounts: { [account]: JSON.stringify(record) } });

    const second = { ...record, credential: "d".repeat(43) } as const;
    document.accounts["unrelated-account"] = "opaque unrelated value";
    await writeFile(target, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await writePortableServerCredential(root, second);
    const updated = JSON.parse(await readFile(target, "utf8")) as typeof document;
    expect(updated.accounts["unrelated-account"]).toBe("opaque unrelated value");
    await expect(readPortableServerCredential(root, record.origin, record.trustIdentity))
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
    await chmod(join(actual, "credentials.json"), 0o644);
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
});

async function temporaryDirectory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "borg-portable-credentials-")));
  roots.push(root);
  return root;
}
