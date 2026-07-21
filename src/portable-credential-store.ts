import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isIP } from "node:net";

export interface PortableServerCredential {
  readonly version: 2;
  readonly origin: string;
  readonly trustIdentity: string;
  readonly credential: string;
  readonly clientId: string;
  readonly serverCapabilities: readonly ["create_cube"];
}

interface PortableCredentialDocument {
  readonly version: 1;
  readonly accounts: Readonly<Record<string, string>>;
}

const credentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const trustPattern = /^spki-sha256:[0-9a-f]{64}$/u;
const defaultLockAttempts = 500;
const defaultLockWaitMs = 10;

export interface PortableCredentialLockOptions {
  readonly attempts?: number;
  readonly waitMs?: number;
  readonly onAcquired?: (lockPath: string) => Promise<void>;
}

export function portableCredentialAccount(origin: string, trustIdentity: string): string {
  return `borg-server-credential:${createHash("sha256").update(origin).update("\0").update(trustIdentity).digest("hex")}`;
}

export async function writePortableServerCredential(
  path: string,
  record: PortableServerCredential,
  lockOptions: PortableCredentialLockOptions = {},
): Promise<void> {
  validateRecord(record);
  const target = await credentialPath(path);
  const canonicalRoot = dirname(target);
  const lock = `${target}.lock`;
  await withCredentialLock(lock, lockOptions, async () => {
    const original = await readPrivateBytesIfPresent(target);
    const document = parseDocument(original);
    const account = portableCredentialAccount(record.origin, record.trustIdentity);
    const next: PortableCredentialDocument = {
      version: 1,
      accounts: { ...document.accounts, [account]: JSON.stringify(record) },
    };
    const temporary = join(canonicalRoot, `.credentials.json.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await assertPrivateFile(temporary);
      const current = await readPrivateBytesIfPresent(target);
      if (current === null ? original !== null : original === null || !current.equals(original)) {
        throw new Error("Portable credential store changed during update.");
      }
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const directory = await open(canonicalRoot, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    await assertPrivateFile(target);
  });
}

export async function readPortableServerCredential(
  path: string,
  origin: string,
  trustIdentity: string,
): Promise<PortableServerCredential> {
  const target = await credentialPath(path);
  await assertPrivateFile(target);
  const document = parseDocument(await readPrivateBytes(target));
  const value = document.accounts[portableCredentialAccount(origin, trustIdentity)];
  if (value === undefined) throw new Error("Local owner credential is unavailable.");
  const parsed: unknown = JSON.parse(value);
  validateRecord(parsed);
  if (parsed.origin !== origin || parsed.trustIdentity !== trustIdentity) {
    throw new Error("Local owner credential binding is invalid.");
  }
  return Object.freeze(parsed);
}

async function credentialPath(path: string): Promise<string> {
  if (path !== resolve(path)) throw new Error("Portable credential path is unsafe.");
  const target = path;
  const parent = dirname(target);
  let parentMetadata;
  try {
    parentMetadata = await lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(parent, { mode: 0o700 }).catch((mkdirError: unknown) => {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    });
    parentMetadata = await lstat(parent);
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() ||
      (parentMetadata.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && parentMetadata.uid !== process.getuid()) ||
      await realpath(parent) !== parent) {
    throw new Error("Portable credential parent directory is unsafe.");
  }
  return target;
}

async function withCredentialLock<T>(
  lockPath: string,
  options: PortableCredentialLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const attempts = options.attempts ?? defaultLockAttempts;
  const waitMs = options.waitMs ?? defaultLockWaitMs;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10_000 ||
      !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 1_000) {
    throw new Error("Portable credential lock options are invalid.");
  }
  await credentialPath(lockPath.slice(0, -".lock".length));
  const stage = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.acq`;
  const payload = Buffer.from(JSON.stringify({
    pid: process.pid,
    startTime: new Date(Date.now() - Math.round(process.uptime() * 1_000)).toISOString(),
  }));
  const stageHandle = await open(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    try {
      await stageHandle.writeFile(payload);
      await stageHandle.sync();
    } finally {
      await stageHandle.close();
    }
  } catch (error) {
    await unlink(stage).catch(() => undefined);
    throw error;
  }
  let acquired = false;
  try {
    await assertPrivateFile(stage);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await link(stage, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const state = await inspectContendedLock(lockPath);
      if (state === "missing") continue;
      if (state === "stale") throw new Error(`Borg credential lock is stale: ${lockPath}`);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    if (!acquired) throw new Error("Borg seat store is busy");
    await options.onAcquired?.(lockPath);
    return await operation();
  } finally {
    let releaseError: unknown;
    if (acquired) {
      try {
        await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") releaseError = error;
      }
    }
    await unlink(stage).catch(() => undefined);
    if (releaseError !== undefined) throw releaseError;
  }
}

async function inspectContendedLock(lockPath: string): Promise<"live" | "stale" | "missing"> {
  try {
    await credentialPath(lockPath.slice(0, -".lock".length));
    const before = await lstat(lockPath);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new Error("Portable credential lock is unsafe.");
    }
    const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
          opened.size !== before.size || opened.size > 4_096) {
        throw new Error("Portable credential lock is unsafe.");
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
        throw new Error("Portable credential lock is unsafe.");
      }
    } finally {
      await handle.close();
    }
    await credentialPath(lockPath.slice(0, -".lock".length));
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return "stale"; }
    const pid = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { pid?: unknown }).pid
      : undefined;
    if (!Number.isSafeInteger(pid) || (pid as number) < 1) return "stale";
    try {
      process.kill(pid as number, 0);
      return "live";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM" ? "live" : "stale";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function assertPrivateFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 ||
      metadata.nlink !== 1 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("Portable credential file is unsafe.");
  }
  if ((await realpath(dirname(path))) !== dirname(path) || await realpath(path) !== path) {
    throw new Error("Portable credential file is unsafe.");
  }
}

