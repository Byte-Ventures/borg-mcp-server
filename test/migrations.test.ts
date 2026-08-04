import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MIGRATION_CHECKSUM_MANIFEST } from "../src/migration-checksums.js";
import {
  applyMigrations,
  migrationChecksum,
  STORE_MIGRATIONS,
  type Migration,
} from "../src/migrations.js";
import { openStore } from "../src/store.js";

const temporaryDirectories: string[] = [];
type PublishedMigrationRow = readonly [version: number, name: string, checksum: string];
interface PublishedMigrationFixture {
  readonly integrity: string;
  readonly rows: readonly PublishedMigrationRow[];
}
const publishedMigrationFixtures = readFile(
  new URL("fixtures/published-migration-records.json", import.meta.url),
  "utf8",
).then((content) => JSON.parse(content) as Record<string, PublishedMigrationFixture>);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("SQLite migrations", () => {
  it("matches the committed evaluated-tuple checksum manifest", async () => {
    const fixtures = await publishedMigrationFixtures;
    const publishedV070 = fixtures["borgmcp-server@0.7.0"]!;
    expect(STORE_MIGRATIONS.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration),
    }))).toEqual(MIGRATION_CHECKSUM_MANIFEST);
    expect(migrationChecksum(STORE_MIGRATIONS[16]!)).toBe(publishedV070.rows[16]![2]);
  });

  it("replays a published 0.7.0 migration ledger and upgrades it to v19", async () => {
    const fixtures = await publishedMigrationFixtures;
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 17));
    replaceMigrationRows(database, fixtures["borgmcp-server@0.7.0"]!.rows);

    expect(() => applyMigrations(database)).not.toThrow();
    expect(database.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    ).all()).toEqual(MIGRATION_CHECKSUM_MANIFEST);
    database.close();
  });

  it("reconciles the published 0.7.1 v17 alias to canonical exactly once", async () => {
    const fixtures = await publishedMigrationFixtures;
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 18));
    replaceMigrationRows(database, fixtures["borgmcp-server@0.7.1"]!.rows);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => applyMigrations(database)).not.toThrow();
    expect(database.prepare(
      "SELECT checksum FROM schema_migrations WHERE version = 17",
    ).get()).toEqual({ checksum: MIGRATION_CHECKSUM_MANIFEST[16]!.checksum });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "Reconciled migration 17 checksum from borgmcp-server@0.7.1 to canonical.",
    );

    applyMigrations(database);
    expect(log).toHaveBeenCalledOnce();
    database.close();
  });

  it("rejects a non-alias checksum in the published predecessor fixture", async () => {
    const fixtures = await publishedMigrationFixtures;
    const database = new DatabaseSync(":memory:");
    applyMigrations(database);
    const rows = fixtures["borgmcp-server@0.7.1"]!.rows.map((row) =>
      row[0] === 17 ? [row[0], row[1], "0".repeat(64)] as const : row);
    replaceMigrationRows(database, rows);

    expect(() => applyMigrations(database)).toThrow(
      "Migration 17 does not match its recorded checksum.",
    );
    database.close();
  });

  it("does not accept the published v17 alias for any other migration", async () => {
    const fixtures = await publishedMigrationFixtures;
    const database = new DatabaseSync(":memory:");
    applyMigrations(database);
    const publishedAlias = fixtures["borgmcp-server@0.7.1"]!.rows[16]![2];
    database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 16")
      .run(publishedAlias);

    expect(() => applyMigrations(database)).toThrow(
      "Migration 16 does not match its recorded checksum.",
    );
    database.close();
  });

  it("creates a private WAL database and reopens at the same ordered schema", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "data", "borg.db");
    const first = await openStore({ path: databasePath });

    expect(first.diagnostics()).toEqual({
      journalMode: "wal",
      foreignKeys: true,
      schemaVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    });
    expect((await stat(join(directory, "data"))).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${databasePath}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${databasePath}-shm`)).mode & 0o777).toBe(0o600);
    first.close();

    const second = await openStore({ path: databasePath });
    expect(second.diagnostics().schemaVersions)
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    second.close();
    await expect(access(databasePath)).resolves.toBeUndefined();
  });

  it("rolls back every statement and version record when a migration fails", () => {
    const database = new DatabaseSync(":memory:");
    const migrations: readonly Migration[] = [{
      version: 1,
      name: "broken",
      sql: `
        CREATE TABLE must_rollback (id INTEGER PRIMARY KEY) STRICT;
        INSERT INTO table_that_does_not_exist (id) VALUES (1);
      `,
    }];

    expect(() => applyMigrations(database, migrations)).toThrow();
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_rollback'",
    ).get();
    const versions = database.prepare("SELECT version FROM schema_migrations").all();

    expect(table).toBeUndefined();
    expect(versions).toEqual([]);
    database.close();
  });

  it("rejects a changed migration checksum on restart", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, [{
      version: 1,
      name: "stable",
      sql: "CREATE TABLE stable_table (id INTEGER PRIMARY KEY) STRICT;",
    }]);

    expect(() => applyMigrations(database, [{
      version: 1,
      name: "stable",
      sql: "CREATE TABLE changed_table (id INTEGER PRIMARY KEY) STRICT;",
    }])).toThrow("Migration 1 does not match its recorded checksum.");
    database.close();
  });

  it("upgrades valid v4 presentation roles without silently creating owner state", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 4));
    const clientId = "00000000-0000-4000-8000-000000000001";
    const cubeId = "00000000-0000-4000-8000-000000000002";
    database.prepare("INSERT INTO clients (id, name, created_at) VALUES (?, 'client', ?)")
      .run(clientId, "2026-07-15T00:00:00.000Z");
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at, owner_id)
      VALUES (?, 'cube', '', ?, ?, ?)
    `).run(cubeId, "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z", clientId);
    const role = database.prepare(`
      INSERT INTO roles (id, cube_id, name, created_at, is_human_seat, role_class)
      VALUES (?, ?, ?, ?, 1, 'queen')
    `);
    role.run("00000000-0000-4000-8000-000000000003", cubeId, "Coordinator", "2026-07-15T00:00:00.000Z");
    role.run("00000000-0000-4000-8000-000000000004", cubeId, "Observer", "2026-07-15T00:00:00.000Z");

    expect(() => applyMigrations(database, STORE_MIGRATIONS)).not.toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM owner_enrollment_state").get())
      .toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT is_mandatory, can_broadcast, receives_all_direct FROM roles ORDER BY name
    `).all()).toEqual([
      { is_mandatory: 0, can_broadcast: 0, receives_all_direct: 0 },
      { is_mandatory: 0, can_broadcast: 0, receives_all_direct: 0 },
    ]);
    expect(database.prepare("SELECT message_taxonomy FROM cubes WHERE id = ?").get(cubeId))
      .toEqual({ message_taxonomy: null });
    database.prepare("UPDATE roles SET is_default = 1 WHERE name = 'Coordinator'").run();
    expect(() => database.prepare("UPDATE roles SET is_default = 1 WHERE name = 'Observer'").run())
      .toThrow();
    database.close();
  });

  it("removes legacy seat retry bindings and generation columns", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 5));
    const clientId = "00000000-0000-4000-8000-000000000011";
    const cubeId = "00000000-0000-4000-8000-000000000012";
    const roleId = "00000000-0000-4000-8000-000000000013";
    const droneId = "00000000-0000-4000-8000-000000000014";
    const retryKey = "00000000-0000-4000-8000-000000000015";
    const createdAt = "2026-07-16T00:00:00.000Z";
    database.prepare("INSERT INTO clients (id, name, created_at) VALUES (?, 'client', ?)")
      .run(clientId, createdAt);
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at, owner_id)
      VALUES (?, 'cube', '', ?, ?, ?)
    `).run(cubeId, createdAt, createdAt, clientId);
    database.prepare(`
      INSERT INTO roles (id, cube_id, name, created_at, role_class)
      VALUES (?, ?, 'Builder', ?, 'worker')
    `).run(roleId, cubeId, createdAt);
    database.prepare(`
      INSERT INTO drones (
        id, cube_id, role_id, client_id, label, created_at, last_seen, retry_key,
        attach_generation
      ) VALUES (?, ?, ?, ?, 'builder-seat', ?, ?, ?, 1)
    `).run(droneId, cubeId, roleId, clientId, createdAt, createdAt, retryKey);

    applyMigrations(database, STORE_MIGRATIONS);

    expect(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seat_attach_bindings'",
    ).get()).toBeUndefined();
    const columns = database.prepare("PRAGMA table_info(drones)").all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toContain("retry_key");
    expect(columns).not.toContain("attach_generation");
    database.close();
  });

  it("adds nullable client-only cube invitation scope without changing existing invitations", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 7));
    database.prepare(`
      INSERT INTO enrollment_invitations (
        id, lookup_digest, verifier_digest, expires_at, created_at, purpose, owner_epoch
      ) VALUES (?, ?, ?, ?, ?, 'client', NULL)
    `).run(
      "00000000-0000-4000-8000-000000000021",
      Buffer.alloc(16, 1),
      Buffer.alloc(32, 2),
      "2026-07-16T01:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    );

    applyMigrations(database, STORE_MIGRATIONS.slice(0, 8));

    expect(database.prepare("SELECT cube_id, access FROM enrollment_invitations").get())
      .toEqual({ cube_id: null, access: null });
    expect(() => database.prepare(`
      UPDATE enrollment_invitations SET cube_id = ? WHERE id = ?
    `).run(
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000021",
    )).toThrow("invalid invitation cube scope");
    expect(() => database.prepare(`
      UPDATE enrollment_invitations SET cube_id = ?, access = 'read', purpose = 'owner' WHERE id = ?
    `).run(
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000021",
    )).toThrow("invalid invitation cube scope");
    database.close();
  });

  it("removes invitation scope from populated historical rows without changing their lifecycle state", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 15));
    const insert = database.prepare(`
      INSERT INTO enrollment_invitations (
        id, lookup_digest, verifier_digest, expires_at, created_at, consumed_at,
        purpose, owner_epoch, revoked_at, cube_id, access
      ) VALUES (?, ?, ?, ?, ?, ?, 'client', NULL, ?, ?, ?)
    `);
    insert.run(
      "00000000-0000-4000-8000-000000000023",
      Buffer.alloc(16, 3),
      Buffer.alloc(32, 4),
      "2026-07-16T01:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
      null,
      null,
      "00000000-0000-4000-8000-000000000024",
      "write",
    );
    insert.run(
      "00000000-0000-4000-8000-000000000025",
      Buffer.alloc(16, 5),
      Buffer.alloc(32, 6),
      "2026-07-16T01:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
      "2026-07-16T00:30:00.000Z",
      "2026-07-16T00:31:00.000Z",
      "00000000-0000-4000-8000-000000000026",
      "manage",
    );

    applyMigrations(database, STORE_MIGRATIONS);

    const columns = database.prepare("PRAGMA table_info(enrollment_invitations)").all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toContain("cube_id");
    expect(columns).not.toContain("access");
    expect(database.prepare(`
      SELECT id, consumed_at, revoked_at FROM enrollment_invitations ORDER BY id
    `).all()).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000023",
        consumed_at: null,
        revoked_at: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000025",
        consumed_at: "2026-07-16T00:30:00.000Z",
        revoked_at: "2026-07-16T00:31:00.000Z",
      },
    ]);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'enrollment_invitations_scope_%'
    `).all()).toEqual([]);
    database.close();
  });

  it("adds nullable client names without changing populated invitation rows or dependencies", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 16));
    const invitationId = "00000000-0000-4000-8000-000000000027";
    database.prepare(`
      INSERT INTO enrollment_invitations (
        id, lookup_digest, verifier_digest, expires_at, created_at, purpose, owner_epoch
      ) VALUES (?, ?, ?, ?, ?, 'client', NULL)
    `).run(
      invitationId,
      Buffer.alloc(16, 7),
      Buffer.alloc(32, 8),
      "2026-07-16T01:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    );
    const indexesBefore = database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'enrollment_invitations'
      ORDER BY name
    `).all();

    applyMigrations(database, STORE_MIGRATIONS);

    expect(database.prepare(`
      SELECT id, consumed_at, revoked_at, client_name
      FROM enrollment_invitations WHERE id = ?
    `).get(invitationId)).toEqual({
      id: invitationId,
      consumed_at: null,
      revoked_at: null,
      client_name: null,
    });
    expect(database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'enrollment_invitations'
      ORDER BY name
    `).all()).toEqual(indexesBefore);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'view' AND sql LIKE '%enrollment_invitations%'
    `).all()).toEqual([]);
    expect(() => database.prepare(`
      UPDATE enrollment_invitations SET client_name = ? WHERE id = ?
    `).run("\u001b]8;;unsafe", invitationId)).toThrow();
    database.close();
  });

  it("persists existing drone-session supersession independently of successor liveness", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 11));
    const clientId = "00000000-0000-4000-8000-000000000031";
    const cubeId = "00000000-0000-4000-8000-000000000032";
    const roleId = "00000000-0000-4000-8000-000000000033";
    const droneId = "00000000-0000-4000-8000-000000000034";
    database.prepare("INSERT INTO clients (id, name, created_at) VALUES (?, 'client', ?)")
      .run(clientId, "2026-07-16T00:00:00.000Z");
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at, owner_id)
      VALUES (?, 'cube', '', ?, ?, ?)
    `).run(
      cubeId,
      "2026-07-16T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
      clientId,
    );
    database.prepare(`
      INSERT INTO roles (id, cube_id, name, created_at, role_class)
      VALUES (?, ?, 'Builder', ?, 'worker')
    `).run(roleId, cubeId, "2026-07-16T00:00:00.000Z");
    database.prepare(`
      INSERT INTO drones (id, cube_id, role_id, client_id, label, created_at, last_seen)
      VALUES (?, ?, ?, ?, 'builder-seat', ?, ?)
    `).run(
      droneId,
      cubeId,
      roleId,
      clientId,
      "2026-07-16T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    );
    const insertSession = database.prepare(`
      INSERT INTO drone_sessions (id, client_id, cube_id, drone_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [id, createdAt] of [
      ["00000000-0000-4000-8000-000000000035", "2026-07-16T00:00:00.000Z"],
      ["00000000-0000-4000-8000-000000000036", "2026-07-17T00:00:00.000Z"],
      ["00000000-0000-4000-8000-000000000037", "2026-07-18T00:00:00.000Z"],
    ] as const) {
      insertSession.run(id, clientId, cubeId, droneId, createdAt, "2026-07-19T00:00:00.000Z");
    }

    applyMigrations(database, STORE_MIGRATIONS);

    expect(database.prepare(`
      SELECT id, superseded_at FROM drone_sessions ORDER BY created_at
    `).all()).toEqual([
      { id: "00000000-0000-4000-8000-000000000035", superseded_at: "2026-07-17T00:00:00.000Z" },
      { id: "00000000-0000-4000-8000-000000000036", superseded_at: "2026-07-18T00:00:00.000Z" },
      { id: "00000000-0000-4000-8000-000000000037", superseded_at: null },
    ]);
    expect(database.prepare("PRAGMA table_info(drone_sessions)").all()
      .map((row) => (row as { name: string }).name)).not.toContain("expires_at");
    database.close();
  });

  it("adds explicit-null runtime metadata without synthesizing a report", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 13));
    const clientId = "00000000-0000-4000-8000-000000000041";
    const cubeId = "00000000-0000-4000-8000-000000000042";
    const roleId = "00000000-0000-4000-8000-000000000043";
    const droneId = "00000000-0000-4000-8000-000000000044";
    const createdAt = "2026-07-24T00:00:00.000Z";
    database.prepare("INSERT INTO clients (id, name, created_at) VALUES (?, 'client', ?)")
      .run(clientId, createdAt);
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at, owner_id)
      VALUES (?, 'cube', '', ?, ?, ?)
    `).run(cubeId, createdAt, createdAt, clientId);
    database.prepare(`
      INSERT INTO roles (id, cube_id, name, created_at, role_class)
      VALUES (?, ?, 'Builder', ?, 'worker')
    `).run(roleId, cubeId, createdAt);
    database.prepare(`
      INSERT INTO drones (id, cube_id, role_id, client_id, label, created_at, last_seen)
      VALUES (?, ?, ?, ?, 'builder-seat', ?, ?)
    `).run(droneId, cubeId, roleId, clientId, createdAt, createdAt);

    applyMigrations(database, STORE_MIGRATIONS);

    expect(database.prepare(`
      SELECT agent_kind, reported_model, working_repo_name, working_repo_origin,
             runtime_metadata_reported
      FROM drones WHERE id = ?
    `).get(droneId)).toEqual({
      agent_kind: null,
      reported_model: null,
      working_repo_name: null,
      working_repo_origin: null,
      runtime_metadata_reported: 0,
    });
    expect(() => database.prepare(`
      UPDATE drones SET working_repo_name = 'owner/repo' WHERE id = ?
    `).run(droneId)).toThrow("invalid drone runtime metadata");
    expect(() => database.prepare(`
      UPDATE drones SET agent_kind = 'codex' WHERE id = ?
    `).run(droneId)).toThrow("invalid drone runtime metadata");
    database.close();
  });

  it("adds repository associations and selected templates without fabricating legacy identity", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 14));
    const clientId = "00000000-0000-4000-8000-000000000051";
    const otherClientId = "00000000-0000-4000-8000-000000000052";
    const cubeId = "00000000-0000-4000-8000-000000000053";
    const otherCubeId = "00000000-0000-4000-8000-000000000058";
    const humanRoleId = "00000000-0000-4000-8000-000000000054";
    const workerRoleId = "00000000-0000-4000-8000-000000000055";
    const createdAt = "2026-07-24T01:00:00.000Z";
    const insertClient = database.prepare(
      "INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)",
    );
    insertClient.run(clientId, "client", createdAt);
    insertClient.run(otherClientId, "other", createdAt);
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at, owner_id)
      VALUES (?, 'legacy cube', '', ?, ?, ?)
    `).run(cubeId, createdAt, createdAt, clientId);
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at, owner_id)
      VALUES (?, 'other cube', '', ?, ?, ?)
    `).run(otherCubeId, createdAt, createdAt, otherClientId);
    database.prepare(`
      INSERT INTO roles (
        id, cube_id, name, created_at, is_human_seat, is_default, role_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(humanRoleId, cubeId, "Coordinator", createdAt, 1, 0, "queen");
    database.prepare(`
      INSERT INTO roles (
        id, cube_id, name, created_at, is_human_seat, is_default, role_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workerRoleId, cubeId, "Builder", createdAt, 0, 1, "worker");
    database.prepare(`
      INSERT INTO cube_create_bindings (
        client_id, retry_key, name, template, cube_id,
        human_seat_role_id, default_worker_role_id, created_at
      ) VALUES (?, ?, 'legacy cube', 'default', ?, ?, ?, ?)
    `).run(
      clientId,
      "00000000-0000-4000-8000-000000000056",
      cubeId,
      humanRoleId,
      workerRoleId,
      createdAt,
    );

    applyMigrations(database, STORE_MIGRATIONS);

    expect(database.prepare(`
      SELECT selected_template FROM cubes WHERE id = ?
    `).get(cubeId)).toEqual({ selected_template: "default" });
    expect(database.prepare(`
      SELECT working_repo_name, repository_kind, repository_value
      FROM cube_create_bindings WHERE cube_id = ?
    `).get(cubeId)).toEqual({
      working_repo_name: null,
      repository_kind: null,
      repository_value: null,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM repository_associations").get())
      .toEqual({ count: 0 });

    const insertAssociation = database.prepare(`
      INSERT INTO repository_associations (
        client_id, repository_kind, repository_value, cube_id, working_repo_name, created_at
      ) VALUES (?, 'local', ?, ?, 'legacy-repository', ?)
    `);
    insertAssociation.run(
      clientId,
      "00000000-0000-4000-8000-000000000057",
      cubeId,
      createdAt,
    );
    expect(() => insertAssociation.run(
      clientId,
      "00000000-0000-4000-8000-000000000057",
      otherCubeId,
      createdAt,
    )).toThrow();
    expect(() => insertAssociation.run(
      otherClientId,
      "00000000-0000-4000-8000-000000000057",
      cubeId,
      createdAt,
    )).not.toThrow();
    expect(() => insertAssociation.run(
      otherClientId,
      "00000000-0000-4000-8000-000000000057",
      otherCubeId,
      createdAt,
    )).toThrow();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM repository_associations WHERE cube_id = ?
    `).get(cubeId)).toEqual({ count: 2 });
    database.close();
  });

  it("preserves every association while widening cube cardinality", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 19));
    const clientId = "00000000-0000-4000-8000-000000000071";
    const otherClientId = "00000000-0000-4000-8000-000000000072";
    const cubeId = "00000000-0000-4000-8000-000000000073";
    const otherCubeId = "00000000-0000-4000-8000-000000000074";
    const createdAt = "2026-07-30T01:00:00.000Z";
    const insertClient = database.prepare(
      "INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)",
    );
    insertClient.run(clientId, "client", createdAt);
    insertClient.run(otherClientId, "other", createdAt);
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at, owner_id)
      VALUES (?, 'shared cube', '', ?, ?, ?)
    `).run(cubeId, createdAt, createdAt, clientId);
    database.prepare(`
      INSERT INTO cubes (id, name, directive, created_at, updated_at, owner_id)
      VALUES (?, 'other cube', '', ?, ?, ?)
    `).run(otherCubeId, createdAt, createdAt, otherClientId);
    const insertAssociation = database.prepare(`
      INSERT INTO repository_associations (
        client_id, repository_kind, repository_value, cube_id, working_repo_name, created_at
      ) VALUES (?, 'origin', ?, ?, ?, ?)
    `);
    const repositoryValue = "https://github.com/example/shared.git";
    insertAssociation.run(clientId, repositoryValue, cubeId, "first", createdAt);
    const secondRepositoryValue = "https://github.com/example/second.git";
    insertAssociation.run(otherClientId, secondRepositoryValue, otherCubeId, "second", createdAt);

    const selectiveCopy = STORE_MIGRATIONS[19]!.sql.replace(
      "FROM legacy_repository_associations;",
      "FROM legacy_repository_associations LIMIT 1;",
    );
    expect(selectiveCopy).not.toBe(STORE_MIGRATIONS[19]!.sql);
    database.exec("BEGIN IMMEDIATE");
    expect(() => database.exec(selectiveCopy)).toThrow();
    database.exec("ROLLBACK");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM repository_associations",
    ).get()).toEqual({ count: 2 });

    applyMigrations(database, STORE_MIGRATIONS);

    expect(database.prepare(`
      SELECT client_id, repository_kind, repository_value, cube_id, working_repo_name
      FROM repository_associations
    `).all()).toEqual([{
      client_id: clientId,
      repository_kind: "origin",
      repository_value: repositoryValue,
      cube_id: cubeId,
      working_repo_name: "first",
    }, {
      client_id: otherClientId,
      repository_kind: "origin",
      repository_value: secondRepositoryValue,
      cube_id: otherCubeId,
      working_repo_name: "second",
    }]);
    const table = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'repository_associations'",
    ).get();
    expect(table?.["sql"]).not.toContain("cube_id TEXT NOT NULL UNIQUE");
    expect(database.prepare("PRAGMA index_list('repository_associations')").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "repository_associations_cube_idx", unique: 0 }),
      ]));
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => insertAssociation.run(
      otherClientId,
      "https://github.com/example/third.git",
      cubeId,
      "third",
      createdAt,
    )).not.toThrow();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM repository_associations WHERE cube_id = ?
    `).get(cubeId)).toEqual({ count: 2 });
    database.close();
  });

  it("replaces populated template constraints without losing cube dependencies", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database, STORE_MIGRATIONS.slice(0, 17));
    const clientId = "00000000-0000-4000-8000-000000000061";
    const cubeId = "00000000-0000-4000-8000-000000000062";
    const humanRoleId = "00000000-0000-4000-8000-000000000063";
    const workerRoleId = "00000000-0000-4000-8000-000000000064";
    const createdAt = "2026-07-29T00:00:00.000Z";
    database.prepare("INSERT INTO clients (id, name, created_at) VALUES (?, 'client', ?)")
      .run(clientId, createdAt);
    database.prepare(`
      INSERT INTO cubes (
        id, name, directive, created_at, updated_at, owner_id, selected_template
      ) VALUES (?, 'cube', '', ?, ?, ?, 'starter')
    `).run(cubeId, createdAt, createdAt, clientId);
    const insertRole = database.prepare(`
      INSERT INTO roles (
        id, cube_id, name, created_at, is_human_seat, is_default, role_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertRole.run(humanRoleId, cubeId, "Coordinator", createdAt, 1, 0, "queen");
    insertRole.run(workerRoleId, cubeId, "Builder", createdAt, 0, 1, "worker");
    database.prepare(`
      INSERT INTO cube_create_bindings (
        client_id, retry_key, name, template, cube_id,
        human_seat_role_id, default_worker_role_id, created_at,
        working_repo_name, repository_kind, repository_value
      ) VALUES (?, ?, 'cube', 'starter', ?, ?, ?, ?, 'repository', 'local', ?)
    `).run(
      clientId,
      "00000000-0000-4000-8000-000000000065",
      cubeId,
      humanRoleId,
      workerRoleId,
      createdAt,
      "00000000-0000-4000-8000-000000000066",
    );

    applyMigrations(database, STORE_MIGRATIONS);

    expect(database.prepare(`
      SELECT cube.selected_template, binding.template, binding.cube_id,
             binding.human_seat_role_id, binding.default_worker_role_id
      FROM cubes AS cube
      JOIN cube_create_bindings AS binding ON binding.cube_id = cube.id
      WHERE cube.id = ?
    `).get(cubeId)).toEqual({
      selected_template: "starter",
      template: "starter",
      cube_id: cubeId,
      human_seat_role_id: humanRoleId,
      default_worker_role_id: workerRoleId,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => database.prepare(
      "UPDATE cubes SET selected_template = 'local-model' WHERE id = ?",
    ).run(cubeId)).not.toThrow();
    expect(() => database.prepare(
      "UPDATE cube_create_bindings SET template = 'local-model' WHERE cube_id = ?",
    ).run(cubeId)).not.toThrow();
    database.close();
  });

  it("rejects unordered migrations before changing the database", () => {
    const database = new DatabaseSync(":memory:");
    expect(() => applyMigrations(database, [{
      version: 2,
      name: "out_of_order",
      sql: "CREATE TABLE out_of_order (id INTEGER PRIMARY KEY) STRICT;",
    }])).toThrow("Migrations must be non-empty and ordered contiguously from version 1.");
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get();
    expect(table).toBeUndefined();
    database.close();
  });

  it("refuses a symbolic-link database path", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.db");
    const link = join(directory, "linked.db");
    await writeFile(target, "");
    await symlink(target, link);

    await expect(openStore({ path: link })).rejects.toThrow(
      "Choose a BORG_SERVER_DATA_DIR path that contains no symbolic links.",
    );
  });

  it("refuses a symbolic-link ancestor without following it", async () => {
    const directory = await temporaryDirectory();
    const safe = join(directory, "safe");
    const attacker = join(directory, "attacker");
    await mkdir(safe);
    await mkdir(join(attacker, "nested"), { recursive: true });
    await symlink(attacker, join(safe, "link"));

    await expect(openStore({
      path: join(safe, "link", "nested", "borg.db"),
    })).rejects.toThrow("Choose a BORG_SERVER_DATA_DIR path that contains no symbolic links.");
    await expect(access(join(attacker, "nested", "borg.db"))).rejects.toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "borg-server-store-"));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
}

function replaceMigrationRows(
  database: DatabaseSync,
  rows: readonly PublishedMigrationRow[],
): void {
  database.exec("DELETE FROM schema_migrations");
  const insert = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const [version, name, checksum] of rows) {
    insert.run(version, name, checksum, "2026-07-29T00:00:00.000Z");
  }
}
