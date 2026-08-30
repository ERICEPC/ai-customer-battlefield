import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  MigrationFailedError,
  MigrationHistoryError,
  migrateDatabase,
} from "../src/migrate.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

interface TestDatabase {
  widgets: {
    id: number;
    name: string;
  };
}

describe("migrateDatabase", () => {
  let migrationDirectory: string;

  beforeEach(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "battlefield-migrate-"));
  });

  afterEach(async () => {
    await rm(migrationDirectory, { recursive: true, force: true });
  });

  test("applies a forward SQL migration once", async () => {
    await writeFile(
      join(migrationDirectory, "0001_create_widgets.sql"),
      [
        "create table widgets (id integer primary key, name text not null);",
        "insert into widgets (id, name) values (1, 'first');",
      ].join("\n"),
      "utf8",
    );
    const database = await createPgliteDatabase<TestDatabase>();

    try {
      const firstRun = await migrateDatabase(
        database.migrations,
        migrationDirectory,
      );
      const secondRun = await migrateDatabase(
        database.migrations,
        migrationDirectory,
      );
      const rows = await database.db
        .selectFrom("widgets")
        .selectAll()
        .execute();

      expect(firstRun).toEqual([
        { name: "0001_create_widgets", status: "Success" },
      ]);
      expect(secondRun).toEqual([]);
      expect(rows).toEqual([{ id: 1, name: "first" }]);
    } finally {
      await database.close();
    }
  });

  test("throws a stable error when a migration fails", async () => {
    await writeFile(
      join(migrationDirectory, "0001_invalid.sql"),
      "create table broken (id definitely_not_a_type);",
      "utf8",
    );
    const database = await createPgliteDatabase<TestDatabase>();

    try {
      await expect(
        migrateDatabase(database.migrations, migrationDirectory),
      ).rejects.toBeInstanceOf(MigrationFailedError);
    } finally {
      await database.close();
    }
  });

  test("rejects a changed migration that was already applied", async () => {
    const migrationPath = join(migrationDirectory, "0001_create_widgets.sql");
    await writeFile(
      migrationPath,
      "create table widgets (id integer primary key);",
      "utf8",
    );
    const database = await createPgliteDatabase<TestDatabase>();

    try {
      await migrateDatabase(database.migrations, migrationDirectory);
      await writeFile(
        migrationPath,
        "create table widgets (id integer primary key, changed text);",
        "utf8",
      );

      await expect(
        migrateDatabase(database.migrations, migrationDirectory),
      ).rejects.toBeInstanceOf(MigrationHistoryError);
    } finally {
      await database.close();
    }
  });
});
