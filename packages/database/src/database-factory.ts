import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import {
  createDatabaseHandle,
  type DatabaseHandle,
  type MigrationDriver,
  type MigrationTransaction,
} from "./database-handle.js";

export interface PostgresDatabaseOptions {
  applicationName?: string;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  maxConnections?: number;
  onPoolError?: (error: Error) => void;
}

export function createPostgresDatabase<Database>(
  connectionString: string,
  options: PostgresDatabaseOptions = {},
): DatabaseHandle<Database> {
  const pool = new Pool({
    connectionString,
    application_name: options.applicationName ?? "ai-customer-battlefield",
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    max: options.maxConnections ?? 10,
  });
  pool.on("error", (error) => {
    options.onPoolError?.(error);
  });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
  const migrations: MigrationDriver = {
    async transaction<Result>(
      work: (transaction: MigrationTransaction) => Promise<Result>,
    ): Promise<Result> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work({
          async query<Row extends Record<string, unknown>>(
            statement: string,
            parameters: readonly unknown[] = [],
          ) {
            const queryResult = await client.query<Row>(statement, [
              ...parameters,
            ]);
            return queryResult.rows;
          },
          async executeScript(script: string) {
            await client.query(script);
          },
        });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };

  return createDatabaseHandle(db, migrations);
}
