import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import { operatorErrors } from "./operator-error.js";

export const RUNTIME_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const RUNTIME_LOG_GENERATIONS = 3;
export const RUNTIME_LOG_FILE_NAME = "runtime.log";
export const RUNTIME_LOG_MAX_QUEUED_RECORDS = 1_024;
export const RUNTIME_LOG_MAX_QUEUED_BYTES = 1024 * 1024;
export const RUNTIME_LOG_CLOSE_TIMEOUT_MS = 1_000;
export const RUNTIME_LOG_RETRY_BACKOFF_MS = 1_000;
export const RUNTIME_LOG_OVERFLOW_MESSAGE =
  "RUNTIME_LOG_OVERFLOW: runtime telemetry records were dropped.";
export const RUNTIME_LOG_FAILURE_MESSAGE =
  "RUNTIME_LOG_WRITE_FAILED: runtime telemetry is unavailable; retrying.";
export const RUNTIME_LOG_STARTUP_FAILURE_MESSAGE =
  "RUNTIME_LOG_START_FAILED: runtime telemetry is disabled; repair the private log directory and restart.";
export const RUNTIME_LOG_CLOSE_TIMEOUT_MESSAGE =
  "RUNTIME_LOG_CLOSE_TIMEOUT: pending runtime telemetry was abandoned.";
export const RUNTIME_LOG_UNSAFE_MESSAGE =
  "RUNTIME_LOG_UNSAFE: runtime telemetry is disabled; repair the private log files and restart.";

export interface RuntimeLogSinkState {
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly droppedRecords: number;
}

export interface RuntimeLogSink {
  readonly write: (line: string) => void;
  readonly close: () => Promise<void>;
  readonly inspect: () => RuntimeLogSinkState;
}

