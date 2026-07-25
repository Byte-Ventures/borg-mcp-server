import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assertMigrationsCurrent, MigrationCompatibilityError } from "./migrations.js";
import { operatorErrors } from "./operator-error.js";
import {
  DASHBOARD_ACTIVITY_WINDOW_MS,
  type DashboardDataSnapshot,
  type DashboardSnapshotSource,
} from "./dashboard.js";

export const DASHBOARD_POLL_INTERVAL_MS = 2_000;
export const DASHBOARD_MAX_CUBES = 1_000;

export interface CloseableDashboardSnapshotSource extends DashboardSnapshotSource {
  readonly close: () => void;
}

export function createDashboardSnapshotReader(
  database: DatabaseSync,
  clock: () => Date,
  maxCubes: number,
): () => DashboardDataSnapshot {
  if (!Number.isSafeInteger(maxCubes) || maxCubes < 1) {
    throw new Error("Dashboard cube limit is invalid.");
  }
  const statement = database.prepare(`
    SELECT cube.id, cube.name,
           (SELECT COUNT(*) FROM activity_log AS entry
            WHERE entry.cube_id = cube.id AND entry.created_at >= ?) AS posts_15m,
           (SELECT COUNT(DISTINCT entry.drone_id) FROM activity_log AS entry
            WHERE entry.cube_id = cube.id AND entry.created_at >= ?
              AND entry.drone_id IS NOT NULL) AS distinct_posting_drones_15m,
           (SELECT COUNT(*) FROM drones AS drone
            WHERE drone.cube_id = cube.id AND drone.evicted_at IS NULL) AS drones_total,
           (SELECT COUNT(*) FROM drones AS drone
            WHERE drone.cube_id = cube.id AND drone.evicted_at IS NULL
              AND COALESCE(drone.last_seen, drone.created_at) >= ?) AS drones_seen_15m,
           (SELECT MAX(entry.created_at) FROM activity_log AS entry
            WHERE entry.cube_id = cube.id) AS last_post_at
    FROM cubes AS cube
    ORDER BY cube.id
    LIMIT ?
  `);
  return () => {
    const capturedAt = clock();
    const cutoff = new Date(
      capturedAt.getTime() - DASHBOARD_ACTIVITY_WINDOW_MS,
    ).toISOString();
    const rows = statement.all(cutoff, cutoff, cutoff, maxCubes);
    return Object.freeze({
      captured_at: capturedAt.toISOString(),
      cubes: Object.freeze(rows.map((row) => Object.freeze({
        id: requiredText(row, "id"),
        name: requiredText(row, "name"),
        posts_15m: requiredInteger(row, "posts_15m"),
        distinct_posting_drones_15m: requiredInteger(
          row,
          "distinct_posting_drones_15m",
        ),
        drones_total: requiredInteger(row, "drones_total"),
        drones_seen_15m: requiredInteger(row, "drones_seen_15m"),
        last_post_at: nullableText(row, "last_post_at"),
      }))),
    });
  };
}

export async function openReadonlyDashboardSnapshotSource(input: {
  readonly dataDirectory: string;
  readonly clock?: () => Date;
  readonly pollIntervalMs?: number;
  readonly maxCubes?: number;
  readonly validate?: () => void | Promise<void>;
}): Promise<CloseableDashboardSnapshotSource> {
  const databasePath = await resolveReadonlyDashboardDatabase(input.dataDirectory);
  const pollIntervalMs = input.pollIntervalMs ?? DASHBOARD_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
    throw new Error("Dashboard poll interval is invalid.");
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    database.exec(`
      PRAGMA query_only = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 1000;
    `);
    assertMigrationsCurrent(database);
    const readSnapshot = createDashboardSnapshotReader(
      database,
      input.clock ?? (() => new Date()),
      input.maxCubes ?? DASHBOARD_MAX_CUBES,
    );
    let state:
      | { readonly snapshot: DashboardDataSnapshot; readonly error?: never }
      | { readonly snapshot?: never; readonly error: unknown } = {
        snapshot: readSnapshot(),
      };
    const listeners = new Set<() => void>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let polling = false;
    const poll = async (): Promise<void> => {
      if (closed || polling) return;
      polling = true;
      try {
        await input.validate?.();
        if (closed) return;
        state = { snapshot: readSnapshot() };
      } catch (error) {
        state = {
          error: isOperatorError(error)
            ? error
            : operatorErrors.DASHBOARD_DATA_UNAVAILABLE,
        };
      } finally {
        polling = false;
      }
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A viewer subscriber cannot affect the read-only polling source.
        }
      }
    };
    const source: CloseableDashboardSnapshotSource = {
      read: () => {
        if (state.error !== undefined) throw state.error;
        return state.snapshot!;
      },
      subscribe: (listener) => {
        if (closed) throw new Error("Dashboard snapshot source is closed.");
        listeners.add(listener);
        if (timer === undefined) {
          // Unlike the embedded event source, this standalone source must own
          // a referenced handle so the viewer process remains alive.
          timer = setInterval(() => { void poll(); }, pollIntervalMs);
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0 && timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
        };
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        listeners.clear();
        database?.close();
        database = undefined;
      },
    };
    return Object.freeze(source);
  } catch (error) {
    database?.close();
    if (error instanceof MigrationCompatibilityError) {
      throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
    }
    if (isOperatorError(error)) throw error;
    throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
  }
}

async function resolveReadonlyDashboardDatabase(dataDirectory: string): Promise<string> {
  const directory = resolve(dataDirectory);
  let directoryMetadata;
  let databaseMetadata;
  try {
    if (await realpath(directory) !== directory) throw operatorErrors.DATA_PATH_SYMLINK;
    directoryMetadata = await lstat(directory);
    databaseMetadata = await lstat(join(directory, "borg.db"));
  } catch (error) {
    if (isOperatorError(error)) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw operatorErrors.DASHBOARD_INSTALLATION_MISSING;
    }
    throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
  }
  if (directoryMetadata.isSymbolicLink() || databaseMetadata.isSymbolicLink()) {
    throw operatorErrors.DATA_PATH_SYMLINK;
  }
  if (!directoryMetadata.isDirectory() || !databaseMetadata.isFile() ||
      (directoryMetadata.mode & 0o077) !== 0 || (databaseMetadata.mode & 0o077) !== 0) {
    throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
  }
  return join(directory, "borg.db");
}

function isOperatorError(error: unknown): boolean {
  return Object.values(operatorErrors).includes(error as Error);
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Dashboard ${key} is invalid.`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`Dashboard ${key} is invalid.`);
  }
  return value;
}

function requiredInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Dashboard ${key} is invalid.`);
  }
  return value as number;
}
