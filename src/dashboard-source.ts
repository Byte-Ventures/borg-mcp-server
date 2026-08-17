import { lstatSync, realpathSync, type Stats } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assertMigrationsCurrent, MigrationCompatibilityError } from "./migrations.js";
import { operatorErrors } from "./operator-error.js";
import {
  DASHBOARD_ACTIVITY_WINDOW_MS,
  DASHBOARD_IDLE_REFRESH_MS,
  type DashboardAttentionData,
  type DashboardDroneData,
  type DashboardDataSnapshot,
  type DashboardRecentActivityData,
  type DashboardSnapshotSource,
} from "./dashboard.js";
import { WAKE_STALE_AFTER_MS } from "./wake-policy.js";

export const DASHBOARD_POLL_INTERVAL_MS = 2_000;
export const DASHBOARD_MAX_CUBES = 1_000;
export const DASHBOARD_RECENT_ACTIVITY_LIMIT = 8;

export interface CloseableDashboardSnapshotSource extends DashboardSnapshotSource {
  readonly close: () => void;
}

export function assertReadonlyDashboardInstallation(dataDirectory: string): void {
  resolveReadonlyDashboardDatabase(dataDirectory);
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
  const drones = database.prepare(`
    SELECT drone.id, drone.label, role.name AS role,
           COALESCE(drone.last_seen, drone.created_at) AS last_seen,
           (SELECT COUNT(*) FROM activity_log AS entry
            WHERE entry.cube_id = drone.cube_id AND entry.drone_id = drone.id
              AND entry.created_at >= ?) AS sent,
           (SELECT COUNT(*) FROM activity_log AS entry
            WHERE entry.cube_id = drone.cube_id AND entry.drone_id = drone.id
              AND entry.created_at >= ?) AS sent_5s,
            (SELECT COUNT(*) FROM activity_log AS entry
             WHERE entry.cube_id = drone.cube_id AND EXISTS (
              SELECT 1 FROM activity_log_recipients AS recipient
              WHERE recipient.entry_id = entry.id AND recipient.drone_id = drone.id
             ) AND entry.created_at >= ?) AS received,
            COALESCE(attention.unacked_directed, 0) AS unacked_directed,
            COALESCE(attention.stale_directed, 0) AS stale_directed,
            attention.oldest_unacked_at
    FROM drones AS drone
    JOIN roles AS role ON role.id = drone.role_id AND role.cube_id = drone.cube_id
    LEFT JOIN (
      SELECT recipient.drone_id,
             COUNT(*) AS unacked_directed,
             SUM(CASE WHEN entry.created_at <= ? THEN 1 ELSE 0 END) AS stale_directed,
             MIN(entry.created_at) AS oldest_unacked_at
      FROM activity_log AS entry
      JOIN activity_log_recipients AS recipient ON recipient.entry_id = entry.id
      LEFT JOIN activity_acks AS acknowledgement
        ON acknowledgement.entry_id = entry.id
       AND acknowledgement.principal_kind = 'drone-session'
       AND acknowledgement.claimant_drone_id = recipient.drone_id
       AND acknowledgement.kind = 'ack'
      WHERE entry.cube_id = ? AND entry.visibility = 'direct'
        AND acknowledgement.entry_id IS NULL
      GROUP BY recipient.drone_id
    ) AS attention ON attention.drone_id = drone.id
    WHERE drone.cube_id = ? AND drone.evicted_at IS NULL
    ORDER BY drone.label, drone.id
  `);
  const recentActivity = database.prepare(`
    SELECT entry.id, cube.name AS cube_name, entry.actor_kind,
           drone.label AS actor_label, role.name AS actor_role,
           entry.created_at, entry.visibility,
           (SELECT COUNT(*) FROM activity_log_recipients AS recipient
            WHERE recipient.entry_id = entry.id) AS recipient_count,
           entry.routing_class AS activity_class,
           substr(entry.message, 1, 256) AS message_head
    FROM activity_log AS entry
    JOIN cubes AS cube ON cube.id = entry.cube_id
    LEFT JOIN drones AS drone ON drone.id = entry.drone_id AND drone.cube_id = entry.cube_id
    LEFT JOIN roles AS role ON role.id = drone.role_id AND role.cube_id = drone.cube_id
    ORDER BY entry.created_at DESC, entry.id DESC
    LIMIT ?
  `);
  return () => {
    const capturedAt = clock();
    const cutoff = new Date(
      capturedAt.getTime() - DASHBOARD_ACTIVITY_WINDOW_MS,
    ).toISOString();
    const tickCutoff = new Date(
      capturedAt.getTime() - DASHBOARD_IDLE_REFRESH_MS,
    ).toISOString();
    const staleCutoff = new Date(
      capturedAt.getTime() - WAKE_STALE_AFTER_MS,
    ).toISOString();
    const rows = statement.all(cutoff, cutoff, cutoff, maxCubes);
    let attention = emptyAttention();
    const cubes = rows.map((row) => {
      const cubeId = requiredText(row, "id");
      const droneRows = drones.all(cutoff, tickCutoff, cutoff, staleCutoff, cubeId, cubeId);
      const dashboardDrones = droneRows.map((drone) => dashboardDrone(drone, requiredText(row, "name")));
      const cubeAttention = combineAttention(dashboardDrones.map((drone) => drone.attention));
      attention = combineAttention([attention, cubeAttention]);
      return Object.freeze({
        id: cubeId,
        name: requiredText(row, "name"),
        posts_15m: requiredInteger(row, "posts_15m"),
        distinct_posting_drones_15m: requiredInteger(
          row,
          "distinct_posting_drones_15m",
        ),
        drones_total: requiredInteger(row, "drones_total"),
        drones_seen_15m: requiredInteger(row, "drones_seen_15m"),
        last_post_at: nullableText(row, "last_post_at"),
        drones: Object.freeze(dashboardDrones),
        attention: cubeAttention,
      });
    });
    return Object.freeze({
      captured_at: capturedAt.toISOString(),
      cubes: Object.freeze(cubes),
      attention,
      recent_activity: Object.freeze(recentActivity.all(DASHBOARD_RECENT_ACTIVITY_LIMIT).map(dashboardRecentActivity)),
    });
  };
}

