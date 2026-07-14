import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyMigrations } from "./migrations.js";
import {
  assertCanonicalUuid,
  assertServerDerivedPrincipal,
  type Principal,
} from "./principal.js";

export type CubeAccess = "read" | "write" | "manage";

export interface CubeRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly directive: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActivityRecord {
  readonly id: string;
  readonly cubeId: string;
  readonly droneId: string | null;
  readonly actorKind: Principal["kind"];
  readonly actorId: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface LogCursor {
  readonly id: string;
  readonly created_at: string;
}

export interface EnrichedActivityRecord {
  readonly id: string;
  readonly cube_id: string;
  readonly drone_id: string | null;
  readonly message: string;
  readonly visibility: "broadcast" | "direct";
  readonly created_at: string;
  readonly drone_label: string | null;
  readonly role_name: string | null;
  readonly recipient_drone_ids: string[];
}

export interface ClaimRecord {
  readonly log_entry_id: string;
  readonly claimant_drone_id: string;
  readonly claimant_label: string | null;
  readonly claimant_role: string | null;
  readonly claimed_at: string;
  readonly stale: false;
}

export interface ActivityPage {
  readonly entries: EnrichedActivityRecord[];
  readonly cursor: LogCursor | null;
  readonly behind_by: number;
  readonly has_more: boolean;
  readonly claims: ClaimRecord[];
}

export interface DecisionRecord {
  readonly id: string;
  readonly cube_id: string;
  readonly topic: string;
  readonly decision: string;
  readonly rationale: string | null;
  readonly ratified_by: string | null;
  readonly status: "active" | "superseded" | "removed";
  readonly supersedes: string | null;
  readonly created_at: string;
}

export interface RoleRecord {
  readonly id: string;
  readonly cube_id: string;
  readonly name: string;
  readonly short_description: string;
  readonly is_default: boolean;
  readonly is_human_seat: boolean;
  readonly created_at: string;
}

export interface DroneRecord {
  readonly id: string;
  readonly cube_id: string;
  readonly role_id: string;
  readonly label: string;
  readonly last_seen: string;
  readonly hostname: string | null;
  readonly created_at: string;
}

export interface StoreDiagnostics {
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly schemaVersions: number[];
}

export interface OpenStoreOptions {
  readonly path: string;
  readonly clock?: () => Date;
}

export interface StoreRuntime {
  readonly forPrincipal: (principal: Principal) => ScopedStore;
  readonly maintenance: MaintenanceStore;
  readonly credentials: CredentialStore;
  readonly diagnostics: () => StoreDiagnostics;
  readonly close: () => void;
}

export interface DigestPair {
  readonly lookup: Buffer;
  readonly verifier: Buffer;
}

export interface StoredSecretDigest extends DigestPair {
  readonly id: string;
  readonly expiresAt?: string;
  readonly consumedAt?: string | null;
  readonly clientId?: string;
  readonly revokedAt?: string | null;
}

export interface CredentialStore {
  readonly createRecoveryCredential: (id: string, digest: DigestPair) => void;
  readonly findRecoveryCredential: (lookup: Buffer) => StoredSecretDigest | null;
  readonly createInvitation: (id: string, digest: DigestPair, expiresAt: string) => void;
  readonly findInvitation: (lookup: Buffer) => StoredSecretDigest | null;
  readonly consumeInvitation: (input: {
    readonly invitationId: string;
    readonly clientId: string;
    readonly clientName: string;
    readonly credentialId: string;
    readonly credentialDigest: DigestPair;
  }) => boolean;
  readonly findClientCredential: (lookup: Buffer) => StoredSecretDigest | null;
  readonly rotateClientCredential: (input: {
    readonly clientId: string;
    readonly credentialId: string;
    readonly credentialDigest: DigestPair;
  }) => void;
  readonly revokeClientCredentials: (clientId: string) => void;
}

export interface ScopedStore {
  readonly listCubes: () => CubeRecord[];
  readonly getCube: (cubeId: string) => CubeRecord | null;
  readonly updateDirective: (cubeId: string, directive: string) => void;
  readonly appendActivity: (cubeId: string, message: string) => ActivityRecord;
  readonly readActivity: (cubeId: string, limit: number) => ActivityRecord[];
  readonly listRoles: (cubeId: string) => RoleRecord[];
  readonly listDrones: (cubeId: string) => DroneRecord[];
  readonly appendLog: (cubeId: string, input: {
    readonly message: string;
    readonly visibility?: "broadcast" | "direct";
    readonly recipientDroneIds?: readonly string[];
  }) => EnrichedActivityRecord;
  readonly readLog: (cubeId: string, cursor: LogCursor | null, limit: number) => ActivityPage;
  readonly acknowledge: (cubeId: string, entryId: string, kind: "ack" | "claim") => void;
  readonly recordDecision: (cubeId: string, input: {
    readonly topic: string;
    readonly decision: string;
    readonly rationale?: string;
  }) => DecisionRecord;
  readonly listDecisions: (cubeId: string) => DecisionRecord[];
  readonly subscribeActivity: (
    cubeId: string,
    listener: (entry: EnrichedActivityRecord) => void,
  ) => (() => void);
}

export interface MaintenanceStore {
  readonly createClient: (input: { readonly id: string; readonly name: string }) => void;
  readonly createCube: (input: {
    readonly id: string;
    readonly ownerId?: string;
    readonly name: string;
    readonly directive: string;
  }) => void;
  readonly grantClientCube: (input: {
    readonly clientId: string;
    readonly cubeId: string;
    readonly access: CubeAccess;
  }) => void;
  readonly removeClientCubeGrant: (clientId: string, cubeId: string) => void;
  readonly createRole: (input: {
    readonly id: string;
    readonly cubeId: string;
    readonly name: string;
  }) => void;
  readonly createDrone: (input: {
    readonly id: string;
    readonly cubeId: string;
    readonly roleId: string;
    readonly clientId: string;
    readonly label: string;
  }) => void;
  readonly createDroneSession: (input: {
    readonly id: string;
    readonly clientId: string;
    readonly cubeId: string;
    readonly droneId: string;
    readonly expiresAt: string;
  }) => void;
  readonly revokeClient: (clientId: string) => void;
  readonly revokeDroneSession: (sessionId: string) => void;
  readonly expireActivityCursor: (cubeId: string, cursor: LogCursor) => void;
}

export class ScopedStoreError extends Error {
  readonly code = "NOT_FOUND";

