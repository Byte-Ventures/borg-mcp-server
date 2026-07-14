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

import { applyMigrations, type Migration } from "../src/migrations.js";
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
      schemaVersions: [1],
    });
    expect((await stat(join(directory, "data"))).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${databasePath}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${databasePath}-shm`)).mode & 0o777).toBe(0o600);
    first.close();

    const second = await openStore({ path: databasePath });
    expect(second.diagnostics().schemaVersions).toEqual([1]);
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
      "Database path must not contain symbolic links.",
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
    })).rejects.toThrow("Database path must not contain symbolic links.");
    await expect(access(join(attacker, "nested", "borg.db"))).rejects.toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "borg-server-store-"));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
}