function dashboardDrone(row: Record<string, unknown>, cubeName: string): DashboardDroneData {
  const oldest = nullableText(row, "oldest_unacked_at");
  return Object.freeze({
    id: requiredText(row, "id"),
    label: requiredText(row, "label"),
    role: requiredText(row, "role"),
    last_seen: requiredText(row, "last_seen"),
    sent: requiredInteger(row, "sent"),
    sent_5s: requiredInteger(row, "sent_5s"),
    received: requiredInteger(row, "received"),
    attention: Object.freeze({
      unacked_directed: requiredInteger(row, "unacked_directed"),
      stale_directed: requiredInteger(row, "stale_directed"),
      oldest_unacked: oldest === null ? null : Object.freeze({
        created_at: oldest,
        cube_name: cubeName,
        recipient_label: requiredText(row, "label"),
      }),
    }),
  });
}

function emptyAttention(): DashboardAttentionData {
  return Object.freeze({ unacked_directed: 0, stale_directed: 0, oldest_unacked: null });
}

function combineAttention(values: readonly DashboardAttentionData[]): DashboardAttentionData {
  let oldest: DashboardAttentionData["oldest_unacked"] = null;
  for (const value of values) {
    if (value.oldest_unacked !== null &&
        (oldest === null || value.oldest_unacked.created_at < oldest.created_at)) {
      oldest = value.oldest_unacked;
    }
  }
  return Object.freeze({
    unacked_directed: values.reduce((sum, value) => sum + value.unacked_directed, 0),
    stale_directed: values.reduce((sum, value) => sum + value.stale_directed, 0),
    oldest_unacked: oldest,
  });
}

function dashboardRecentActivity(row: Record<string, unknown>): DashboardRecentActivityData {
  const actorKind = requiredText(row, "actor_kind");
  if (actorKind !== "operator" && actorKind !== "client" && actorKind !== "drone-session") {
    throw new Error("Dashboard actor kind is invalid.");
  }
  const visibility = requiredText(row, "visibility");
  if (visibility !== "broadcast" && visibility !== "direct") {
    throw new Error("Dashboard visibility is invalid.");
  }
  return Object.freeze({
    id: requiredText(row, "id"),
    cube_name: requiredText(row, "cube_name"),
    actor_kind: actorKind,
    actor_label: nullableText(row, "actor_label"),
    actor_role: nullableText(row, "actor_role"),
    created_at: requiredText(row, "created_at"),
    visibility,
    recipient_count: requiredInteger(row, "recipient_count"),
    activity_class: nullableText(row, "activity_class"),
    message_head: requiredText(row, "message_head"),
  });
}