async function readPrivateBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 ||
        (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
        metadata.size > 1024 * 1024) throw new Error("Portable credential file is unsafe.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readPrivateBytesIfPresent(path: string): Promise<Buffer | null> {
  try {
    await assertPrivateFile(path);
    return await readPrivateBytes(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseDocument(bytes: Buffer | null): PortableCredentialDocument {
  if (bytes === null) return { version: 1, accounts: {} };
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1) throw new Error("Portable credential store is invalid.");
  const accounts = (parsed as { accounts?: unknown }).accounts;
  if (typeof accounts !== "object" || accounts === null || Array.isArray(accounts)) {
    throw new Error("Portable credential store is invalid.");
  }
  if (Object.keys(accounts).length > 1_024) throw new Error("Portable credential store is invalid.");
  for (const [key, value] of Object.entries(accounts)) {
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(key) || typeof value !== "string" || value.length > 65_536) {
      throw new Error("Portable credential store is invalid.");
    }
  }
  return { version: 1, accounts: accounts as Record<string, string> };
}

function validateRecord(value: unknown): asserts value is PortableServerCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Portable credential is invalid.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "clientId,credential,origin,serverCapabilities,trustIdentity,version" ||
      record["version"] !== 2 || typeof record["origin"] !== "string" ||
      !isCanonicalHttpsIpOrigin(record["origin"]) ||
      typeof record["trustIdentity"] !== "string" || !trustPattern.test(record["trustIdentity"]) ||
      typeof record["credential"] !== "string" || !credentialPattern.test(record["credential"]) ||
      typeof record["clientId"] !== "string" || !uuidPattern.test(record["clientId"]) ||
      !Array.isArray(record["serverCapabilities"]) || record["serverCapabilities"].length !== 1 ||
      record["serverCapabilities"][0] !== "create_cube") {
    throw new Error("Portable credential is invalid.");
  }
}

function isCanonicalHttpsIpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    const port = Number(url.port);
    return url.protocol === "https:" && isIP(host) !== 0 && Number.isInteger(port) && port >= 1 &&
      port <= 65_535 && url.username === "" && url.password === "" && url.pathname === "/" &&
      url.search === "" && url.hash === "" && url.origin === value;
  } catch {
    return false;
  }
}
