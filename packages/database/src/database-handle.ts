import type { Kysely } from "kysely";

export interface MigrationTransaction {
  query<Row extends Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<Row[]>;
  executeScript(script: string): Promise<void>;
}

export interface MigrationDriver {
  transaction<Result>(
    work: (transaction: MigrationTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface DatabaseHandle<Database> {
  db: Kysely<Database>;
  migrations: MigrationDriver;
  close(): Promise<void>;
}

export function createDatabaseHandle<Database>(
  db: Kysely<Database>,
  migrations: MigrationDriver,
): DatabaseHandle<Database> {
  let isClosed = false;

  return {
    db,
    migrations,
    async close() {
      if (isClosed) {
        return;
      }
      isClosed = true;
      await db.destroy();
    },
  };
}
