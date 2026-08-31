import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const ALPHA_TENANT_ID = "10000000-0000-4000-8000-000000000001";
const BETA_TENANT_ID = "20000000-0000-4000-8000-000000000001";
const ACTOR_ID = "30000000-0000-4000-8000-000000000001";
const REQUEST_ID = "90000000-0000-4000-8000-000000000214";
const TEST_RUNTIME_ROLE = "battlefield_capability_test_runtime";
const expectedCapabilities = [
  "access_control.manage",
  "ai_runtime_config.manage",
  "audit.read",
  "management_query.execute",
  "worker_operations.manage",
];

describe("management capability migration", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates a fixed capability catalog and tenant role grants", async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = 'app'
        and table_name in ('management_capabilities', 'role_capability_grants')
      order by table_name
    `.execute(database.db);

    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "management_capabilities",
      "role_capability_grants",
    ]);
  });

  test("seeds only the leader defaults for each tenant and isolates them with RLS", async () => {
    await seedTenant(ALPHA_TENANT_ID, "alpha");
    await seedTenant(BETA_TENANT_ID, "beta");
    await sql
      .raw(`create role ${TEST_RUNTIME_ROLE} nologin`)
      .execute(database.db);
    await sql
      .raw(`grant usage on schema app to ${TEST_RUNTIME_ROLE}`)
      .execute(database.db);
    await sql
      .raw(
        `grant select on app.management_capabilities, app.role_capability_grants to ${TEST_RUNTIME_ROLE}`,
      )
      .execute(database.db);
    await sql.raw(`set role ${TEST_RUNTIME_ROLE}`).execute(database.db);

    try {
      const alpha = await withTenantTransaction(
        database.db,
        {
          tenantId: ALPHA_TENANT_ID,
          userId: ACTOR_ID,
          requestId: REQUEST_ID,
        },
        async (transaction) => ({
          catalog: await transaction
            .selectFrom("app.management_capabilities")
            .select("code")
            .orderBy("code")
            .execute(),
          grants: await transaction
            .selectFrom("app.role_capability_grants")
            .select(["tenant_id", "role_code", "capability_code"])
            .orderBy("capability_code")
            .execute(),
        }),
      );

      expect(alpha.catalog.map((row) => row.code)).toEqual(
        expectedCapabilities,
      );
      expect(alpha.grants).toEqual(
        expectedCapabilities.map((capabilityCode) => ({
          tenant_id: ALPHA_TENANT_ID,
          role_code: "department_leader",
          capability_code: capabilityCode,
        })),
      );
      expect(alpha.grants).not.toContainEqual(
        expect.objectContaining({ tenant_id: BETA_TENANT_ID }),
      );
      expect(alpha.grants).not.toContainEqual(
        expect.objectContaining({ role_code: "sales" }),
      );
    } finally {
      await sql.raw("reset role").execute(database.db);
    }
  });

  async function seedTenant(tenantId: string, slug: string): Promise<void> {
    await withTenantTransaction(
      database.db,
      { tenantId, userId: ACTOR_ID, requestId: REQUEST_ID },
      (transaction) =>
        transaction
          .insertInto("app.tenants")
          .values({ id: tenantId, slug, name: slug })
          .executeTakeFirstOrThrow(),
    );
  }
});
