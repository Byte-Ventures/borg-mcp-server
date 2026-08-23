import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { operatorErrors } from "../src/operator-error.js";
import { createRuntimeLogger } from "../src/runtime-log.js";
import {
  openRuntimeLogSink,
  RUNTIME_LOG_CLOSE_TIMEOUT_MESSAGE,
  RUNTIME_LOG_FAILURE_MESSAGE,
  RUNTIME_LOG_FILE_NAME,
  RUNTIME_LOG_OVERFLOW_MESSAGE,
  RUNTIME_LOG_UNSAFE_MESSAGE,
} from "../src/runtime-log-sink.js";

describe("runtime log sink", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("rotates ordered lines across exactly three bounded files and resumes after restart", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-log-")));
    const line = (event: string): string => JSON.stringify({ event });
    const lines = (events: readonly string[]): string => `${events.map(line).join("\n")}\n`;
    let sink = await openRuntimeLogSink(directory, { maxBytes: 56 });
    for (const event of ["a", "b", "c", "d", "e"]) sink.write(line(event));
    await sink.close();

    sink = await openRuntimeLogSink(directory, { maxBytes: 56 });
    for (const event of ["f", "g", "h", "i", "j", "k", "l", "m"]) sink.write(line(event));
    await sink.close();

    const logDirectory = join(directory, "logs");
    expect((await readdir(logDirectory)).sort()).toEqual([
      RUNTIME_LOG_FILE_NAME,
      `${RUNTIME_LOG_FILE_NAME}.1`,
      `${RUNTIME_LOG_FILE_NAME}.2`,
    ]);
    expect(await readFile(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.2`), "utf8"))
      .toBe(lines(["e", "f", "g", "h"]));
    expect(await readFile(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.1`), "utf8"))
      .toBe(lines(["i", "j", "k", "l"]));
    expect(await readFile(join(logDirectory, RUNTIME_LOG_FILE_NAME), "utf8"))
      .toBe(lines(["m"]));
    for (const name of await readdir(logDirectory)) {
      const metadata = await lstat(join(logDirectory, name));
      expect(metadata.size).toBeLessThanOrEqual(56);
      expect(metadata.mode & 0o077).toBe(0);
    }
    expect((await lstat(logDirectory)).mode & 0o077).toBe(0);
  });

  it.each(["mid-stream", "final"] as const)(
    "keeps generations parseable when rotation rename fails on a %s record",
    async (position) => {
      directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-rename-failure-")));
      const reports: string[] = [];
      let renameCount = 0;
      const first = JSON.stringify({ event: "one" });
      let sink = await openRuntimeLogSink(directory, {
        maxBytes: Buffer.byteLength(`${first}\n`),
        retryBackoffMs: 0,
        reportFailure: (line) => reports.push(line),
        renamePath: async (from, to) => {
          renameCount += 1;
          if (renameCount === 1) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
          await rename(from, to);
        },
      });
      sink.write(first);
      sink.write(JSON.stringify({ event: "two" }));
      await vi.waitFor(() => expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE]));
      if (position === "mid-stream") sink.write(JSON.stringify({ event: "tri" }));
      await sink.close();

      sink = await openRuntimeLogSink(directory);
      sink.write(JSON.stringify({ event: "end" }));
      await sink.close();
      expect(await readRuntimeEvents(directory)).toEqual([
        "one",
        ...(position === "mid-stream" ? ["tri"] : []),
        "end",
      ]);
    },
  );

  it("recovers when rotation fails after moving an older generation", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-partial-rotation-")));
    const first = JSON.stringify({ event: "one" });
    const maxBytes = Buffer.byteLength(`${first}\n`);
    let sink = await openRuntimeLogSink(directory, { maxBytes });
    sink.write(first);
    sink.write(JSON.stringify({ event: "two" }));
    await sink.close();

    let renameCount = 0;
    const reports: string[] = [];
    sink = await openRuntimeLogSink(directory, {
      maxBytes,
      retryBackoffMs: 0,
      reportFailure: (line) => reports.push(line),
      renamePath: async (from, to) => {
        renameCount += 1;
        if (renameCount === 2) throw Object.assign(new Error("injected second rename failure"), { code: "EIO" });
        await rename(from, to);
      },
    });
    sink.write(JSON.stringify({ event: "bad" }));
    await vi.waitFor(() => expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE]));
    sink.write(JSON.stringify({ event: "for" }));
    await sink.close();

    expect(await readRuntimeEvents(directory)).toEqual(["two", "for"]);
  });

  it("abandons a hung rotation without continuing filesystem work after the close deadline", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-hung-rotation-")));
    const first = JSON.stringify({ event: "one" });
    let releaseRename: (() => void) | undefined;
    const blockedRename = new Promise<void>((resolveRename) => {
      releaseRename = resolveRename;
    });
    let renameCount = 0;
    const reports: string[] = [];
    const sink = await openRuntimeLogSink(directory, {
      maxBytes: Buffer.byteLength(`${first}\n`),
      closeTimeoutMs: 20,
      reportFailure: (line) => reports.push(line),
      renamePath: () => {
        renameCount += 1;
        return blockedRename;
      },
    });
    sink.write(first);
    sink.write(JSON.stringify({ event: "two" }));
    await vi.waitFor(() => expect(renameCount).toBe(1));
    const startedAt = performance.now();
    await sink.close();
    expect(performance.now() - startedAt).toBeLessThan(200);
    releaseRename?.();
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));

    expect(renameCount).toBe(1);
    expect(reports).toEqual([RUNTIME_LOG_CLOSE_TIMEOUT_MESSAGE]);
    expect(await readRuntimeEvents(directory)).toEqual(["one"]);
  });

  it("starts from a safely validated partial rotation with no current file", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-startup-rotation-")));
    const sink = await openRuntimeLogSink(directory);
    sink.write(JSON.stringify({ event: "older" }));
    await sink.close();
    const logs = join(directory, "logs");
    await rename(
      join(logs, RUNTIME_LOG_FILE_NAME),
      join(logs, `${RUNTIME_LOG_FILE_NAME}.1`),
    );

    const restarted = await openRuntimeLogSink(directory);
    restarted.write(JSON.stringify({ event: "newer" }));
    await restarted.close();

    expect(await readRuntimeEvents(directory)).toEqual(["older", "newer"]);
  });

  it("retains slow request and liveness records across a forced rotation", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-slow-log-")));
    const sink = await openRuntimeLogSink(directory, { maxBytes: 256 });
    const logger = createRuntimeLogger(sink.write, () => new Date("2026-08-23T12:00:00.000Z"));
    logger.emit({
      event: "slow_request",
      method: "GET",
      path: "/api/cubes",
      status: 200,
      elapsedMs: 1_500,
    });
    logger.emit({
      event: "slow_liveness_scan",
      elapsedMs: 1_200,
      candidateCount: 12,
      outcome: "success",
    });
    await sink.close();

    const logs = join(directory, "logs");
    const records = [
      await readFile(join(logs, `${RUNTIME_LOG_FILE_NAME}.1`), "utf8"),
      await readFile(join(logs, RUNTIME_LOG_FILE_NAME), "utf8"),
    ].join("").trim().split("\n").map((line) => JSON.parse(line) as { event: string });
    expect(records.map((record) => record.event)).toEqual(["slow_request", "slow_liveness_scan"]);
  });

  it("bounds queued records and bytes and abandons a hung write within the close deadline", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-hung-log-")));
    let releaseWrite: (() => void) | undefined;
    const blockedWrite = new Promise<void>((resolveWrite) => {
      releaseWrite = resolveWrite;
    });
    const reports: string[] = [];
    const sink = await openRuntimeLogSink(directory, {
      maxQueuedRecords: 3,
      maxQueuedBytes: 96,
      reservedSlowRecords: 0,
      reservedSlowBytes: 0,
      closeTimeoutMs: 20,
      reportFailure: (line) => reports.push(line),
      writeRecord: () => blockedWrite,
    });
    for (let index = 0; index < 10; index += 1) {
      sink.write(JSON.stringify({ event: "request", index }));
    }
    await vi.waitFor(() => expect(sink.inspect().queuedRecords).toBe(3));

    expect(sink.inspect()).toMatchObject({
      queuedRecords: 3,
      droppedRecords: 7,
    });
    expect(sink.inspect().queuedBytes).toBeLessThanOrEqual(96);
    const startedAt = performance.now();
    await sink.close();
    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(reports).toEqual([RUNTIME_LOG_OVERFLOW_MESSAGE, RUNTIME_LOG_CLOSE_TIMEOUT_MESSAGE]);
    releaseWrite?.();
  });

  it("reports overflow once and carries the dropped count in the next successful record", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-overflow-log-")));
    let releaseWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolveWrite) => {
      releaseWrite = resolveWrite;
    });
    let writeCount = 0;
    const reports: string[] = [];
    const sink = await openRuntimeLogSink(directory, {
      maxQueuedRecords: 2,
      reservedSlowRecords: 0,
      reservedSlowBytes: 0,
      reportFailure: (line) => reports.push(line),
      writeRecord: async (handle, record) => {
        writeCount += 1;
        if (writeCount === 1) await firstWrite;
        await handle.writeFile(record);
      },
    });
    sink.write(JSON.stringify({ event: "first" }));
    sink.write(JSON.stringify({ event: "second" }));
    sink.write(JSON.stringify({ event: "dropped-a" }));
    sink.write(JSON.stringify({ event: "dropped-b" }));
    releaseWrite?.();
    await sink.close();

    const records = (await readFile(join(directory, "logs", RUNTIME_LOG_FILE_NAME), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      { event: "first" },
      { event: "second", runtime_log_dropped_records: 2, runtime_log_write_failures: 0 },
    ]);
    expect(reports).toEqual([RUNTIME_LOG_OVERFLOW_MESSAGE]);
  });

  it("repairs a partial write, reopens, and carries failed and dropped counts", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-retry-log-")));
    const reports: string[] = [];
    let writeCount = 0;
    const sink = await openRuntimeLogSink(directory, {
      retryBackoffMs: 0,
      reportFailure: (line) => reports.push(line),
      writeRecord: async (handle, record) => {
        writeCount += 1;
        if (writeCount === 2) {
          await handle.writeFile(record.subarray(0, 6));
          throw new Error("injected partial write failure");
        }
        await handle.writeFile(record);
      },
    });
    sink.write(JSON.stringify({ event: "before" }));
    sink.write(JSON.stringify({ event: "failed" }));
    await vi.waitFor(() => expect(writeCount).toBe(2));
    sink.write(JSON.stringify({ event: "recovered" }));
    await sink.close();

    const records = (await readFile(join(directory, "logs", RUNTIME_LOG_FILE_NAME), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      { event: "before" },
      {
        event: "recovered",
        runtime_log_dropped_records: 1,
        runtime_log_write_failures: 1,
      },
    ]);
    expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE]);
  });

  it("repairs a final partial write before close so the next process appends valid JSONL", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-close-repair-")));
    const reports: string[] = [];
    let writeCount = 0;
    let sink = await openRuntimeLogSink(directory, {
      reportFailure: (line) => reports.push(line),
      writeRecord: async (handle, record) => {
        writeCount += 1;
        if (writeCount === 2) {
          await handle.writeFile(record.subarray(0, 6));
          throw new Error("injected final partial write failure");
        }
        await handle.writeFile(record);
      },
    });
    sink.write(JSON.stringify({ event: "before" }));
    sink.write(JSON.stringify({ event: "failed-final" }));
    await vi.waitFor(() => expect(writeCount).toBe(2));
    await sink.close();

    sink = await openRuntimeLogSink(directory);
    sink.write(JSON.stringify({ event: "after-restart" }));
    await sink.close();

    const records = (await readFile(join(directory, "logs", RUNTIME_LOG_FILE_NAME), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([{ event: "before" }, { event: "after-restart" }]);
    expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE]);
  });

  it.each(["mid-stream", "final"] as const)(
    "keeps JSONL parseable when a zero-byte write rejection is %s",
    async (position) => {
      directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-zero-reject-")));
      const reports: string[] = [];
      let writeCount = 0;
      let sink = await openRuntimeLogSink(directory, {
        retryBackoffMs: 0,
        reportFailure: (line) => reports.push(line),
        writeRecord: async (handle, record) => {
          writeCount += 1;
          if (writeCount === 2) throw new Error("injected zero-byte failure");
          await handle.writeFile(record);
        },
      });
      sink.write(JSON.stringify({ event: "before" }));
      sink.write(JSON.stringify({ event: "failed" }));
      await vi.waitFor(() => expect(writeCount).toBe(2));
      if (position === "mid-stream") sink.write(JSON.stringify({ event: "after" }));
      await sink.close();

      sink = await openRuntimeLogSink(directory);
      sink.write(JSON.stringify({ event: "after-restart" }));
      await sink.close();
      expect(await readRuntimeEvents(directory)).toEqual([
        "before",
        ...(position === "mid-stream" ? ["after"] : []),
        "after-restart",
      ]);
      expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE]);
    },
  );

  it("repairs a crash-style partial tail once at next-process startup", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-startup-tail-")));
    const sink = await openRuntimeLogSink(directory);
    await sink.close();
    const current = join(directory, "logs", RUNTIME_LOG_FILE_NAME);
    await writeFile(current, `${JSON.stringify({ event: "before" })}\n{\"even`, { mode: 0o600 });
    let truncateCount = 0;
    const reopened = await openRuntimeLogSink(directory, {
      truncateFile: async (handle, size) => {
        truncateCount += 1;
        await handle.truncate(size);
      },
    });
    reopened.write(JSON.stringify({ event: "after" }));
    await reopened.close();

    expect(truncateCount).toBe(1);
    expect(await readRuntimeEvents(directory)).toEqual(["before", "after"]);
  });

  it("fails closed without polling when startup tail repair rejects", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-startup-repair-failure-")));
    const sink = await openRuntimeLogSink(directory);
    await sink.close();
    const current = join(directory, "logs", RUNTIME_LOG_FILE_NAME);
    await writeFile(current, `${JSON.stringify({ event: "before" })}\n{`, { mode: 0o600 });
    const truncateFile = vi.fn().mockRejectedValue(new Error("injected truncate failure"));

    await expect(openRuntimeLogSink(directory, { truncateFile })).rejects.toThrow(
      "injected truncate failure",
    );
    expect(truncateFile).toHaveBeenCalledOnce();
    expect(await readFile(current, "utf8")).toContain("\n{");
  });

  it.each(["symlink", "permissions", "foreign owner"] as const)(
    "abandons pending repair without a hot loop when reopen becomes unsafe by %s",
    async (unsafeKind) => {
      directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-abandon-repair-")));
      const reports: string[] = [];
      const logs = join(directory, "logs");
      const current = join(logs, RUNTIME_LOG_FILE_NAME);
      const outside = join(directory, "outside.log");
      await writeFile(outside, `${JSON.stringify({ event: "outside" })}\n`, { mode: 0o600 });
      let writeCount = 0;
      let foreignOwner = false;
      const uid = process.getuid?.();
      const truncateFile = vi.fn().mockRejectedValue(new Error("injected truncate failure"));
      const sink = await openRuntimeLogSink(directory, {
        closeTimeoutMs: 20,
        retryBackoffMs: 0,
        reportFailure: (line) => reports.push(line),
        truncateFile,
        uidProvider: () => foreignOwner && uid !== undefined ? uid + 1 : uid,
        writeRecord: async (handle, record) => {
          writeCount += 1;
          if (writeCount === 2) {
            await handle.writeFile(record.subarray(0, 6));
            if (unsafeKind === "symlink") {
              await unlink(current);
              await symlink(outside, current);
            } else {
              if (unsafeKind === "permissions") await chmod(current, 0o644);
              else foreignOwner = true;
            }
            throw new Error("injected partial write failure");
          }
          await handle.writeFile(record);
        },
      });
      sink.write(JSON.stringify({ event: "before" }));
      sink.write(JSON.stringify({ event: "failed" }));
      await vi.waitFor(() => expect(reports).toContain(RUNTIME_LOG_UNSAFE_MESSAGE));
      sink.write(JSON.stringify({ event: "ignored-after-disable" }));
      const startedAt = performance.now();
      await sink.close();
      expect(performance.now() - startedAt).toBeLessThan(200);
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));

      expect(truncateFile).toHaveBeenCalledOnce();
      expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE, RUNTIME_LOG_UNSAFE_MESSAGE]);
      expect(await readFile(outside, "utf8")).toBe(`${JSON.stringify({ event: "outside" })}\n`);
    },
  );

  it.each(["mid-stream", "final"] as const)(
    "retries a rejected immediate truncate for a %s partial write before any append",
    async (position) => {
      directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-truncate-retry-")));
      const reports: string[] = [];
      let writeCount = 0;
      let truncateCount = 0;
      let sink = await openRuntimeLogSink(directory, {
        retryBackoffMs: 0,
        reportFailure: (line) => reports.push(line),
        truncateFile: async (handle, size) => {
          truncateCount += 1;
          if (truncateCount === 1) throw new Error("injected immediate truncate failure");
          await handle.truncate(size);
        },
        writeRecord: async (handle, record) => {
          writeCount += 1;
          if (writeCount === 2) {
            await handle.writeFile(record.subarray(0, 6));
            throw new Error("injected partial write failure");
          }
          await handle.writeFile(record);
        },
      });
      sink.write(JSON.stringify({ event: "before" }));
      sink.write(JSON.stringify({ event: "failed" }));
      await vi.waitFor(() => expect(truncateCount).toBeGreaterThanOrEqual(2));
      if (position === "mid-stream") sink.write(JSON.stringify({ event: "after" }));
      await sink.close();

      sink = await openRuntimeLogSink(directory);
      sink.write(JSON.stringify({ event: "after-restart" }));
      await sink.close();
      expect(await readRuntimeEvents(directory)).toEqual([
        "before",
        ...(position === "mid-stream" ? ["after"] : []),
        "after-restart",
      ]);
      expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE]);
    },
  );

  it("keeps repair pending until reopen truncate succeeds", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-reopen-truncate-")));
    let writeCount = 0;
    let truncateCount = 0;
    const reports: string[] = [];
    const sink = await openRuntimeLogSink(directory, {
      retryBackoffMs: 0,
      reportFailure: (line) => reports.push(line),
      truncateFile: async (handle, size) => {
        truncateCount += 1;
        if (truncateCount <= 2) throw new Error("injected truncate failure");
        await handle.truncate(size);
      },
      writeRecord: async (handle, record) => {
        writeCount += 1;
        if (writeCount === 2) {
          await handle.writeFile(record.subarray(0, 6));
          throw new Error("injected partial write failure");
        }
        await handle.writeFile(record);
      },
    });
    sink.write(JSON.stringify({ event: "before" }));
    sink.write(JSON.stringify({ event: "failed-final" }));
    await sink.close();

    expect(truncateCount).toBeGreaterThanOrEqual(3);
    expect(await readRuntimeEvents(directory)).toEqual(["before"]);
    expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE]);
  });

  it("bounds close when partial-write truncation remains pending", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-hung-truncate-")));
    let releaseTruncate: (() => void) | undefined;
    const blockedTruncate = new Promise<void>((resolveTruncate) => {
      releaseTruncate = resolveTruncate;
    });
    let writeCount = 0;
    let truncateCount = 0;
    const reports: string[] = [];
    const sink = await openRuntimeLogSink(directory, {
      closeTimeoutMs: 20,
      reportFailure: (line) => reports.push(line),
      truncateFile: () => {
        truncateCount += 1;
        return blockedTruncate;
      },
      writeRecord: async (handle, record) => {
        writeCount += 1;
        if (writeCount === 2) {
          await handle.writeFile(record.subarray(0, 6));
          throw new Error("injected partial write failure");
        }
        await handle.writeFile(record);
      },
    });
    sink.write(JSON.stringify({ event: "before" }));
    sink.write(JSON.stringify({ event: "failed-final" }));
    await vi.waitFor(() => expect(writeCount).toBe(2));
    const startedAt = performance.now();
    await sink.close();
    expect(performance.now() - startedAt).toBeLessThan(200);
    releaseTruncate?.();
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));

    expect(truncateCount).toBe(1);
    expect(reports).toEqual([RUNTIME_LOG_CLOSE_TIMEOUT_MESSAGE]);
    const restarted = await openRuntimeLogSink(directory);
    restarted.write(JSON.stringify({ event: "after-restart" }));
    await restarted.close();
    expect(await readRuntimeEvents(directory)).toEqual(["before", "after-restart"]);
  });

  it("keeps slow request and liveness evidence when ordinary records saturate the queue", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-slow-priority-")));
    let releaseWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolveWrite) => {
      releaseWrite = resolveWrite;
    });
    let writeCount = 0;
    const reports: string[] = [];
    const sink = await openRuntimeLogSink(directory, {
      maxQueuedRecords: 3,
      maxQueuedBytes: 1_024,
      reservedSlowBytes: 0,
      reportFailure: (line) => reports.push(line),
      writeRecord: async (handle, record) => {
        writeCount += 1;
        if (writeCount === 1) await firstWrite;
        await handle.writeFile(record);
      },
    });
    const logger = createRuntimeLogger(sink.write, () => new Date("2026-08-23T12:00:00.000Z"));
    logger.emit({ event: "request", method: "GET", path: "/api/cubes", status: 200, elapsedMs: 10 });
    logger.emit({ event: "request", method: "GET", path: "/api/cubes", status: 200, elapsedMs: 11 });
    logger.emit({
      event: "slow_request",
      method: "GET",
      path: "/api/cubes",
      status: 200,
      elapsedMs: 1_500,
    });
    logger.emit({
      event: "slow_liveness_scan",
      elapsedMs: 1_200,
      candidateCount: 12,
      outcome: "success",
    });
    expect(sink.inspect()).toMatchObject({ queuedRecords: 3, droppedRecords: 1 });
    releaseWrite?.();
    await sink.close();

    const records = (await readFile(join(directory, "logs", RUNTIME_LOG_FILE_NAME), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { event: string });
    expect(records.map((record) => record.event)).toEqual([
      "request",
      "slow_request",
      "slow_liveness_scan",
    ]);
    expect(reports).toEqual([RUNTIME_LOG_OVERFLOW_MESSAGE]);
  });

  it("disables telemetry before rotating through an unsafe generation", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-rotation-safety-")));
    const reports: string[] = [];
    const sink = await openRuntimeLogSink(directory, {
      maxBytes: 8,
      reportFailure: (line) => reports.push(line),
    });
    const logs = join(directory, "logs");
    await symlink(join(logs, RUNTIME_LOG_FILE_NAME), join(logs, `${RUNTIME_LOG_FILE_NAME}.1`));
    for (const line of ["a", "b", "c", "d", "e"]) sink.write(line);
    await sink.close();

    expect(await readFile(join(logs, RUNTIME_LOG_FILE_NAME), "utf8")).toBe("a\nb\nc\nd\n");
    expect(reports).toEqual([RUNTIME_LOG_UNSAFE_MESSAGE]);
  });

  it.each(["symbolic link", "hard link"])("refuses an unsafe %s generation", async (kind) => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-unsafe-log-")));
    const logs = join(directory, "logs");
    const sink = await openRuntimeLogSink(directory);
    await sink.close();
    const current = join(logs, RUNTIME_LOG_FILE_NAME);
    const generation = join(logs, `${RUNTIME_LOG_FILE_NAME}.1`);
    if (kind === "symbolic link") await symlink(current, generation);
    else await link(current, generation);

    await expect(openRuntimeLogSink(directory)).rejects.toBe(operatorErrors.RUNTIME_LOG_UNSAFE);
  });

  it("refuses an over-permissive current log at startup", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-unsafe-mode-")));
    const sink = await openRuntimeLogSink(directory);
    await sink.close();
    await chmod(join(directory, "logs", RUNTIME_LOG_FILE_NAME), 0o644);

    await expect(openRuntimeLogSink(directory)).rejects.toBe(operatorErrors.RUNTIME_LOG_UNSAFE);
  });

  it("refuses a runtime-log root owned by a different uid", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-foreign-owner-")));
    const uid = process.getuid?.();
    if (uid === undefined) return;

    await expect(openRuntimeLogSink(directory, { uid: uid + 1 }))
      .rejects.toBe(operatorErrors.RUNTIME_LOG_UNSAFE);
  });
});

async function readRuntimeEvents(directory: string): Promise<string[]> {
  const logs = join(directory, "logs");
  const files = (await readdir(logs))
    .filter((name) => name === RUNTIME_LOG_FILE_NAME || /^runtime\.log\.[12]$/u.test(name))
    .sort((left, right) => right.localeCompare(left));
  const events: string[] = [];
  for (const file of files) {
    const content = await readFile(join(logs, file), "utf8");
    for (const line of content.trim().split("\n")) {
      if (line.length === 0) continue;
      events.push((JSON.parse(line) as { event: string }).event);
    }
  }
  return events;
}
