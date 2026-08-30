import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect } from "kysely";

import {
  createDatabaseHandle,
  type DatabaseHandle,
  type MigrationDriver,
} from "../database-handle.js";

export async function createPgliteDatabase<Database>(): Promise<
  DatabaseHandle<Database>
> {
  const pglite = await PGlite.create({ dataDir: "memory://" });
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite }),
  });
  const migrations: MigrationDriver = {
    transaction: (work) =>
      pglite.transaction((transaction) =>
        work({
          async query<Row extends Record<string, unknown>>(
            statement: string,
            parameters: readonly unknown[] = [],
          ) {
            const result = await transaction.query<Row>(statement, [
              ...parameters,
            ]);
            return result.rows;
          },
          async executeScript(script: string) {
            await transaction.exec(script);
          },
        }),
      ),
  };

  return createDatabaseHandle(db, migrations);
}