  constructor() {
    super("The requested resource was not found.");
    this.name = "ScopedStoreError";
  }
}

export class CursorExpiredError extends Error {
  readonly code = "CURSOR_EXPIRED";

  constructor() {
    super("The activity cursor has expired.");
    this.name = "CursorExpiredError";
  }
}

interface CubeRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly directive: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ActivityRow {
  readonly id: string;
  readonly cube_id: string;
  readonly drone_id: string | null;
  readonly actor_kind: Principal["kind"];
  readonly actor_id: string;
  readonly message: string;
  readonly created_at: string;
}

interface ScopePredicate {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

export async function openStore(options: OpenStoreOptions): Promise<StoreRuntime> {
  const databasePath = await prepareDatabasePath(options.path);
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  const clock = options.clock ?? (() => new Date());
  try {
    configureDatabase(database);
    applyMigrations(database);
  } catch (error) {
    database.close();
    throw error;
  }

  const maintenance = new SqliteMaintenanceStore(database, clock);
  const credentials = new SqliteCredentialStore(database, clock);
  const activityHub = new ActivityHub();
  return Object.freeze({
    forPrincipal: (principal: Principal) => {
      assertServerDerivedPrincipal(principal);
      return new SqliteScopedStore(database, principal, clock, activityHub);
    },
    maintenance,
    credentials,
    diagnostics: () => diagnostics(database),
    close: () => database.close(),
  });
}

class SqliteScopedStore implements ScopedStore {
  readonly #database: DatabaseSync;
  readonly #principal: Principal;
  readonly #clock: () => Date;
  readonly #activityHub: ActivityHub;

  constructor(
    database: DatabaseSync,
    principal: Principal,
    clock: () => Date,
    activityHub: ActivityHub,
  ) {
    this.#database = database;
    this.#principal = principal;
    this.#clock = clock;
    this.#activityHub = activityHub;
  }

