import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATION_FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface SqlMigration {
  name: string;
  sql: string;
  checksum: string;
}

export class SqlFileMigrationProvider {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async getMigrations(): Promise<Record<string, SqlMigration>> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const filenames = entries
      .filter((entry) => entry.isFile() && MIGRATION_FILENAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    const migrations = await Promise.all(
      filenames.map(async (filename) => {
        const migrationSql = await readFile(
          join(this.#directory, filename),
          "utf8",
        );
        const name = filename.slice(0, -".sql".length);
        const migration: SqlMigration = {
          name,
          sql: migrationSql,
          checksum: createHash("sha256").update(migrationSql).digest("hex"),
        };

        return [name, migration] as const;
      }),
    );

    return Object.fromEntries(migrations);
  }
}
