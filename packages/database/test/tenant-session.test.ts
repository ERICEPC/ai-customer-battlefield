import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import { migrateDatabase } from "../src/migrate.js";
import {
  InvalidActorDatabaseContextError,
  withTenantTransaction,
} from "../src/tenant-session.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

interface TenantSessionTestDatabase {
  "app.tenants": {
    id: string;
    name: string;
    slug: string;
    status: string;
    created_at: Date;
    updated_at: Date;
  };
}

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ALPHA = "11111111-1111-4111-8111-111111111111";
const TENANT_BETA = "22222222-2222-4222-8222-222222222222";
const USER_ALPHA = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const TEST_RUNTIME_ROLE = "battlefield_test_runtime";

describe("withTenantTransaction", () => {
  let database: DatabaseHandle<TenantSessionTestDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<TenantSessionTestDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await sql`
      insert into app.tenants (id, slug, name)
      values
        (${TENANT_ALPHA}::uuid, 'alpha', '甲租户'),
        (${TENANT_BETA}::uuid, 'beta', '乙租户')
    `.execute(database.db);
    await sql
      .raw(`create role ${TEST_RUNTIME_ROLE} nologin`)
      .execute(database.db);
    await sql
      .raw(`grant usage on schema app to ${TEST_RUNTIME_ROLE}`)
      .execute(database.db);
    await sql
      .raw(`grant select on app.tenants to ${TEST_RUNTIME_ROLE}`)
      .execute(database.db);
  });

  afterEach(async () => {
    await database.close();
  });

  test("fails closed without context and exposes only the matching tenant", async () => {
    await sql.raw(`set role ${TEST_RUNTIME_ROLE}`).execute(database.db);

    try {
      const withoutContext = await sql<{ id: string }>`
        select id::text as id from app.tenants order by id
      `.execute(database.db);
      const withinContext = await withTenantTransaction(
        database.db,
        {
          tenantId: TENANT_ALPHA,
          userId: USER_ALPHA,
          requestId: REQUEST_ID,
        },
        (transaction) =>
          sql<{ id: string }>`
            select id::text as id from app.tenants order by id
          `.execute(transaction),
      );

      expect(withoutContext.rows).toEqual([]);
      expect(withinContext.rows).toEqual([{ id: TENANT_ALPHA }]);
    } finally {
      await sql.raw("reset role").execute(database.db);
    }
  });

  test("rejects malformed actor IDs before invoking business work", async () => {
    let workInvoked = false;

    await expect(
      withTenantTransaction(
        database.db,
        {
          tenantId: "not-a-uuid",
          userId: USER_ALPHA,
          requestId: REQUEST_ID,
        },
        async () => {
          workInvoked = true;
        },
      ),
    ).rejects.toBeInstanceOf(InvalidActorDatabaseContextError);
    expect(workInvoked).toBe(false);
  });
});