export async function openRuntimeLogSink(
  dataDirectory: string,
  options: {
    readonly maxBytes?: number;
    readonly uid?: number;
    readonly maxQueuedRecords?: number;
    readonly maxQueuedBytes?: number;
    readonly closeTimeoutMs?: number;
    readonly retryBackoffMs?: number;
    readonly reportFailure?: (line: string) => void;
    readonly writeRecord?: (handle: FileHandle, record: Buffer) => Promise<void>;
    readonly clock?: () => number;
    readonly delay?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<RuntimeLogSink> {
  const maxBytes = options.maxBytes ?? RUNTIME_LOG_MAX_BYTES;
  const maxQueuedRecords = options.maxQueuedRecords ?? RUNTIME_LOG_MAX_QUEUED_RECORDS;
  const maxQueuedBytes = options.maxQueuedBytes ?? RUNTIME_LOG_MAX_QUEUED_BYTES;
  const closeTimeoutMs = options.closeTimeoutMs ?? RUNTIME_LOG_CLOSE_TIMEOUT_MS;
  const retryBackoffMs = options.retryBackoffMs ?? RUNTIME_LOG_RETRY_BACKOFF_MS;
  for (const [name, value, minimum] of [
    ["byte limit", maxBytes, 1],
    ["record queue limit", maxQueuedRecords, 1],
    ["byte queue limit", maxQueuedBytes, 1],
    ["close timeout", closeTimeoutMs, 0],
    ["retry backoff", retryBackoffMs, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`Runtime log ${name} is invalid.`);
    }
  }
  const writeRecord = options.writeRecord ?? ((handle: FileHandle, record: Buffer) => handle.writeFile(record));
  const clock = options.clock ?? Date.now;
  const delay = options.delay ?? ((milliseconds: number) => (
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds))
  ));
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

  let handle: FileHandle | undefined = await openCurrentLog(paths[0]!, uid);
  let size = (await handle.stat()).size;
  let accepting = true;
  let abandoned = false;
  let activeBytes = 0;
  let queuedBytes = 0;
  let totalDroppedRecords = 0;
  let droppedSinceSuccess = 0;
  let failuresSinceSuccess = 0;
  let overflowReported = false;
  let failureReported = false;
  let unsafeReported = false;
  let retryAt = 0;
  let drainPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const queue: Array<{ readonly line: string; readonly bytes: number }> = [];

  const report = (line: string): void => {
    try {
      options.reportFailure?.(line);
    } catch {
      // Runtime diagnostics cannot alter server behavior.
    }
  };

  const recordOverflow = (): void => {
    totalDroppedRecords = incrementCounter(totalDroppedRecords);
    droppedSinceSuccess = incrementCounter(droppedSinceSuccess);
    if (!overflowReported) {
      overflowReported = true;
      report(RUNTIME_LOG_OVERFLOW_MESSAGE);
    }
  };

  const recordFailure = (droppedRecord: boolean): void => {
    if (droppedRecord) {
      totalDroppedRecords = incrementCounter(totalDroppedRecords);
      droppedSinceSuccess = incrementCounter(droppedSinceSuccess);
    }
    failuresSinceSuccess = incrementCounter(failuresSinceSuccess);
    if (!failureReported) {
      failureReported = true;
      report(RUNTIME_LOG_FAILURE_MESSAGE);
    }
  };

  const disableUnsafeSink = (): void => {
    abandoned = true;
    accepting = false;
    queue.length = 0;
    queuedBytes = 0;
    if (!unsafeReported) {
      unsafeReported = true;
      report(RUNTIME_LOG_UNSAFE_MESSAGE);
    }
    const currentHandle = handle;
    handle = undefined;
    void currentHandle?.close().catch(() => undefined);
  };

  const rotate = async (): Promise<void> => {
    for (const path of paths) await assertSafeExistingLog(path, uid);
    const currentHandle = handle;
    if (currentHandle === undefined) throw new Error("Runtime log is unavailable.");
    handle = undefined;
    await currentHandle.close();
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

  const reopen = async (): Promise<void> => {
    const wait = Math.max(0, retryAt - clock());
    if (wait > 0) await delay(wait);
    if (abandoned) return;
    for (const path of paths) await assertSafeExistingLog(path, uid);
    handle = await openCurrentLog(paths[0]!, uid);
    size = (await handle.stat()).size;
  };

  const drain = async (): Promise<void> => {
    while (!abandoned && queue.length > 0) {
      if (handle === undefined) {
        try {
          await reopen();
        } catch (error) {
          if (error === operatorErrors.RUNTIME_LOG_UNSAFE) {
            disableUnsafeSink();
            return;
          }
          retryAt = clock() + retryBackoffMs;
          recordFailure(false);
          continue;
        }
      }
      if (abandoned || handle === undefined) return;
      const queued = queue.shift()!;
      queuedBytes -= queued.bytes;
      activeBytes = queued.bytes;
      let projected = projectSinkCounters(queued.line, droppedSinceSuccess, failuresSinceSuccess);
      let record = Buffer.from(`${projected.line}\n`, "utf8");
      if (record.byteLength > maxBytes) {
        projected = { line: queued.line, droppedRecords: 0, writeFailures: 0 };
        record = Buffer.from(`${queued.line}\n`, "utf8");
      }
      try {
        if (size + record.byteLength > maxBytes) await rotate();
        if (handle === undefined) throw new Error("Runtime log is unavailable.");
        await writeRecord(handle, record);
        size += record.byteLength;
        droppedSinceSuccess -= projected.droppedRecords;
        failuresSinceSuccess -= projected.writeFailures;
        if (droppedSinceSuccess === 0) overflowReported = false;
        if (failuresSinceSuccess === 0) failureReported = false;
      } catch (error) {
        const failedHandle = handle;
        handle = undefined;
        void failedHandle?.close().catch(() => undefined);
        if (error === operatorErrors.RUNTIME_LOG_UNSAFE) {
          disableUnsafeSink();
          return;
        }
        retryAt = clock() + retryBackoffMs;
        recordFailure(true);
      } finally {
        activeBytes = 0;
      }
    }
  };

  const startDrain = (): void => {
    if (drainPromise !== undefined || abandoned || queue.length === 0) return;
    const running = drain();
    drainPromise = running.finally(() => {
      drainPromise = undefined;
      if (!abandoned && queue.length > 0) startDrain();
    });
  };

  return Object.freeze({
    write(line: string): void {
      if (!accepting) return;
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      const queuedRecords = queue.length + (activeBytes === 0 ? 0 : 1);
      if (bytes > maxBytes || bytes > maxQueuedBytes || queuedRecords >= maxQueuedRecords ||
          queuedBytes + activeBytes + bytes > maxQueuedBytes) {
        // Preserve accepted-record ordering and drop the newest record at either queue bound.
        recordOverflow();
        return;
      }
      queue.push({ line, bytes });
      queuedBytes += bytes;
      startDrain();
    },
    async close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      accepting = false;
      const closing = (async () => {
        while (queue.length > 0 || drainPromise !== undefined) {
          startDrain();
          await drainPromise;
        }
        const currentHandle = handle;
        handle = undefined;
        await currentHandle?.close().catch(() => undefined);
      })();
      closePromise = (async () => {
        if (await settlesWithin(closing, closeTimeoutMs)) return;
        abandoned = true;
        queue.length = 0;
        queuedBytes = 0;
        report(RUNTIME_LOG_CLOSE_TIMEOUT_MESSAGE);
        const currentHandle = handle;
        handle = undefined;
        void currentHandle?.close().catch(() => undefined);
      })();
      return closePromise;
    },
    inspect(): RuntimeLogSinkState {
      return Object.freeze({
        queuedRecords: queue.length + (activeBytes === 0 ? 0 : 1),
        queuedBytes: queuedBytes + activeBytes,
        droppedRecords: totalDroppedRecords,
      });
    },
  });
}

function projectSinkCounters(
  line: string,
  droppedRecords: number,
  writeFailures: number,
): { readonly line: string; readonly droppedRecords: number; readonly writeFailures: number } {
  if (droppedRecords === 0 && writeFailures === 0) return { line, droppedRecords: 0, writeFailures: 0 };
  try {
    const record = JSON.parse(line) as unknown;
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return { line, droppedRecords: 0, writeFailures: 0 };
    }
    return {
      line: JSON.stringify({
        ...record,
        runtime_log_dropped_records: droppedRecords,
        runtime_log_write_failures: writeFailures,
      }),
      droppedRecords,
      writeFailures,
    };
  } catch {
    return { line, droppedRecords: 0, writeFailures: 0 };
  }
}

function incrementCounter(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  const settled = promise.then(() => true, () => true);
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
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
