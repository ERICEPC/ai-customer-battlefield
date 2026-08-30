import type { MigrationDriver } from "./database-handle.js";
import {
  SqlFileMigrationProvider,
  type SqlMigration,
} from "./migration-provider.js";

export interface MigrationRun {
  name: string;
  status: "Success" | "NotExecuted" | "Error";
}

export class MigrationFailedError extends Error {
  constructor(cause: unknown) {
    super("Database migration failed.", { cause });
    this.name = "MigrationFailedError";
  }
}

export class MigrationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationHistoryError";
  }
}

interface AppliedMigrationRow extends Record<string, unknown> {
  name: string;
  checksum: string;
}

const MIGRATION_LOCK_NAME = "ai-customer-battlefield:migrations";
const CREATE_MIGRATION_LEDGER = `
create schema if not exists app_meta;
create table if not exists app_meta.schema_migrations (
  name text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
`;

export async function migrateDatabase(
  driver: MigrationDriver,
  migrationDirectory: string,
): Promise<MigrationRun[]> {
  const provider = new SqlFileMigrationProvider(migrationDirectory);

  try {
    return await driver.transaction(async (transaction) => {
      await transaction.query("select pg_advisory_xact_lock(hashtext($1))", [
        MIGRATION_LOCK_NAME,
      ]);
      await transaction.executeScript(CREATE_MIGRATION_LEDGER);

      const migrationMap = await provider.getMigrations();
      const migrations = Object.values(migrationMap);
      const appliedRows = await transaction.query<AppliedMigrationRow>(
        "select name, checksum from app_meta.schema_migrations order by name",
      );
      validateMigrationHistory(migrations, appliedRows);

      const appliedNames = new Set(appliedRows.map((row) => row.name));
      const results: MigrationRun[] = [];
      for (const migration of migrations) {
        if (appliedNames.has(migration.name)) {
          continue;
        }

        await transaction.executeScript(migration.sql);
        await transaction.query(
          "insert into app_meta.schema_migrations (name, checksum) values ($1, $2)",
          [migration.name, migration.checksum],
        );
        results.push({ name: migration.name, status: "Success" });
      }

      return results;
    });
  } catch (error) {
    if (error instanceof MigrationHistoryError) {
      throw error;
    }
    throw new MigrationFailedError(error);
  }
}

function validateMigrationHistory(
  migrations: SqlMigration[],
  appliedRows: AppliedMigrationRow[],
): void {
  const available = new Map(
    migrations.map((migration) => [migration.name, migration]),
  );

  for (const applied of appliedRows) {
    const migration = available.get(applied.name);
    if (!migration) {
      throw new MigrationHistoryError(
        `Applied migration ${applied.name} is missing from the repository.`,
      );
    }
    if (migration.checksum !== applied.checksum) {
      throw new MigrationHistoryError(
        `Applied migration ${applied.name} has changed checksum.`,
      );
    }
  }
}
