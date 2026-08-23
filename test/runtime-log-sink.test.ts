import { link, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { operatorErrors } from "../src/operator-error.js";
import { createRuntimeLogger } from "../src/runtime-log.js";
import {
  openRuntimeLogSink,
  RUNTIME_LOG_FILE_NAME,
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

  it("retains slow request and liveness records in the bounded sink", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "borg-runtime-slow-log-")));
    const sink = await openRuntimeLogSink(directory);
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

    const records = (await readFile(join(directory, "logs", RUNTIME_LOG_FILE_NAME), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { event: string });
    expect(records.map((record) => record.event)).toEqual(["slow_request", "slow_liveness_scan"]);
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
