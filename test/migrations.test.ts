import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, STORE_MIGRATIONS, type Migration } from "../src/migrations.js";
import { openStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("SQLite migrations", () => {
  it("creates a private WAL database and reopens at the same ordered schema", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "data", "borg.db");
    const first = await openStore({ path: databasePath });

    expect(first.diagnostics()).toEqual({
      journalMode: "wal",
      foreignKeys: true,
      schemaVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    expect((await stat(join(directory, "data"))).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${databasePath}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${databasePath}-shm`)).mode & 0o777).toBe(0o600);
    first.close();

    const second = await openStore({ path: databasePath });
    expect(second.diagnostics().schemaVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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

    applyMigrations(database, STORE_MIGRATIONS);

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
