import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

type FoundationTestDatabase = BattlefieldDatabase;

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ALPHA = "11111111-1111-4111-8111-111111111111";
const TENANT_BETA = "22222222-2222-4222-8222-222222222222";
const ORG_ALPHA = "33333333-3333-4333-8333-333333333333";
const USER_ALPHA = "44444444-4444-4444-8444-444444444444";

describe("0001_foundation migration", () => {
  let database: DatabaseHandle<FoundationTestDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<FoundationTestDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates the tenant and identity tables on a clean database", async () => {
    const result = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = 'app'
      order by table_name
    `.execute(database.db);

    expect(result.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "channel_addresses",
        "org_units",
        "tenants",
        "user_memberships",
        "users",
      ]),
    );
  });

  test("rejects an org parent from another tenant", async () => {
    await insertTenant(database, TENANT_ALPHA, "alpha");
    await insertTenant(database, TENANT_BETA, "beta");
    await sql`
      insert into app.org_units (tenant_id, id, code, name, unit_type)
      values (${TENANT_ALPHA}::uuid, ${ORG_ALPHA}::uuid, 'north', '北区销售', 'sales_team')
    `.execute(database.db);

    await expect(
      sql`
        insert into app.org_units (
          tenant_id,
          id,
          code,
          name,
          unit_type,
          parent_id
        ) values (
          ${TENANT_BETA}::uuid,
          '55555555-5555-4555-8555-555555555555'::uuid,
          'invalid-child',
          '错误跨租户团队',
          'sales_team',
          ${ORG_ALPHA}::uuid
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });

  test("allows only one current membership for the same user team and role", async () => {
    await seedMembershipPrincipals(database);
    await insertMembership(
      database,
      "55555555-5555-4555-8555-555555555551",
      null,
    );

    await expect(
      insertMembership(database, "55555555-5555-4555-8555-555555555552", null),
    ).rejects.toThrow();
  });

  test("keeps ended membership history while allowing a new current membership", async () => {
    await seedMembershipPrincipals(database);
    await insertMembership(
      database,
      "55555555-5555-4555-8555-555555555553",
      "2026-08-01T00:00:00.000Z",
    );
    await insertMembership(
      database,
      "55555555-5555-4555-8555-555555555554",
      null,
    );

    const result = await sql<{ count: number }>`
      select count(*)::int as count
      from app.user_memberships
      where tenant_id = ${TENANT_ALPHA}::uuid
        and user_id = ${USER_ALPHA}::uuid
        and org_unit_id = ${ORG_ALPHA}::uuid
        and role_code = 'sales'
    `.execute(database.db);

    expect(result.rows[0]?.count).toBe(2);
  });
});

async function insertTenant(
  database: DatabaseHandle<FoundationTestDatabase>,
  tenantId: string,
  slug: string,
): Promise<void> {
  await sql`
    insert into app.tenants (id, slug, name)
    values (${tenantId}::uuid, ${slug}, ${slug})
  `.execute(database.db);
}

async function seedMembershipPrincipals(
  database: DatabaseHandle<FoundationTestDatabase>,
): Promise<void> {
  await insertTenant(database, TENANT_ALPHA, "alpha");
  await sql`
    insert into app.org_units (tenant_id, id, code, name, unit_type)
    values (${TENANT_ALPHA}::uuid, ${ORG_ALPHA}::uuid, 'north', '北区销售', 'sales_team')
  `.execute(database.db);
  await sql`
    insert into app.users (tenant_id, id, display_name, email)
    values (${TENANT_ALPHA}::uuid, ${USER_ALPHA}::uuid, '演示销售', 'sales@example.test')
  `.execute(database.db);
}

async function insertMembership(
  database: DatabaseHandle<FoundationTestDatabase>,
  membershipId: string,
  validTo: string | null,
): Promise<void> {
  await sql`
    insert into app.user_memberships (
      tenant_id,
      id,
      user_id,
      org_unit_id,
      role_code,
      valid_from,
      valid_to
    ) values (
      ${TENANT_ALPHA}::uuid,
      ${membershipId}::uuid,
      ${USER_ALPHA}::uuid,
      ${ORG_ALPHA}::uuid,
      'sales',
      '2026-07-01T00:00:00.000Z'::timestamptz,
      ${validTo}::timestamptz
    )
  `.execute(database.db);
}
