import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SqlFileMigrationProvider } from "../src/migration-provider.js";

describe("SqlFileMigrationProvider", () => {
  let migrationDirectory: string;

  beforeEach(async () => {
    migrationDirectory = await mkdtemp(
      join(tmpdir(), "battlefield-migrations-"),
    );
  });

  afterEach(async () => {
    await rm(migrationDirectory, { recursive: true, force: true });
  });

  test("returns valid SQL migrations in filename order", async () => {
    await writeFile(
      join(migrationDirectory, "0002_second.sql"),
      "select 2;",
      "utf8",
    );
    await writeFile(
      join(migrationDirectory, "0001_first.sql"),
      "select 1;",
      "utf8",
    );
    await writeFile(
      join(migrationDirectory, "notes.md"),
      "not a migration",
      "utf8",
    );

    const provider = new SqlFileMigrationProvider(migrationDirectory);

    const migrations = await provider.getMigrations();

    expect(Object.keys(migrations)).toEqual(["0001_first", "0002_second"]);
  });

  test("ignores SQL files that do not follow the versioned naming rule", async () => {
    await writeFile(
      join(migrationDirectory, "draft.sql"),
      "select 'unsafe';",
      "utf8",
    );
    await writeFile(
      join(migrationDirectory, "0001_safe.sql"),
      "select 'safe';",
      "utf8",
    );

    const provider = new SqlFileMigrationProvider(migrationDirectory);

    const migrations = await provider.getMigrations();

    expect(Object.keys(migrations)).toEqual(["0001_safe"]);
  });
});
