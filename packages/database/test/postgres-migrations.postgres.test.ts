import { fileURLToPath } from "node:url";
import type { BusinessEntityReader } from "@battlefield/core";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { KyselyBusinessEntityReader } from "../src/business-entities/kysely-business-entity-reader.js";
import { createPostgresDatabase } from "../src/database-factory.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import {
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "../src/testing/synthetic-directory.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const DATABASE_URL = process.env.DATABASE_URL;

describe("PostgreSQL migrations", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let reader: BusinessEntityReader;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is required for PostgreSQL integration tests.",
      );
    }
    database = createPostgresDatabase<BattlefieldDatabase>(DATABASE_URL, {
      applicationName: "battlefield-postgres-integration-test",
      maxConnections: 4,
    });
    const databaseName = await sql<{ name: string }>`
      select current_database() as name
    `.execute(database.db);
    if (!databaseName.rows[0]?.name.endsWith("_test")) {
      throw new Error(
        "PostgreSQL integration tests require a *_test database.",
      );
    }

    await resetApplicationSchemas(database);
    reader = new KyselyBusinessEntityReader(database.db);
  });

  afterAll(async () => {
    if (!database) {
      return;
    }
    await resetApplicationSchemas(database);
    await database.close();
  });

  test("rebuilds the schema and serves a tenant-scoped directory", async () => {
    const firstRun = await migrateDatabase(
      database.migrations,
      MIGRATION_DIRECTORY,
    );
    const secondRun = await migrateDatabase(
      database.migrations,
      MIGRATION_DIRECTORY,
    );
    await seedSyntheticBusinessEntityDirectory(database);
    const page = await reader.list({
      actor: { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID },
      limit: 20,
    });
    const rlsState = await sql<{
      protected_count: number;
      total_count: number;
    }>`
      select
        count(*) filter (where class.relrowsecurity and class.relforcerowsecurity)::int
          as protected_count,
        count(*)::int as total_count
      from pg_class as class
      inner join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'app'
        and class.relkind = 'r'
    `.execute(database.db);

    expect(firstRun.map((migration) => migration.name)).toEqual([
      "0001_foundation",
      "0002_customer_operations",
    ]);
    expect(secondRun).toEqual([]);
    expect(rlsState.rows[0]).toEqual({ protected_count: 13, total_count: 13 });
    expect(page.items.map((item) => item.id)).toEqual([SYNTHETIC_ENTITY_ID]);
  });
});

async function resetApplicationSchemas(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`drop schema if exists app cascade`.execute(database.db);
  await sql`drop schema if exists app_meta cascade`.execute(database.db);
}
