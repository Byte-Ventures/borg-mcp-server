import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class MigrationCompatibilityError extends Error {
  constructor() {
    super("Database migrations do not exactly match this server version.");
    this.name = "MigrationCompatibilityError";
  }
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
  {
    version: 3,
    name: "coordination_protocol",
    sql: `
      ALTER TABLE cubes ADD COLUMN owner_id TEXT NOT NULL
        DEFAULT '00000000-0000-4000-8000-000000000000';
      ALTER TABLE roles ADD COLUMN short_description TEXT NOT NULL DEFAULT '';
      ALTER TABLE roles ADD COLUMN detailed_description TEXT NOT NULL DEFAULT '';
      ALTER TABLE roles ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0
        CHECK (is_default IN (0, 1));
      ALTER TABLE roles ADD COLUMN is_human_seat INTEGER NOT NULL DEFAULT 0
        CHECK (is_human_seat IN (0, 1));
      ALTER TABLE drones ADD COLUMN last_seen TEXT;
      ALTER TABLE drones ADD COLUMN hostname TEXT;
      ALTER TABLE activity_log ADD COLUMN visibility TEXT NOT NULL DEFAULT 'broadcast'
        CHECK (visibility IN ('broadcast', 'direct'));
      ALTER TABLE activity_acks ADD COLUMN claimant_drone_id TEXT;

      CREATE TABLE activity_log_recipients (
        entry_id TEXT NOT NULL REFERENCES activity_log(id) ON DELETE CASCADE,
        drone_id TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
        PRIMARY KEY (entry_id, drone_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE expired_activity_cursors (
        cube_id TEXT NOT NULL REFERENCES cubes(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (cube_id, entry_id, created_at)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        cube_id TEXT NOT NULL REFERENCES cubes(id) ON DELETE CASCADE,
        topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 120),
        decision TEXT NOT NULL CHECK (length(decision) BETWEEN 1 AND 100000),
        rationale TEXT CHECK (rationale IS NULL OR length(rationale) <= 100000),
        ratified_by TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'removed')),
        supersedes TEXT REFERENCES decisions(id),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX activity_log_recipients_drone_idx
        ON activity_log_recipients (drone_id, entry_id);
      CREATE INDEX activity_acks_claim_idx
        ON activity_acks (kind, entry_id, created_at);
      CREATE UNIQUE INDEX decisions_active_topic_idx
        ON decisions (cube_id, topic) WHERE status = 'active';
      CREATE INDEX decisions_cube_status_idx
        ON decisions (cube_id, status, created_at, id);
    `,
  },
  {
    version: 4,
    name: "seat_attach_credentials",
    sql: `
      ALTER TABLE drones ADD COLUMN retry_key TEXT;
      ALTER TABLE drones ADD COLUMN attach_generation INTEGER NOT NULL DEFAULT 0
        CHECK (attach_generation >= 0);
      ALTER TABLE roles ADD COLUMN role_class TEXT NOT NULL DEFAULT 'worker'
        CHECK (role_class IN ('queen', 'worker'));

      CREATE UNIQUE INDEX drones_client_retry_key_idx
        ON drones (client_id, retry_key) WHERE retry_key IS NOT NULL;

      CREATE TABLE drone_session_credentials (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES drone_sessions(id) ON DELETE CASCADE,
        lookup_digest BLOB NOT NULL UNIQUE,
        verifier_digest BLOB NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;

      CREATE INDEX drone_session_credentials_session_idx
        ON drone_session_credentials (session_id, revoked_at);
    `,
  },
  {
    version: 5,
    name: "owner_enrollment_and_cube_creation",
    sql: `
      ALTER TABLE enrollment_invitations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'client'
        CHECK (purpose IN ('owner', 'client'));
      ALTER TABLE enrollment_invitations ADD COLUMN owner_epoch INTEGER
        CHECK (owner_epoch IS NULL OR owner_epoch > 0);
      ALTER TABLE enrollment_invitations ADD COLUMN revoked_at TEXT;

      CREATE TABLE owner_enrollment_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        epoch INTEGER NOT NULL CHECK (epoch > 0),
        claimed_client_id TEXT REFERENCES clients(id),
        claimed_at TEXT,
        CHECK ((claimed_client_id IS NULL) = (claimed_at IS NULL))
      ) STRICT;

      CREATE TABLE enrollment_claims (
        invitation_id TEXT PRIMARY KEY REFERENCES enrollment_invitations(id) ON DELETE CASCADE,
        retry_key TEXT NOT NULL,
        client_id TEXT NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
        requested_client_name TEXT,
        credential_lookup_digest BLOB NOT NULL,
        credential_verifier_digest BLOB NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('owner', 'client')),
        owner_epoch INTEGER,
        created_at TEXT NOT NULL,
        CHECK ((purpose = 'owner') = (owner_epoch IS NOT NULL))
      ) STRICT;

      CREATE TABLE client_server_capabilities (
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        capability TEXT NOT NULL CHECK (capability = 'create_cube'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (client_id, capability)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE cube_create_bindings (
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        retry_key TEXT NOT NULL,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        template TEXT NOT NULL CHECK (template = 'default'),
        cube_id TEXT NOT NULL UNIQUE REFERENCES cubes(id) ON DELETE CASCADE,
        human_seat_role_id TEXT NOT NULL UNIQUE,
        default_worker_role_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (client_id, retry_key),
        FOREIGN KEY (human_seat_role_id, cube_id) REFERENCES roles(id, cube_id),
        FOREIGN KEY (default_worker_role_id, cube_id) REFERENCES roles(id, cube_id)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX cube_create_bindings_cube_idx ON cube_create_bindings (cube_id);
      CREATE INDEX enrollment_invitations_owner_idx
        ON enrollment_invitations (purpose, owner_epoch, expires_at)
        WHERE consumed_at IS NULL AND revoked_at IS NULL;
    `,
  },
  {
    version: 6,
    name: "seat_reattach_bindings",
    sql: `
      CREATE TABLE seat_attach_bindings (
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        retry_key TEXT NOT NULL,
        cube_id TEXT NOT NULL,
        requested_role_id TEXT NOT NULL,
        drone_id TEXT NOT NULL,
        prior_drone_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (client_id, retry_key),
        FOREIGN KEY (requested_role_id, cube_id) REFERENCES roles(id, cube_id),
        FOREIGN KEY (drone_id, client_id, cube_id)
          REFERENCES drones(id, client_id, cube_id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;

      INSERT INTO seat_attach_bindings (
        client_id, retry_key, cube_id, requested_role_id, drone_id, prior_drone_id, created_at
      )
      SELECT client_id, retry_key, cube_id, role_id, id, NULL, created_at
      FROM drones WHERE retry_key IS NOT NULL;

      CREATE INDEX seat_attach_bindings_drone_idx
        ON seat_attach_bindings (drone_id, client_id, cube_id);
    `,
  },
  {
    version: 7,
    name: "role_management_foundation",
    sql: `
      ALTER TABLE roles ADD COLUMN is_mandatory INTEGER NOT NULL DEFAULT 0
        CHECK (is_mandatory IN (0, 1));
      ALTER TABLE roles ADD COLUMN can_broadcast INTEGER NOT NULL DEFAULT 0
        CHECK (can_broadcast IN (0, 1));
      ALTER TABLE roles ADD COLUMN receives_all_direct INTEGER NOT NULL DEFAULT 0
        CHECK (receives_all_direct IN (0, 1));

      CREATE UNIQUE INDEX roles_one_default_per_cube_idx
        ON roles (cube_id) WHERE is_default = 1;
    `,
  },
  {
    version: 8,
    name: "cube_scoped_invitations",
    sql: `
      ALTER TABLE enrollment_invitations ADD COLUMN cube_id TEXT;
      ALTER TABLE enrollment_invitations ADD COLUMN access TEXT
        CHECK (access IS NULL OR access IN ('read', 'write', 'manage'));

      CREATE TRIGGER enrollment_invitations_scope_insert
      BEFORE INSERT ON enrollment_invitations
      WHEN (NEW.cube_id IS NULL) <> (NEW.access IS NULL)
        OR (NEW.cube_id IS NOT NULL AND NEW.purpose <> 'client')
      BEGIN
        SELECT RAISE(ABORT, 'invalid invitation cube scope');
      END;

      CREATE TRIGGER enrollment_invitations_scope_update
      BEFORE UPDATE OF cube_id, access, purpose ON enrollment_invitations
      WHEN (NEW.cube_id IS NULL) <> (NEW.access IS NULL)
        OR (NEW.cube_id IS NOT NULL AND NEW.purpose <> 'client')
      BEGIN
        SELECT RAISE(ABORT, 'invalid invitation cube scope');
      END;
    `,
  },
  {
    version: 9,
    name: "digest_correlated_seat_attach",
    sql: `
      DROP TABLE seat_attach_bindings;
      DROP INDEX drones_client_retry_key_idx;
      ALTER TABLE drones DROP COLUMN retry_key;
      ALTER TABLE drones DROP COLUMN attach_generation;
    `,
  },
  {
    version: 10,
    name: "cube_message_taxonomy",
    sql: "ALTER TABLE cubes ADD COLUMN message_taxonomy TEXT;",
  },
  {
    version: 11,
    name: "fleet_liveness",
    sql: `
      CREATE INDEX activity_log_drone_post_idx
        ON activity_log (cube_id, drone_id, created_at, id) WHERE drone_id IS NOT NULL;
      CREATE TABLE silent_seat_ping_state (
        drone_id TEXT PRIMARY KEY REFERENCES drones(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 3),
        last_ping_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 12,
    name: "drone_session_supersession",
    sql: `
      ALTER TABLE drone_sessions ADD COLUMN superseded_at TEXT;

      WITH lineage AS (
        SELECT rowid AS session_rowid,
               LEAD(created_at) OVER (
                 PARTITION BY client_id, cube_id, drone_id
                 ORDER BY created_at, rowid
               ) AS successor_at
        FROM drone_sessions
      )
      UPDATE drone_sessions
      SET superseded_at = (
        SELECT successor_at FROM lineage WHERE session_rowid = drone_sessions.rowid
      )
      WHERE rowid IN (
        SELECT session_rowid FROM lineage WHERE successor_at IS NOT NULL
      );
    `,
  },
  {
    version: 13,
    name: "non_expiring_drone_sessions",
    sql: `
      DROP INDEX drone_sessions_scope_idx;
      ALTER TABLE drone_sessions DROP COLUMN expires_at;
      CREATE INDEX drone_sessions_scope_idx
        ON drone_sessions (client_id, cube_id, drone_id)
        WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 14,
    name: "drone_runtime_metadata",
    sql: `
      ALTER TABLE drones ADD COLUMN agent_kind TEXT
        CHECK (agent_kind IS NULL OR agent_kind IN ('claude', 'codex', 'opencode'));
      ALTER TABLE drones ADD COLUMN reported_model TEXT
        CHECK (reported_model IS NULL OR length(CAST(reported_model AS BLOB)) BETWEEN 1 AND 160);
      ALTER TABLE drones ADD COLUMN working_repo_name TEXT
        CHECK (working_repo_name IS NULL OR length(CAST(working_repo_name AS BLOB)) <= 201);
      ALTER TABLE drones ADD COLUMN working_repo_origin TEXT
        CHECK (working_repo_origin IS NULL OR length(CAST(working_repo_origin AS BLOB)) <= 512);
      ALTER TABLE drones ADD COLUMN runtime_metadata_reported INTEGER NOT NULL DEFAULT 0
        CHECK (runtime_metadata_reported IN (0, 1));

      CREATE TRIGGER drones_runtime_metadata_insert
      BEFORE INSERT ON drones
      WHEN (NEW.working_repo_name IS NULL) <> (NEW.working_repo_origin IS NULL)
        OR (NEW.runtime_metadata_reported = 0 AND (
          NEW.agent_kind IS NOT NULL OR NEW.reported_model IS NOT NULL
          OR NEW.working_repo_name IS NOT NULL OR NEW.working_repo_origin IS NOT NULL
        ))
      BEGIN
        SELECT RAISE(ABORT, 'invalid drone runtime metadata');
      END;

      CREATE TRIGGER drones_runtime_metadata_update
      BEFORE UPDATE OF agent_kind, reported_model, working_repo_name,
        working_repo_origin, runtime_metadata_reported ON drones
      WHEN (NEW.working_repo_name IS NULL) <> (NEW.working_repo_origin IS NULL)
        OR (NEW.runtime_metadata_reported = 0 AND (
          NEW.agent_kind IS NOT NULL OR NEW.reported_model IS NOT NULL
          OR NEW.working_repo_name IS NOT NULL OR NEW.working_repo_origin IS NOT NULL
        ))
      BEGIN
        SELECT RAISE(ABORT, 'invalid drone runtime metadata');
      END;
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

export function assertMigrationsCurrent(
  database: DatabaseSync,
  migrations: readonly Migration[] = STORE_MIGRATIONS,
): void {
  validateMigrationOrder(migrations);
  let rows: Record<string, unknown>[];
  try {
    rows = database.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    ).all();
  } catch {
    throw new MigrationCompatibilityError();
  }
  if (rows.length !== migrations.length) throw new MigrationCompatibilityError();
  for (let index = 0; index < migrations.length; index += 1) {
    let applied: AppliedMigrationRow;
    try {
      applied = appliedMigrationRow(rows[index]!);
    } catch {
      throw new MigrationCompatibilityError();
    }
    const expected = migrations[index]!;
    if (applied.version !== expected.version || applied.name !== expected.name ||
        applied.checksum !== checksum(expected)) throw new MigrationCompatibilityError();
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
