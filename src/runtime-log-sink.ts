import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import { operatorErrors } from "./operator-error.js";

export const RUNTIME_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const RUNTIME_LOG_GENERATIONS = 3;
export const RUNTIME_LOG_FILE_NAME = "runtime.log";

export interface RuntimeLogSink {
  readonly write: (line: string) => void;
  readonly close: () => Promise<void>;
}

export async function openRuntimeLogSink(
  dataDirectory: string,
  options: { readonly maxBytes?: number; readonly uid?: number } = {},
): Promise<RuntimeLogSink> {
  const maxBytes = options.maxBytes ?? RUNTIME_LOG_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Runtime log byte limit is invalid.");
  }
  const uid = options.uid ?? process.getuid?.();
  const logDirectory = join(dataDirectory, "logs");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(logDirectory);
  if (await realpath(logDirectory) !== resolve(logDirectory) ||
      !directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
      (uid !== undefined && directoryMetadata.uid !== uid)) {
    throw operatorErrors.RUNTIME_LOG_UNSAFE;
  }
  await chmod(logDirectory, 0o700);

  const paths = Array.from({ length: RUNTIME_LOG_GENERATIONS }, (_, index) => (
    join(logDirectory, index === 0 ? RUNTIME_LOG_FILE_NAME : `${RUNTIME_LOG_FILE_NAME}.${index}`)
  ));
  for (const path of paths) await assertSafeExistingLog(path, uid);

  let handle = await openCurrentLog(paths[0]!, uid);
  let size = (await handle.stat()).size;
  let accepting = true;
  let failed = false;
  let queue = Promise.resolve();

  const rotate = async (): Promise<void> => {
    for (const path of paths) await assertSafeExistingLog(path, uid);
    await handle.close();
    const oldest = paths.at(-1)!;
    await unlink(oldest).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    for (let index = paths.length - 1; index > 0; index -= 1) {
      await rename(paths[index - 1]!, paths[index]!).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    handle = await openCurrentLog(paths[0]!, uid);
    size = 0;
  };

  return Object.freeze({
    write(line: string): void {
      if (!accepting || failed) return;
      const record = Buffer.from(`${line}\n`, "utf8");
      if (record.byteLength > maxBytes) return;
      queue = queue.then(async () => {
        if (failed) return;
        try {
          if (size + record.byteLength > maxBytes) await rotate();
          await handle.writeFile(record);
          size += record.byteLength;
        } catch {
          failed = true;
          await handle.close().catch(() => undefined);
        }
      });
    },
    async close(): Promise<void> {
      accepting = false;
      await queue;
      if (!failed) await handle.close().catch(() => undefined);
    },
  });
}

async function openCurrentLog(path: string, uid: number | undefined): Promise<FileHandle> {
  const handle = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = await handle.stat();
    if (!safeLogMetadata(metadata, uid)) throw operatorErrors.RUNTIME_LOG_UNSAFE;
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertSafeExistingLog(path: string, uid: number | undefined): Promise<void> {
  try {
    if (!safeLogMetadata(await lstat(path), uid)) throw operatorErrors.RUNTIME_LOG_UNSAFE;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function safeLogMetadata(metadata: Stats, uid: number | undefined): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 &&
    (metadata.mode & 0o077) === 0 && (uid === undefined || metadata.uid === uid);
}