  listCubes(): CubeRecord[] {
    const scope = this.#scope("read");
    const rows = this.#database.prepare(`
      SELECT c.id, c.owner_id, c.name, c.directive, c.created_at, c.updated_at
      FROM cubes AS c
      WHERE ${scope.sql}
      ORDER BY c.id
    `).all(...scope.parameters);
    return rows.map((row) => cubeRecord(cubeRow(row)));
  }

  getCube(cubeId: string): CubeRecord | null {
    assertCanonicalUuid(cubeId, "Cube id");
    const scope = this.#scope("read");
    const row = this.#database.prepare(`
      SELECT c.id, c.owner_id, c.name, c.directive, c.created_at, c.updated_at
      FROM cubes AS c
      WHERE c.id = ? AND ${scope.sql}
    `).get(cubeId, ...scope.parameters);
    return row === undefined ? null : cubeRecord(cubeRow(row));
  }

  updateDirective(cubeId: string, directive: string): void {
    assertCanonicalUuid(cubeId, "Cube id");
    validateDirective(directive);
    const scope = this.#scope("manage");
    const result = this.#database.prepare(`
      UPDATE cubes AS c
      SET directive = ?, updated_at = ?
      WHERE c.id = ? AND ${scope.sql}
    `).run(directive, this.#now(), cubeId, ...scope.parameters);
    if (result.changes !== 1) throw new ScopedStoreError();
  }

  appendActivity(cubeId: string, message: string): ActivityRecord {
    const entry = this.appendLog(cubeId, { message });
    const droneId = this.#principal.kind === "drone-session" ? this.#principal.droneId : null;
    return {
      id: entry.id,
      cubeId: entry.cube_id,
      droneId,
      actorKind: this.#principal.kind,
      actorId: this.#principal.id,
      message: entry.message,
      createdAt: entry.created_at,
    };
  }

  readActivity(cubeId: string, limit: number): ActivityRecord[] {
    assertCanonicalUuid(cubeId, "Cube id");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Activity read limit must be an integer from 1 to 500.");
    }
    const scope = this.#scope("read");
    const rows = this.#database.prepare(`
      SELECT l.id, l.cube_id, l.drone_id, l.actor_kind, l.actor_id, l.message, l.created_at
      FROM activity_log AS l
      JOIN cubes AS c ON c.id = l.cube_id
      WHERE c.id = ? AND ${scope.sql}
      ORDER BY l.created_at, l.id
      LIMIT ?
    `).all(cubeId, ...scope.parameters, limit);
    return rows.map((row) => activityRecord(activityRow(row)));
  }

  listRoles(cubeId: string): RoleRecord[] {
    this.#requireCube(cubeId, "read");
    const rows = this.#database.prepare(`
      SELECT id, cube_id, name, short_description, is_default, is_human_seat, created_at
      FROM roles WHERE cube_id = ? ORDER BY name, id
    `).all(cubeId);
    return rows.map(roleRecord);
  }

  listDrones(cubeId: string): DroneRecord[] {
    this.#requireCube(cubeId, "read");
    const rows = this.#database.prepare(`
      SELECT id, cube_id, role_id, label, COALESCE(last_seen, created_at) AS last_seen,
             hostname, created_at
      FROM drones WHERE cube_id = ? AND evicted_at IS NULL ORDER BY label, id
    `).all(cubeId);
    return rows.map(droneRecord);
  }

  appendLog(cubeId: string, input: {
    readonly message: string;
    readonly visibility?: "broadcast" | "direct";
    readonly recipientDroneIds?: readonly string[];
  }): EnrichedActivityRecord {
    assertCanonicalUuid(cubeId, "Cube id");
    if (input.message.length === 0 || Buffer.byteLength(input.message) > 10_240) {
      throw new Error("Activity message must contain 1 to 10240 bytes.");
    }
    const visibility = input.visibility ?? "broadcast";
    if (visibility !== "broadcast" && visibility !== "direct") {
      throw new Error("Unknown activity visibility.");
    }
    const recipients = [...new Set(input.recipientDroneIds ?? [])];
    if (recipients.length > 100 || recipients.some((id) => {
      try { assertCanonicalUuid(id, "Recipient drone id"); return false; } catch { return true; }
    })) {
      throw new Error("Activity recipients must contain at most 100 valid drone ids.");
    }
    if (visibility === "broadcast" && recipients.length !== 0) {
      throw new Error("Broadcast activity cannot name direct recipients.");
    }
    if (visibility === "direct" && recipients.length === 0) {
      throw new Error("Direct activity requires at least one recipient.");
    }

    const scope = this.#scope("write");
    const id = randomUUID();
    const createdAt = this.#nextActivityTimestamp(cubeId);
    const droneId = this.#principal.kind === "drone-session" ? this.#principal.droneId : null;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.#database.prepare(`
        INSERT INTO activity_log (
          id, cube_id, drone_id, actor_kind, actor_id, message, created_at, visibility
        )
        SELECT ?, c.id, ?, ?, ?, ?, ?, ?
        FROM cubes AS c
        WHERE c.id = ? AND ${scope.sql}
      `).run(
        id, droneId, this.#principal.kind, this.#principal.id, input.message,
        createdAt, visibility, cubeId, ...scope.parameters,
      );
      if (inserted.changes !== 1) throw new ScopedStoreError();
      if (recipients.length > 0) {
        const valid = this.#database.prepare(`
          SELECT COUNT(*) AS count FROM drones
          WHERE cube_id = ? AND evicted_at IS NULL
            AND id IN (${recipients.map(() => "?").join(", ")})
        `).get(cubeId, ...recipients);
        if (valid === undefined) throw new Error("Recipient count query returned no row.");
        if (requiredInteger(valid, "count") !== recipients.length) throw new ScopedStoreError();
        const addRecipient = this.#database.prepare(
          "INSERT INTO activity_log_recipients (entry_id, drone_id) VALUES (?, ?)",
        );
        for (const recipient of recipients) addRecipient.run(id, recipient);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    const entry = this.#enrichedEntry(cubeId, id);
    this.#activityHub.publish(cubeId, entry);
    return entry;
  }

  readLog(cubeId: string, cursor: LogCursor | null, limit: number): ActivityPage {
    this.#requireCube(cubeId, "read");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Activity read limit must be an integer from 1 to 500.");
    }
    this.#validateCursor(cubeId, cursor);
    const cursorSql = cursor === null
      ? { sql: "1 = 1", parameters: [] as string[] }
      : {
          sql: "(l.created_at > ? OR (l.created_at = ? AND l.id > ?))",
          parameters: [cursor.created_at, cursor.created_at, cursor.id],
        };
    const rows = this.#database.prepare(`
      SELECT l.id
      FROM activity_log AS l
      WHERE l.cube_id = ? AND ${cursorSql.sql}
      ORDER BY l.created_at, l.id
      LIMIT ?
    `).all(cubeId, ...cursorSql.parameters, limit + 1);
    const selected = rows.slice(0, limit);
    const entries = selected.map((row) => this.#enrichedEntry(cubeId, requiredText(row, "id")));
    const nextCursor = entries.length === 0
      ? cursor
      : { id: entries.at(-1)!.id, created_at: entries.at(-1)!.created_at };
    const behind = nextCursor === null ? this.#countAfter(cubeId, null) : this.#countAfter(cubeId, nextCursor);
    return {
      entries,
      cursor: nextCursor,
      behind_by: behind,
      has_more: behind > 0,
      claims: this.#claims(cubeId),
    };
  }

  acknowledge(cubeId: string, entryId: string, kind: "ack" | "claim"): void {
    this.#requireCube(cubeId, "write");
    assertCanonicalUuid(entryId, "Activity entry id");
    if (kind !== "ack" && kind !== "claim") throw new Error("Unknown acknowledgement kind.");
    const exists = this.#database.prepare(
      "SELECT 1 AS present FROM activity_log WHERE id = ? AND cube_id = ?",
    ).get(entryId, cubeId);
    if (exists === undefined) throw new ScopedStoreError();
    const claimant = this.#principal.kind === "drone-session"
      ? this.#principal.droneId
      : this.#principal.id;
    this.#database.prepare(`
      INSERT OR IGNORE INTO activity_acks (
        entry_id, principal_kind, principal_id, kind, created_at, claimant_drone_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(entryId, this.#principal.kind, this.#principal.id, kind, this.#now(), claimant);
  }

  recordDecision(cubeId: string, input: {
    readonly topic: string;
    readonly decision: string;
    readonly rationale?: string;
  }): DecisionRecord {
    this.#requireCube(cubeId, "manage");
    validateBoundedText(input.topic, "Decision topic", 120);
    validateBoundedText(input.decision, "Decision", 100_000);
    if (input.rationale !== undefined) validateBoundedText(input.rationale, "Decision rationale", 100_000);
    const id = randomUUID();
    const now = this.#now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#database.prepare(`
        SELECT id FROM decisions WHERE cube_id = ? AND topic = ? AND status = 'active'
      `).get(cubeId, input.topic);
      const supersedes = previous === undefined ? null : requiredText(previous, "id");
      if (supersedes !== null) {
        this.#database.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ?")
          .run(supersedes);
      }
      this.#database.prepare(`
        INSERT INTO decisions (
          id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        id, cubeId, input.topic, input.decision, input.rationale ?? null,
        this.#principal.kind === "drone-session" ? this.#principal.droneId : null,
        supersedes, now,
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    return this.#decision(id);
  }

  listDecisions(cubeId: string): DecisionRecord[] {
    this.#requireCube(cubeId, "read");
    return this.#database.prepare(`
      SELECT id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
      FROM decisions WHERE cube_id = ? AND status = 'active' ORDER BY topic, created_at, id
    `).all(cubeId).map(decisionRecord);
  }

  subscribeActivity(cubeId: string, listener: (entry: EnrichedActivityRecord) => void): () => void {
    this.#requireCube(cubeId, "read");
    return this.#activityHub.subscribe(cubeId, listener);
  }

  #requireCube(cubeId: string, access: CubeAccess): void {
    assertCanonicalUuid(cubeId, "Cube id");
    const scope = this.#scope(access);
    const row = this.#database.prepare(`
      SELECT 1 AS present FROM cubes AS c WHERE c.id = ? AND ${scope.sql}
    `).get(cubeId, ...scope.parameters);
    if (row === undefined) throw new ScopedStoreError();
  }

  #nextActivityTimestamp(cubeId: string): string {
    const now = this.#clock().getTime();
    const latest = this.#database.prepare(`
      SELECT created_at FROM activity_log WHERE cube_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(cubeId);
    if (latest === undefined) return new Date(now).toISOString();
    return new Date(Math.max(now, Date.parse(requiredText(latest, "created_at")) + 1)).toISOString();
  }

  #validateCursor(cubeId: string, cursor: LogCursor | null): void {
    if (cursor === null) return;
    assertCanonicalUuid(cursor.id, "Activity cursor id");
    validateTimestamp(cursor.created_at);
    const expired = this.#database.prepare(`
      SELECT 1 AS present FROM expired_activity_cursors
      WHERE cube_id = ? AND entry_id = ? AND created_at = ?
    `).get(cubeId, cursor.id, cursor.created_at);
    if (expired !== undefined) throw new CursorExpiredError();
    const valid = this.#database.prepare(`
      SELECT 1 AS present FROM activity_log WHERE cube_id = ? AND id = ? AND created_at = ?
    `).get(cubeId, cursor.id, cursor.created_at);
    if (valid === undefined) throw new ScopedStoreError();
  }

  #countAfter(cubeId: string, cursor: LogCursor | null): number {
    const row = cursor === null
      ? this.#database.prepare(
          "SELECT COUNT(*) AS count FROM activity_log WHERE cube_id = ?",
        ).get(cubeId)
      : this.#database.prepare(`
          SELECT COUNT(*) AS count FROM activity_log
          WHERE cube_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
        `).get(cubeId, cursor.created_at, cursor.created_at, cursor.id);
    if (row === undefined) throw new Error("Activity count query returned no row.");
    return requiredInteger(row, "count");
  }

  #enrichedEntry(cubeId: string, entryId: string): EnrichedActivityRecord {
    const row = this.#database.prepare(`
      SELECT l.id, l.cube_id, l.drone_id, l.message, l.visibility, l.created_at,
             d.label AS drone_label, r.name AS role_name
      FROM activity_log AS l
      LEFT JOIN drones AS d ON d.id = l.drone_id AND d.cube_id = l.cube_id
      LEFT JOIN roles AS r ON r.id = d.role_id AND r.cube_id = d.cube_id
      WHERE l.cube_id = ? AND l.id = ?
    `).get(cubeId, entryId);
    if (row === undefined) throw new ScopedStoreError();
    const recipientRows = this.#database.prepare(`
      SELECT drone_id FROM activity_log_recipients WHERE entry_id = ? ORDER BY drone_id
    `).all(entryId);
    return enrichedActivityRecord(row, recipientRows.map((recipient) => requiredText(recipient, "drone_id")));
  }

  #claims(cubeId: string): ClaimRecord[] {
    return this.#database.prepare(`
      SELECT acknowledgement.entry_id AS log_entry_id,
             acknowledgement.claimant_drone_id,
             drone.label AS claimant_label,
             role.name AS claimant_role,
             acknowledgement.created_at AS claimed_at
      FROM activity_acks AS acknowledgement
      JOIN activity_log AS entry ON entry.id = acknowledgement.entry_id
      LEFT JOIN drones AS drone ON drone.id = acknowledgement.claimant_drone_id
        AND drone.cube_id = entry.cube_id
      LEFT JOIN roles AS role ON role.id = drone.role_id AND role.cube_id = drone.cube_id
      WHERE entry.cube_id = ? AND acknowledgement.kind = 'claim'
        AND acknowledgement.claimant_drone_id IS NOT NULL
      ORDER BY acknowledgement.created_at, acknowledgement.entry_id,
               acknowledgement.claimant_drone_id
    `).all(cubeId).map(claimRecord);
  }

  #decision(id: string): DecisionRecord {
    const row = this.#database.prepare(`
      SELECT id, cube_id, topic, decision, rationale, ratified_by, status, supersedes, created_at
      FROM decisions WHERE id = ?
    `).get(id);
    if (row === undefined) throw new ScopedStoreError();
    return decisionRecord(row);
  }

  #scope(access: CubeAccess): ScopePredicate {
    if (this.#principal.kind === "operator") return { sql: "1 = 1", parameters: [] };
    if (this.#principal.kind === "client") {
      const allowed = allowedGrantAccess(access);
      const placeholders = allowed.map(() => "?").join(", ");
      return {
        sql: `EXISTS (
          SELECT 1
          FROM clients AS authorized_client
          JOIN client_cube_grants AS grant_row
            ON grant_row.client_id = authorized_client.id
          WHERE authorized_client.id = ?
            AND authorized_client.revoked_at IS NULL
            AND grant_row.cube_id = c.id
            AND grant_row.access IN (${placeholders})
        )`,
        parameters: [this.#principal.id, ...allowed],
      };
    }
    if (access === "manage") return { sql: "0 = 1", parameters: [] };
    const allowed = allowedGrantAccess(access);
    const placeholders = allowed.map(() => "?").join(", ");
    return {
      sql: `EXISTS (
        SELECT 1
        FROM drone_sessions AS authorized_session
        JOIN clients AS authorized_client
          ON authorized_client.id = authorized_session.client_id
        JOIN client_cube_grants AS parent_grant
          ON parent_grant.client_id = authorized_session.client_id
          AND parent_grant.cube_id = authorized_session.cube_id
        JOIN drones AS authorized_drone
          ON authorized_drone.id = authorized_session.drone_id
          AND authorized_drone.client_id = authorized_session.client_id
          AND authorized_drone.cube_id = authorized_session.cube_id
        WHERE authorized_session.id = ?
          AND authorized_session.client_id = ?
          AND authorized_session.cube_id = ?
          AND authorized_session.drone_id = ?
          AND authorized_session.cube_id = c.id
          AND authorized_session.revoked_at IS NULL
          AND authorized_session.expires_at > ?
          AND authorized_client.revoked_at IS NULL
          AND authorized_drone.evicted_at IS NULL
          AND parent_grant.access IN (${placeholders})
      )`,
      parameters: [
        this.#principal.id,
        this.#principal.clientId,
        this.#principal.cubeId,
        this.#principal.droneId,
        this.#now(),
        ...allowed,
      ],
    };
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

class SqliteMaintenanceStore implements MaintenanceStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;

  constructor(database: DatabaseSync, clock: () => Date) {
    this.#database = database;
    this.#clock = clock;
  }

  createClient(input: { readonly id: string; readonly name: string }): void {
    assertCanonicalUuid(input.id, "Client id");
    validateName(input.name);
    this.#database.prepare(
      "INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)",
    ).run(input.id, input.name, this.#now());
  }

  createCube(input: {
    readonly id: string;
    readonly ownerId?: string;
    readonly name: string;
    readonly directive: string;
  }): void {
    assertCanonicalUuid(input.id, "Cube id");
    if (input.ownerId !== undefined) assertCanonicalUuid(input.ownerId, "Cube owner id");
    validateName(input.name);
    validateDirective(input.directive);
    const now = this.#now();
    this.#database.prepare(`
      INSERT INTO cubes (id, owner_id, name, directive, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.ownerId ?? "00000000-0000-4000-8000-000000000000",
      input.name,
      input.directive,
      now,
      now,
    );
  }

  grantClientCube(input: {
    readonly clientId: string;
    readonly cubeId: string;
    readonly access: CubeAccess;
  }): void {
    assertCanonicalUuid(input.clientId, "Client id");
    assertCanonicalUuid(input.cubeId, "Cube id");
    if (!(["read", "write", "manage"] as const).includes(input.access)) {
      throw new Error("Unknown cube access grant.");
    }
    this.#database.prepare(`
      INSERT INTO client_cube_grants (client_id, cube_id, access, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (client_id, cube_id) DO UPDATE SET access = excluded.access
    `).run(input.clientId, input.cubeId, input.access, this.#now());
  }

  removeClientCubeGrant(clientId: string, cubeId: string): void {
    assertCanonicalUuid(clientId, "Client id");
    assertCanonicalUuid(cubeId, "Cube id");
    this.#database.prepare(
      "DELETE FROM client_cube_grants WHERE client_id = ? AND cube_id = ?",
    ).run(clientId, cubeId);
  }

  createRole(input: {
    readonly id: string;
    readonly cubeId: string;
    readonly name: string;
  }): void {
    assertCanonicalUuid(input.id, "Role id");
    assertCanonicalUuid(input.cubeId, "Cube id");
    validateName(input.name);
    this.#database.prepare(
      "INSERT INTO roles (id, cube_id, name, created_at) VALUES (?, ?, ?, ?)",
    ).run(input.id, input.cubeId, input.name, this.#now());
  }

  createDrone(input: {
    readonly id: string;
    readonly cubeId: string;
    readonly roleId: string;
    readonly clientId: string;
    readonly label: string;
  }): void {
    assertCanonicalUuid(input.id, "Drone id");
    assertCanonicalUuid(input.cubeId, "Cube id");
    assertCanonicalUuid(input.roleId, "Role id");
    assertCanonicalUuid(input.clientId, "Client id");
    validateName(input.label);
    this.#database.prepare(`
      INSERT INTO drones (id, cube_id, role_id, client_id, label, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.id, input.cubeId, input.roleId, input.clientId, input.label, this.#now());
  }

  createDroneSession(input: {
    readonly id: string;
    readonly clientId: string;
    readonly cubeId: string;
    readonly droneId: string;
    readonly expiresAt: string;
  }): void {
    assertCanonicalUuid(input.id, "Drone session id");
    assertCanonicalUuid(input.clientId, "Client id");
    assertCanonicalUuid(input.cubeId, "Cube id");
    assertCanonicalUuid(input.droneId, "Drone id");
    validateTimestamp(input.expiresAt);
    this.#database.prepare(`
      INSERT INTO drone_sessions (
        id, client_id, cube_id, drone_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.clientId,
      input.cubeId,
      input.droneId,
      this.#now(),
      input.expiresAt,
    );
  }

  revokeClient(clientId: string): void {
    assertCanonicalUuid(clientId, "Client id");
    this.#database.prepare(
      "UPDATE clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(this.#now(), clientId);
  }

  revokeDroneSession(sessionId: string): void {
    assertCanonicalUuid(sessionId, "Drone session id");
    this.#database.prepare(
      "UPDATE drone_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(this.#now(), sessionId);
  }

  expireActivityCursor(cubeId: string, cursor: LogCursor): void {
    assertCanonicalUuid(cubeId, "Cube id");
    assertCanonicalUuid(cursor.id, "Activity cursor id");
    validateTimestamp(cursor.created_at);
    const entry = this.#database.prepare(`
      SELECT 1 AS present FROM activity_log WHERE cube_id = ? AND id = ? AND created_at = ?
    `).get(cubeId, cursor.id, cursor.created_at);
    if (entry === undefined) throw new ScopedStoreError();
    this.#database.prepare(`
      INSERT OR IGNORE INTO expired_activity_cursors (cube_id, entry_id, created_at)
      VALUES (?, ?, ?)
    `).run(cubeId, cursor.id, cursor.created_at);
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

class ActivityHub {
  readonly #listeners = new Map<string, Set<(entry: EnrichedActivityRecord) => void>>();

  subscribe(cubeId: string, listener: (entry: EnrichedActivityRecord) => void): () => void {
    const listeners = this.#listeners.get(cubeId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(cubeId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(cubeId);
    };
  }

  publish(cubeId: string, entry: EnrichedActivityRecord): void {
    for (const listener of this.#listeners.get(cubeId) ?? []) {
      try {
        listener(entry);
      } catch {
        // A live subscriber cannot roll back or alter a committed append.
      }
    }
  }
}

class SqliteCredentialStore implements CredentialStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;

  constructor(database: DatabaseSync, clock: () => Date) {
    this.#database = database;
    this.#clock = clock;
  }

  createRecoveryCredential(id: string, digest: DigestPair): void {
    assertCanonicalUuid(id, "Recovery credential id");
    validateDigest(digest);
    this.#database.prepare(`
      INSERT INTO recovery_credentials (
        id, lookup_digest, verifier_digest, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(id, digest.lookup, digest.verifier, this.#now());
  }

  findRecoveryCredential(lookup: Buffer): StoredSecretDigest | null {
    validateLookup(lookup);
    const row = this.#database.prepare(`
      SELECT id, lookup_digest, verifier_digest, revoked_at
      FROM recovery_credentials
      WHERE lookup_digest = ? AND revoked_at IS NULL
    `).get(lookup);
    return row === undefined ? null : storedDigest(row);
  }

  createInvitation(id: string, digest: DigestPair, expiresAt: string): void {
    assertCanonicalUuid(id, "Invitation id");
    validateDigest(digest);
    validateTimestamp(expiresAt);
    this.#database.prepare(`
      INSERT INTO enrollment_invitations (
        id, lookup_digest, verifier_digest, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(id, digest.lookup, digest.verifier, expiresAt, this.#now());
  }

  findInvitation(lookup: Buffer): StoredSecretDigest | null {
    validateLookup(lookup);
    const row = this.#database.prepare(`
      SELECT id, lookup_digest, verifier_digest, expires_at, consumed_at
      FROM enrollment_invitations
      WHERE lookup_digest = ?
    `).get(lookup);
    return row === undefined ? null : storedDigest(row);
  }

  consumeInvitation(input: {
    readonly invitationId: string;
    readonly clientId: string;
    readonly clientName: string;
    readonly credentialId: string;
    readonly credentialDigest: DigestPair;
  }): boolean {
    assertCanonicalUuid(input.invitationId, "Invitation id");
    assertCanonicalUuid(input.clientId, "Client id");
    assertCanonicalUuid(input.credentialId, "Credential id");
    validateName(input.clientName);
    validateDigest(input.credentialDigest);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.#now();
      const consumed = this.#database.prepare(`
        UPDATE enrollment_invitations
        SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
      `).run(now, input.invitationId, now);
      if (consumed.changes !== 1) {
        this.#database.exec("ROLLBACK");
        return false;
      }
      this.#database.prepare(
        "INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)",
      ).run(input.clientId, input.clientName, now);
      this.#database.prepare(`
        INSERT INTO client_credentials (
          id, client_id, lookup_digest, verifier_digest, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.credentialId,
        input.clientId,
        input.credentialDigest.lookup,
        input.credentialDigest.verifier,
        now,
      );
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the originating storage failure.
      }
      throw error;
    }
  }

  findClientCredential(lookup: Buffer): StoredSecretDigest | null {
    validateLookup(lookup);
    const row = this.#database.prepare(`
      SELECT credential.id, credential.client_id, credential.lookup_digest,
             credential.verifier_digest,
             COALESCE(credential.revoked_at, client.revoked_at) AS revoked_at
      FROM client_credentials AS credential
      JOIN clients AS client ON client.id = credential.client_id
      WHERE credential.lookup_digest = ?
    `).get(lookup);
    return row === undefined ? null : storedDigest(row);
  }

  rotateClientCredential(input: {
    readonly clientId: string;
    readonly credentialId: string;
    readonly credentialDigest: DigestPair;
  }): void {
    assertCanonicalUuid(input.clientId, "Client id");
    assertCanonicalUuid(input.credentialId, "Credential id");
    validateDigest(input.credentialDigest);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.#now();
      this.#database.prepare(`
        UPDATE client_credentials SET revoked_at = ?
        WHERE client_id = ? AND revoked_at IS NULL
      `).run(now, input.clientId);
      this.#database.prepare(`
        INSERT INTO client_credentials (
          id, client_id, lookup_digest, verifier_digest, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.credentialId,
        input.clientId,
        input.credentialDigest.lookup,
        input.credentialDigest.verifier,
        now,
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the originating storage failure.
      }
      throw error;
    }
  }

  revokeClientCredentials(clientId: string): void {
    assertCanonicalUuid(clientId, "Client id");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.#now();
      this.#database.prepare(
        "UPDATE clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      ).run(now, clientId);
      this.#database.prepare(`
        UPDATE client_credentials SET revoked_at = ?
        WHERE client_id = ? AND revoked_at IS NULL
      `).run(now, clientId);
      this.#database.exec("COMMIT");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the originating storage failure.
      }
      throw error;
    }
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

async function prepareDatabasePath(path: string): Promise<string> {
  if (path === ":memory:") throw new Error("The server store requires a file-backed database.");
  const databasePath = resolve(path);
  const directory = dirname(databasePath);
  await ensureDirectoryTree(directory);
  await chmod(directory, 0o700);
  try {
    const handle = await open(databasePath, "ax", 0o600);
    await handle.close();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const metadata = await lstat(databasePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Database path must not contain symbolic links.");
    }
  }
  await assertDirectoryTreeHasNoSymlinks(directory);
  await chmod(databasePath, 0o600);
  return databasePath;
}

async function ensureDirectoryTree(directory: string): Promise<void> {
  const { root } = parse(directory);
  let current = root;
  for (const component of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      await assertDirectoryComponent(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      await assertDirectoryComponent(current);
    }
  }
  await assertDirectoryTreeHasNoSymlinks(directory);
}

async function assertDirectoryTreeHasNoSymlinks(directory: string): Promise<void> {
  const { root } = parse(directory);
  let current = root;
  for (const component of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, component);
    await assertDirectoryComponent(current);
  }
}

async function assertDirectoryComponent(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error("Database path must not contain symbolic links.");
  }
  if (!metadata.isDirectory()) {
    throw new Error("Database parent path must contain only directories.");
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA busy_timeout = 5000;
  `);
  if (readPragma(database, "journal_mode") !== "wal") {
    throw new Error("SQLite WAL mode is required.");
  }
}

function diagnostics(database: DatabaseSync): StoreDiagnostics {
  const journalMode = readPragma(database, "journal_mode");
  const foreignKeys = readPragma(database, "foreign_keys");
  const rows = database.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all();
  return {
    journalMode: String(journalMode).toLowerCase(),
    foreignKeys: foreignKeys === 1,
    schemaVersions: rows.map((row) => requiredInteger(row, "version")),
  };
}

function readPragma(database: DatabaseSync, name: "journal_mode" | "foreign_keys"): unknown {
  const row = database.prepare(`PRAGMA ${name}`).get();
  return row?.[name];
}

function cubeRecord(row: CubeRow): CubeRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    directive: row.directive,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function activityRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    cubeId: row.cube_id,
    droneId: row.drone_id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    message: row.message,
    createdAt: row.created_at,
  };
}

function cubeRow(row: Record<string, unknown>): CubeRow {
  return {
    id: requiredText(row, "id"),
    owner_id: requiredText(row, "owner_id"),
    name: requiredText(row, "name"),
    directive: requiredText(row, "directive"),
    created_at: requiredText(row, "created_at"),
    updated_at: requiredText(row, "updated_at"),
  };
}

function activityRow(row: Record<string, unknown>): ActivityRow {
  const actorKind = requiredText(row, "actor_kind");
  if (actorKind !== "operator" && actorKind !== "client" && actorKind !== "drone-session") {
    throw new Error("Database contains an invalid activity actor kind.");
  }
  const droneId = row["drone_id"];
  if (droneId !== null && typeof droneId !== "string") {
    throw new Error("Database contains an invalid activity drone id.");
  }
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    drone_id: droneId,
    actor_kind: actorKind,
    actor_id: requiredText(row, "actor_id"),
    message: requiredText(row, "message"),
    created_at: requiredText(row, "created_at"),
  };
}

function enrichedActivityRecord(
  row: Record<string, unknown>,
  recipientDroneIds: string[],
): EnrichedActivityRecord {
  const visibility = requiredText(row, "visibility");
  if (visibility !== "broadcast" && visibility !== "direct") {
    throw new Error("Database contains invalid activity visibility.");
  }
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    drone_id: nullableText(row, "drone_id"),
    message: requiredText(row, "message"),
    visibility,
    created_at: requiredText(row, "created_at"),
    drone_label: nullableText(row, "drone_label"),
    role_name: nullableText(row, "role_name"),
    recipient_drone_ids: recipientDroneIds,
  };
}

function claimRecord(row: Record<string, unknown>): ClaimRecord {
  return {
    log_entry_id: requiredText(row, "log_entry_id"),
    claimant_drone_id: requiredText(row, "claimant_drone_id"),
    claimant_label: nullableText(row, "claimant_label"),
    claimant_role: nullableText(row, "claimant_role"),
    claimed_at: requiredText(row, "claimed_at"),
    stale: false,
  };
}

function decisionRecord(row: Record<string, unknown>): DecisionRecord {
  const status = requiredText(row, "status");
  if (status !== "active" && status !== "superseded" && status !== "removed") {
    throw new Error("Database contains invalid decision status.");
  }
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    topic: requiredText(row, "topic"),
    decision: requiredText(row, "decision"),
    rationale: nullableText(row, "rationale"),
    ratified_by: nullableText(row, "ratified_by"),
    status,
    supersedes: nullableText(row, "supersedes"),
    created_at: requiredText(row, "created_at"),
  };
}

function roleRecord(row: Record<string, unknown>): RoleRecord {
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    name: requiredText(row, "name"),
    short_description: requiredText(row, "short_description"),
    is_default: requiredInteger(row, "is_default") === 1,
    is_human_seat: requiredInteger(row, "is_human_seat") === 1,
    created_at: requiredText(row, "created_at"),
  };
}

function droneRecord(row: Record<string, unknown>): DroneRecord {
  return {
    id: requiredText(row, "id"),
    cube_id: requiredText(row, "cube_id"),
    role_id: requiredText(row, "role_id"),
    label: requiredText(row, "label"),
    last_seen: requiredText(row, "last_seen"),
    hostname: nullableText(row, "hostname"),
    created_at: requiredText(row, "created_at"),
  };
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || typeof value === "string") return value;
  throw new Error(`Database contains invalid ${key}.`);
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Database contains invalid ${key}.`);
  return value;
}

function requiredInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) throw new Error(`Database contains invalid ${key}.`);
  return value as number;
}

function storedDigest(row: Record<string, unknown>): StoredSecretDigest {
  const lookup = requiredBuffer(row, "lookup_digest");
  const verifier = requiredBuffer(row, "verifier_digest");
  const expiresAt = optionalNonNullText(row, "expires_at");
  const consumedAt = optionalText(row, "consumed_at");
  const clientId = optionalNonNullText(row, "client_id");
  const revokedAt = optionalText(row, "revoked_at");
  return {
    id: requiredText(row, "id"),
    lookup,
    verifier,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function requiredBuffer(row: Record<string, unknown>, key: string): Buffer {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new Error(`Database contains invalid ${key}.`);
  return Buffer.from(value);
}

function optionalText(row: Record<string, unknown>, key: string): string | null | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new Error(`Database contains invalid ${key}.`);
}

function optionalNonNullText(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`Database contains invalid ${key}.`);
}

function validateName(value: string): void {
  if (value.length < 1 || value.length > 120) {
    throw new Error("Name must contain 1 to 120 characters.");
  }
}

function validateBoundedText(value: string, name: string, maxBytes: number): void {
  if (value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${name} must contain 1 to ${maxBytes} bytes.`);
  }
}

function allowedGrantAccess(access: CubeAccess): readonly CubeAccess[] {
  return access === "read"
    ? ["read", "write", "manage"]
    : access === "write" ? ["write", "manage"] : ["manage"];
}

function validateDirective(value: string): void {
  if (Buffer.byteLength(value) > 100_000) {
    throw new Error("Cube directive exceeds 100000 bytes.");
  }
}

function validateDigest(digest: DigestPair): void {
  validateLookup(digest.lookup);
  if (digest.verifier.length !== 32) throw new Error("Verifier digest must contain 32 bytes.");
}

function validateLookup(lookup: Buffer): void {
  if (lookup.length !== 16) throw new Error("Lookup digest must contain 16 bytes.");
}

function validateTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) {
    throw new Error("Timestamp must be canonical UTC with millisecond precision.");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