export async function openReadonlyDashboardSnapshotSource(input: {
  readonly dataDirectory: string;
  readonly clock?: () => Date;
  readonly pollIntervalMs?: number;
  readonly maxCubes?: number;
  readonly validate?: () => void | Promise<void>;
}): Promise<CloseableDashboardSnapshotSource> {
  const databasePath = resolveReadonlyDashboardDatabase(input.dataDirectory);
  const pollIntervalMs = input.pollIntervalMs ?? DASHBOARD_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
    throw new Error("Dashboard poll interval is invalid.");
  }
  let database: DatabaseSync | undefined;
  try {
    database = openPinnedReadonlyDatabase(databasePath);
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

interface ValidatedDashboardDatabase {
  readonly directory: string;
  readonly directoryIdentity: FileIdentity;
  readonly databaseIdentity: FileIdentity;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

function resolveReadonlyDashboardDatabase(
  dataDirectory: string,
): ValidatedDashboardDatabase {
  const directory = resolve(dataDirectory);
  let directoryMetadata: Stats;
  let databaseMetadata: Stats;
  try {
    if (realpathSync(directory) !== directory) throw operatorErrors.DATA_PATH_SYMLINK;
    validateTrustedDirectoryAncestry(directory);
    directoryMetadata = lstatSync(directory);
    databaseMetadata = lstatSync(join(directory, "borg.db"));
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
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId !== undefined &&
      (directoryMetadata.uid !== effectiveUserId ||
       databaseMetadata.uid !== effectiveUserId)) {
    throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
  }
  return {
    directory,
    directoryIdentity: fileIdentity(directoryMetadata),
    databaseIdentity: fileIdentity(databaseMetadata),
  };
}

function validateTrustedDirectoryAncestry(directory: string): void {
  const root = parse(directory).root;
  const effectiveUserId = process.geteuid?.();
  const components = directory.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw operatorErrors.DATA_PATH_SYMLINK;
    }
    if (effectiveUserId !== undefined &&
        metadata.uid !== 0 && metadata.uid !== effectiveUserId) {
      throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
    }
    const writableByOtherIdentity = (metadata.mode & 0o022) !== 0;
    const rootOwnedStickyDirectory =
      metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
    if (writableByOtherIdentity && !rootOwnedStickyDirectory) {
      throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
    }
  }
}

function openPinnedReadonlyDatabase(
  validated: ValidatedDashboardDatabase,
): DatabaseSync {
  const originalWorkingDirectory = process.cwd();
  let changedDirectory = false;
  let database: DatabaseSync | undefined;
  try {
    // chdir pins the validated directory inode in the kernel. The synchronous
    // critical section then opens borg.db relative to that inode, so replacing
    // the configured pathname after validation cannot redirect SQLite.
    process.chdir(validated.directory);
    changedDirectory = true;
    assertFileIdentity(lstatSync("."), validated.directoryIdentity);
    const databaseMetadata = lstatSync("borg.db");
    assertFileIdentity(databaseMetadata, validated.databaseIdentity);
    if (databaseMetadata.isSymbolicLink() || !databaseMetadata.isFile()) {
      throw operatorErrors.DATA_PATH_SYMLINK;
    }
    database = new DatabaseSync("borg.db", {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    assertFileIdentity(lstatSync("."), validated.directoryIdentity);
    assertFileIdentity(lstatSync("borg.db"), validated.databaseIdentity);
    return database;
  } catch (error) {
    database?.close();
    throw error;
  } finally {
    if (changedDirectory) {
      try {
        process.chdir(originalWorkingDirectory);
      } catch (error) {
        database?.close();
        throw error;
      }
    }
  }
}

function fileIdentity(metadata: Stats): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function assertFileIdentity(metadata: Stats, expected: FileIdentity): void {
  if (metadata.dev !== expected.device || metadata.ino !== expected.inode) {
    throw operatorErrors.DASHBOARD_DATA_UNAVAILABLE;
  }
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
