import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const STORE_MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "initial_scoped_store",
    sql: `
      CREATE TABLE clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;

      CREATE TABLE cubes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        directive TEXT NOT NULL CHECK (length(directive) <= 100000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE client_cube_grants (
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        cube_id TEXT NOT NULL REFERENCES cubes(id) ON DELETE CASCADE,
        access TEXT NOT NULL CHECK (access IN ('read', 'write', 'manage')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (client_id, cube_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE roles (
        id TEXT NOT NULL,
        cube_id TEXT NOT NULL REFERENCES cubes(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        created_at TEXT NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (id, cube_id),
        UNIQUE (cube_id, name)
      ) STRICT;

      CREATE TABLE drones (
        id TEXT NOT NULL,
        cube_id TEXT NOT NULL REFERENCES cubes(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
        created_at TEXT NOT NULL,
        evicted_at TEXT,
        PRIMARY KEY (id),
        UNIQUE (id, cube_id),
        UNIQUE (id, client_id, cube_id),
        UNIQUE (cube_id, label),
        FOREIGN KEY (role_id, cube_id) REFERENCES roles(id, cube_id)
      ) STRICT;

      CREATE TABLE drone_sessions (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        cube_id TEXT NOT NULL,
        drone_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY (drone_id, client_id, cube_id)
          REFERENCES drones(id, client_id, cube_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE activity_log (
        id TEXT PRIMARY KEY,
        cube_id TEXT NOT NULL REFERENCES cubes(id) ON DELETE CASCADE,
        drone_id TEXT,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'client', 'drone-session')),
        actor_id TEXT NOT NULL,
        message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 10240),
        created_at TEXT NOT NULL,
        FOREIGN KEY (drone_id, cube_id) REFERENCES drones(id, cube_id)
      ) STRICT;

      CREATE TABLE activity_acks (
        entry_id TEXT NOT NULL REFERENCES activity_log(id) ON DELETE CASCADE,
        principal_kind TEXT NOT NULL CHECK (principal_kind IN ('operator', 'client', 'drone-session')),
        principal_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ack', 'claim')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (entry_id, principal_kind, principal_id, kind)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX client_cube_grants_cube_idx
        ON client_cube_grants (cube_id, access, client_id);
      CREATE INDEX drone_sessions_scope_idx
        ON drone_sessions (client_id, cube_id, drone_id, expires_at)
        WHERE revoked_at IS NULL;
      CREATE INDEX activity_log_cube_cursor_idx
        ON activity_log (cube_id, created_at, id);
    `,
  },
  {
    version: 2,
    name: "credential_authority",
    sql: `
      CREATE TABLE recovery_credentials (
        id TEXT PRIMARY KEY,
        lookup_digest BLOB NOT NULL UNIQUE,
        verifier_digest BLOB NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;

      CREATE TABLE enrollment_invitations (
        id TEXT PRIMARY KEY,
        lookup_digest BLOB NOT NULL UNIQUE,
        verifier_digest BLOB NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;

      CREATE TABLE client_credentials (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        lookup_digest BLOB NOT NULL UNIQUE,
        verifier_digest BLOB NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;

      CREATE INDEX enrollment_invitations_expiry_idx
        ON enrollment_invitations (expires_at)
        WHERE consumed_at IS NULL;
      CREATE INDEX client_credentials_client_idx
        ON client_credentials (client_id, revoked_at);
    `,
  },
]);

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[] = STORE_MIGRATIONS,
): void {
  validateMigrationOrder(migrations);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = database.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ).all().map(appliedMigrationRow);
  const knownVersions = new Set(migrations.map((migration) => migration.version));
  for (const row of applied) {
    const migration = migrations.find((candidate) => candidate.version === row.version);
    if (migration === undefined || !knownVersions.has(row.version)) {
      throw new Error(`Database contains unknown migration ${row.version}.`);
    }
    if (row.name !== migration.name || row.checksum !== checksum(migration)) {
      throw new Error(`Migration ${row.version} does not match its recorded checksum.`);
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const record = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      record.run(
        migration.version,
        migration.name,
        checksum(migration),
        new Date().toISOString(),
      );
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original migration error is the actionable failure.
      }
      throw error;
    }
  }
}

function validateMigrationOrder(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || migration.name.length === 0 || migration.sql.length === 0) {
      throw new Error("Migrations must be non-empty and ordered contiguously from version 1.");
    }
  });
}

function checksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
    .digest("hex");
}

function appliedMigrationRow(row: Record<string, unknown>): AppliedMigrationRow {
  if (!Number.isSafeInteger(row["version"]) ||
      typeof row["name"] !== "string" ||
      typeof row["checksum"] !== "string") {
    throw new Error("Database contains an invalid migration record.");
  }
  return {
    version: row["version"] as number,
    name: row["name"],
    checksum: row["checksum"],
  };
}
