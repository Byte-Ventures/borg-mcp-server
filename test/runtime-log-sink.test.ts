import { link, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
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
    let sink = await openRuntimeLogSink(directory, { maxBytes: 8 });
    for (const line of ["a", "b", "c", "d", "e"]) sink.write(line);
    await sink.close();

    sink = await openRuntimeLogSink(directory, { maxBytes: 8 });
    for (const line of ["f", "g", "h", "i", "j", "k", "l", "m"]) sink.write(line);
    await sink.close();

    const logDirectory = join(directory, "logs");
    expect((await readdir(logDirectory)).sort()).toEqual([
      RUNTIME_LOG_FILE_NAME,
      `${RUNTIME_LOG_FILE_NAME}.1`,
      `${RUNTIME_LOG_FILE_NAME}.2`,
    ]);
    expect(await readFile(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.2`), "utf8"))
      .toBe("e\nf\ng\nh\n");
    expect(await readFile(join(logDirectory, `${RUNTIME_LOG_FILE_NAME}.1`), "utf8"))
      .toBe("i\nj\nk\nl\n");
    expect(await readFile(join(logDirectory, RUNTIME_LOG_FILE_NAME), "utf8")).toBe("m\n");
    for (const name of await readdir(logDirectory)) {
      const metadata = await lstat(join(logDirectory, name));
      expect(metadata.size).toBeLessThanOrEqual(8);
      expect(metadata.mode & 0o077).toBe(0);
    }
    expect((await lstat(logDirectory)).mode & 0o077).toBe(0);
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

  it("reports a write failure once, reopens, and carries failed and dropped counts", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-retry-log-")));
    const reports: string[] = [];
    let writeCount = 0;
    const sink = await openRuntimeLogSink(directory, {
      retryBackoffMs: 0,
      reportFailure: (line) => reports.push(line),
      writeRecord: async (handle, record) => {
        writeCount += 1;
        if (writeCount === 1) throw new Error("injected write failure");
        await handle.writeFile(record);
      },
    });
    sink.write(JSON.stringify({ event: "failed" }));
    await vi.waitFor(() => expect(writeCount).toBe(1));
    sink.write(JSON.stringify({ event: "recovered" }));
    await sink.close();

    const records = (await readFile(join(directory, "logs", RUNTIME_LOG_FILE_NAME), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([{
      event: "recovered",
      runtime_log_dropped_records: 1,
      runtime_log_write_failures: 1,
    }]);
    expect(reports).toEqual([RUNTIME_LOG_FAILURE_MESSAGE]);
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
});
