import { sql } from "kysely";

import type { DatabaseHandle } from "../database-handle.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

export const SYNTHETIC_TENANT_ID = "10000000-0000-4000-8000-000000000001";
export const SYNTHETIC_USER_ID = "30000000-0000-4000-8000-000000000001";
export const SYNTHETIC_ENTITY_ID = "50000000-0000-4000-8000-000000000001";
export const SYNTHETIC_OTHER_TENANT_ID = "20000000-0000-4000-8000-000000000001";
export const SYNTHETIC_OTHER_USER_ID = "30000000-0000-4000-8000-000000000002";
export const SYNTHETIC_OTHER_ENTITY_ID = "50000000-0000-4000-8000-000000000002";

const SYNTHETIC_REQUEST_ID = "90000000-0000-4000-8000-000000000001";

export async function seedSyntheticBusinessEntityDirectory(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedTenantEntity(database, {
    tenantId: SYNTHETIC_TENANT_ID,
    userId: SYNTHETIC_USER_ID,
    typeId: "40000000-0000-4000-8000-000000000001",
    entityId: SYNTHETIC_ENTITY_ID,
    slug: "alpha",
    entityName: "Aurora Systems",
  });
  await seedTenantEntity(database, {
    tenantId: SYNTHETIC_OTHER_TENANT_ID,
    userId: SYNTHETIC_OTHER_USER_ID,
    typeId: "40000000-0000-4000-8000-000000000002",
    entityId: SYNTHETIC_OTHER_ENTITY_ID,
    slug: "beta",
    entityName: "Hidden Tenant Entity",
  });
}

async function seedTenantEntity(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    tenantId: string;
    userId: string;
    typeId: string;
    entityId: string;
    slug: string;
    entityName: string;
  },
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: input.tenantId,
      userId: input.userId,
      requestId: SYNTHETIC_REQUEST_ID,
    },
    async (transaction) => {
      await sql`
        insert into app.tenants (id, slug, name)
        values (${input.tenantId}::uuid, ${input.slug}, ${input.slug})
      `.execute(transaction);
      await sql`
        insert into app.users (tenant_id, id, display_name)
        values (
          ${input.tenantId}::uuid,
          ${input.userId}::uuid,
          ${`${input.slug}-owner`}
        )
      `.execute(transaction);
      await sql`
        insert into app.business_entity_types (tenant_id, id, code, name)
        values (${input.tenantId}::uuid, ${input.typeId}::uuid, 'customer', '客户')
      `.execute(transaction);
      await sql`
        insert into app.business_entities (
          tenant_id,
          id,
          type_id,
          name,
          is_t0,
          updated_at
        ) values (
          ${input.tenantId}::uuid,
          ${input.entityId}::uuid,
          ${input.typeId}::uuid,
          ${input.entityName},
          true,
          '2026-08-31T03:00:00.000Z'::timestamptz
        )
      `.execute(transaction);
      await sql`
        insert into app.entity_assignments (
          tenant_id,
          id,
          entity_id,
          user_id,
          assignment_role,
          is_primary
        ) values (
          ${input.tenantId}::uuid,
          gen_random_uuid(),
          ${input.entityId}::uuid,
          ${input.userId}::uuid,
          'owner',
          true
        )
      `.execute(transaction);
      await sql`
        insert into app.opportunities (
          tenant_id,
          id,
          entity_id,
          name,
          stage_code,
          stage_progress,
          status,
          is_primary
        ) values (
          ${input.tenantId}::uuid,
          gen_random_uuid(),
          ${input.entityId}::uuid,
          ${`${input.slug}-primary-opportunity`},
          'proposal',
          30,
          'open',
          true
        )
      `.execute(transaction);
    },
  );
}
