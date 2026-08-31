import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ALPHA = "10000000-0000-4000-8000-000000000001";
const USER_ALPHA = "30000000-0000-4000-8000-000000000001";

describe("two-level identity migrations", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates and force-protects credential and session tables", async () => {
    const result = await sql<{
      table_name: string;
      row_security: boolean;
      force_row_security: boolean;
    }>`
      select
        class.relname as table_name,
        class.relrowsecurity as row_security,
        class.relforcerowsecurity as force_row_security
      from pg_class as class
      inner join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'app'
        and class.relname in ('user_credentials', 'user_sessions')
      order by class.relname
    `.execute(database.db);

    expect(result.rows).toEqual([
      {
        table_name: "user_credentials",
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: "user_sessions",
        row_security: true,
        force_row_security: true,
      },
    ]);
  });

  test("resolves only an active tenant slug before tenant context exists", async () => {
    await sql`
      insert into app.tenants (id, slug, name)
      values (${TENANT_ALPHA}::uuid, 'alpha', 'Alpha')
    `.execute(database.db);

    const active = await sql<{ tenant_id: string | null }>`
      select app.resolve_active_tenant_id(' ALPHA ') as tenant_id
    `.execute(database.db);
    const missing = await sql<{ tenant_id: string | null }>`
      select app.resolve_active_tenant_id('missing') as tenant_id
    `.execute(database.db);

    expect(active.rows[0]?.tenant_id).toBe(TENANT_ALPHA);
    expect(missing.rows[0]?.tenant_id).toBeNull();
  });

  test("publishes active tenants to the isolated login directory", async () => {
    await sql`
      insert into app.tenants (id, slug, name)
      values (${TENANT_ALPHA}::uuid, 'alpha', 'Alpha')
    `.execute(database.db);

    const directory = await sql<{ exists: boolean }>`
      select to_regclass('app_auth.tenant_login_directory') is not null as exists
    `.execute(database.db);

    expect(directory.rows[0]?.exists).toBe(true);

    const active = await sql<{ tenant_id: string | null }>`
      select app.resolve_active_tenant_id('alpha') as tenant_id
    `.execute(database.db);
    expect(active.rows[0]?.tenant_id).toBe(TENANT_ALPHA);

    await sql`
      update app.tenants
      set status = 'suspended'
      where id = ${TENANT_ALPHA}::uuid
    `.execute(database.db);
    const suspended = await sql<{ tenant_id: string | null }>`
      select app.resolve_active_tenant_id('alpha') as tenant_id
    `.execute(database.db);
    expect(suspended.rows[0]?.tenant_id).toBeNull();
  });

  test("enforces one credential and one unique session token hash per tenant", async () => {
    await seedUser(database);
    await sql`
      insert into app.user_credentials (tenant_id, user_id, password_hash)
      values (${TENANT_ALPHA}::uuid, ${USER_ALPHA}::uuid, 'scrypt$demo-hash-value')
    `.execute(database.db);
    await expect(
      sql`
        insert into app.user_credentials (tenant_id, user_id, password_hash)
        values (${TENANT_ALPHA}::uuid, ${USER_ALPHA}::uuid, 'scrypt$duplicate-hash-value')
      `.execute(database.db),
    ).rejects.toThrow();

    await sql`
      insert into app.user_sessions (
        tenant_id, id, user_id, token_hash, expires_at
      ) values (
        ${TENANT_ALPHA}::uuid,
        '81000000-0000-4000-8000-000000000001'::uuid,
        ${USER_ALPHA}::uuid,
        ${"a".repeat(64)},
        '2026-09-01T08:00:00.000Z'::timestamptz
      )
    `.execute(database.db);
    await expect(
      sql`
        insert into app.user_sessions (
          tenant_id, id, user_id, token_hash, expires_at
        ) values (
          ${TENANT_ALPHA}::uuid,
          '81000000-0000-4000-8000-000000000002'::uuid,
          ${USER_ALPHA}::uuid,
          ${"a".repeat(64)},
          '2026-09-01T09:00:00.000Z'::timestamptz
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });
});

async function seedUser(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`
    insert into app.tenants (id, slug, name)
    values (${TENANT_ALPHA}::uuid, 'alpha', 'Alpha')
  `.execute(database.db);
  await sql`
    insert into app.users (tenant_id, id, display_name, email)
    values (
      ${TENANT_ALPHA}::uuid,
      ${USER_ALPHA}::uuid,
      '销售1',
      'sales1@demo.local'
    )
  `.execute(database.db);
}
