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

describe("0009_user_ai_settings migration", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates a force-RLS protected per-user settings table", async () => {
    const result = await sql<{
      row_security: boolean;
      force_row_security: boolean;
    }>`
      select
        class.relrowsecurity as row_security,
        class.relforcerowsecurity as force_row_security
      from pg_class as class
      inner join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'app'
        and class.relname = 'user_ai_settings'
    `.execute(database.db);

    expect(result.rows).toEqual([
      { row_security: true, force_row_security: true },
    ]);
  });

  test("requires all encrypted API key fields to be present or absent together", async () => {
    await seedUser(database);
    await expect(
      sql`
        insert into app.user_ai_settings (
          tenant_id, user_id, provider, model_id, api_key_ciphertext
        ) values (
          '10000000-0000-4000-8000-000000000001'::uuid,
          '30000000-0000-4000-8000-000000000001'::uuid,
          'senseaudio',
          'senseaudio-s2-flash',
          'ciphertext-only'
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
    values ('10000000-0000-4000-8000-000000000001'::uuid, 'alpha', 'Alpha')
  `.execute(database.db);
  await sql`
    insert into app.users (tenant_id, id, display_name, email)
    values (
      '10000000-0000-4000-8000-000000000001'::uuid,
      '30000000-0000-4000-8000-000000000001'::uuid,
      '销售1',
      'sales1@demo.local'
    )
  `.execute(database.db);
}
