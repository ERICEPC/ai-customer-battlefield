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
const TENANT_BETA = "20000000-0000-4000-8000-000000000001";
const USER_ALPHA = "30000000-0000-4000-8000-000000000001";
const USER_BETA = "30000000-0000-4000-8000-000000000002";
const USER_GAMMA = "30000000-0000-4000-8000-000000000003";
const TYPE_ALPHA = "40000000-0000-4000-8000-000000000001";
const TYPE_BETA = "40000000-0000-4000-8000-000000000002";
const ENTITY_ALPHA = "50000000-0000-4000-8000-000000000001";
const ENTITY_BETA = "50000000-0000-4000-8000-000000000002";
const CONTACT_ALPHA = "60000000-0000-4000-8000-000000000001";
const CONTACT_BETA = "60000000-0000-4000-8000-000000000002";
const OPPORTUNITY_ALPHA = "70000000-0000-4000-8000-000000000001";

describe("0002_customer_operations migration", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
  });

  afterEach(async () => {
    await database.close();
  });

  test("rejects cross-tenant affiliations and opportunity entity references", async () => {
    await seedTenant(database, TENANT_ALPHA, "alpha");
    await seedTenant(database, TENANT_BETA, "beta");
    await seedEntityType(database, TENANT_ALPHA, TYPE_ALPHA, "customer");
    await seedEntityType(database, TENANT_BETA, TYPE_BETA, "customer");
    await seedEntity(
      database,
      TENANT_ALPHA,
      ENTITY_ALPHA,
      TYPE_ALPHA,
      "甲客户",
    );
    await seedContact(database, TENANT_BETA, CONTACT_BETA, "乙联系人");

    await expect(
      insertAffiliation(
        database,
        TENANT_ALPHA,
        "61000000-0000-4000-8000-000000000001",
        CONTACT_BETA,
        ENTITY_ALPHA,
        null,
      ),
    ).rejects.toThrow();

    await expect(
      insertOpportunity(
        database,
        TENANT_BETA,
        "70000000-0000-4000-8000-000000000002",
        ENTITY_ALPHA,
        true,
      ),
    ).rejects.toThrow();
  });

  test("enables and forces RLS on every customer-operation table", async () => {
    const result = await sql<{ protected_count: number; total_count: number }>`
      select
        count(*) filter (where class.relrowsecurity and class.relforcerowsecurity)::int
          as protected_count,
        count(*)::int as total_count
      from pg_class as class
      inner join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'app'
        and class.relname in (
          'business_entity_types',
          'business_entities',
          'entity_assignments',
          'contacts',
          'contact_affiliations',
          'opportunities',
          'opportunity_assignments',
          'opportunity_stage_history'
        )
    `.execute(database.db);

    expect(result.rows[0]).toEqual({ protected_count: 8, total_count: 8 });
  });

  test("allows collaborators but only one current primary entity owner", async () => {
    await seedEntityPrincipals(database);
    await insertEntityAssignment(
      database,
      "80000000-0000-4000-8000-000000000001",
      USER_ALPHA,
      "collaborator",
      false,
    );
    await insertEntityAssignment(
      database,
      "80000000-0000-4000-8000-000000000002",
      USER_BETA,
      "collaborator",
      false,
    );
    await insertEntityAssignment(
      database,
      "80000000-0000-4000-8000-000000000003",
      USER_ALPHA,
      "owner",
      true,
    );

    await expect(
      insertEntityAssignment(
        database,
        "80000000-0000-4000-8000-000000000004",
        USER_GAMMA,
        "owner",
        true,
      ),
    ).rejects.toThrow();

    const result = await sql<{ count: number }>`
      select count(*)::int as count
      from app.entity_assignments
      where tenant_id = ${TENANT_ALPHA}::uuid
        and entity_id = ${ENTITY_ALPHA}::uuid
        and assignment_role = 'collaborator'
        and valid_to is null
    `.execute(database.db);
    expect(result.rows[0]?.count).toBe(2);
  });

  test("allows several opportunities but only one open primary opportunity", async () => {
    await seedEntityPrincipals(database);
    await insertOpportunity(
      database,
      TENANT_ALPHA,
      OPPORTUNITY_ALPHA,
      ENTITY_ALPHA,
      true,
    );
    await insertOpportunity(
      database,
      TENANT_ALPHA,
      "70000000-0000-4000-8000-000000000002",
      ENTITY_ALPHA,
      false,
    );

    await expect(
      insertOpportunity(
        database,
        TENANT_ALPHA,
        "70000000-0000-4000-8000-000000000003",
        ENTITY_ALPHA,
        true,
      ),
    ).rejects.toThrow();
  });

  test("allows one contact to hold current affiliations with different entities", async () => {
    await seedEntityPrincipals(database);
    await seedEntity(database, TENANT_ALPHA, ENTITY_BETA, TYPE_ALPHA, "乙客户");
    await seedContact(database, TENANT_ALPHA, CONTACT_ALPHA, "跨组织顾问");
    await insertAffiliation(
      database,
      TENANT_ALPHA,
      "61000000-0000-4000-8000-000000000002",
      CONTACT_ALPHA,
      ENTITY_ALPHA,
      null,
    );
    await insertAffiliation(
      database,
      TENANT_ALPHA,
      "61000000-0000-4000-8000-000000000003",
      CONTACT_ALPHA,
      ENTITY_BETA,
      null,
    );

    const result = await sql<{ count: number }>`
      select count(*)::int as count
      from app.contact_affiliations
      where tenant_id = ${TENANT_ALPHA}::uuid
        and contact_id = ${CONTACT_ALPHA}::uuid
        and valid_to is null
    `.execute(database.db);
    expect(result.rows[0]?.count).toBe(2);
  });

  test("prevents duplicate current contact-entity pairs while retaining history", async () => {
    await seedEntityPrincipals(database);
    await seedContact(database, TENANT_ALPHA, CONTACT_ALPHA, "关键联系人");
    await insertAffiliation(
      database,
      TENANT_ALPHA,
      "61000000-0000-4000-8000-000000000004",
      CONTACT_ALPHA,
      ENTITY_ALPHA,
      null,
    );

    await expect(
      insertAffiliation(
        database,
        TENANT_ALPHA,
        "61000000-0000-4000-8000-000000000005",
        CONTACT_ALPHA,
        ENTITY_ALPHA,
        null,
      ),
    ).rejects.toThrow();

    await sql`
      update app.contact_affiliations
      set valid_to = '2026-08-01T00:00:00.000Z'::timestamptz
      where tenant_id = ${TENANT_ALPHA}::uuid
        and id = '61000000-0000-4000-8000-000000000004'::uuid
    `.execute(database.db);
    await insertAffiliation(
      database,
      TENANT_ALPHA,
      "61000000-0000-4000-8000-000000000006",
      CONTACT_ALPHA,
      ENTITY_ALPHA,
      null,
    );

    const result = await sql<{ count: number }>`
      select count(*)::int as count
      from app.contact_affiliations
      where tenant_id = ${TENANT_ALPHA}::uuid
        and contact_id = ${CONTACT_ALPHA}::uuid
        and entity_id = ${ENTITY_ALPHA}::uuid
    `.execute(database.db);
    expect(result.rows[0]?.count).toBe(2);
  });

  test("restricts stage progress to 0-100 and estimated amount to non-negative", async () => {
    await seedEntityPrincipals(database);

    await expect(
      sql`
        insert into app.opportunities (
          tenant_id,
          id,
          entity_id,
          name,
          estimated_amount,
          currency,
          stage_code,
          stage_progress,
          status,
          is_primary
        ) values (
          ${TENANT_ALPHA}::uuid,
          '70000000-0000-4000-8000-000000000004'::uuid,
          ${ENTITY_ALPHA}::uuid,
          '负数金额商机',
          -1,
          'CNY',
          'qualification',
          10,
          'open',
          false
        )
      `.execute(database.db),
    ).rejects.toThrow();

    await expect(
      sql`
        insert into app.opportunities (
          tenant_id,
          id,
          entity_id,
          name,
          estimated_amount,
          currency,
          stage_code,
          stage_progress,
          status,
          is_primary
        ) values (
          ${TENANT_ALPHA}::uuid,
          '70000000-0000-4000-8000-000000000005'::uuid,
          ${ENTITY_ALPHA}::uuid,
          '超范围阶段商机',
          100,
          'CNY',
          'proposal',
          101,
          'open',
          false
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });

  test("appends same-tenant stage history and rejects cross-tenant history", async () => {
    await seedEntityPrincipals(database);
    await insertOpportunity(
      database,
      TENANT_ALPHA,
      OPPORTUNITY_ALPHA,
      ENTITY_ALPHA,
      true,
    );
    await insertStageHistory(
      database,
      TENANT_ALPHA,
      "90000000-0000-4000-8000-000000000001",
      OPPORTUNITY_ALPHA,
      null,
      "qualification",
      10,
    );
    await insertStageHistory(
      database,
      TENANT_ALPHA,
      "90000000-0000-4000-8000-000000000002",
      OPPORTUNITY_ALPHA,
      "qualification",
      "proposal",
      30,
    );

    const result = await sql<{ count: number }>`
      select count(*)::int as count
      from app.opportunity_stage_history
      where tenant_id = ${TENANT_ALPHA}::uuid
        and opportunity_id = ${OPPORTUNITY_ALPHA}::uuid
    `.execute(database.db);
    expect(result.rows[0]?.count).toBe(2);

    await seedTenant(database, TENANT_BETA, "beta");
    await expect(
      insertStageHistory(
        database,
        TENANT_BETA,
        "90000000-0000-4000-8000-000000000003",
        OPPORTUNITY_ALPHA,
        "proposal",
        "negotiation",
        50,
      ),
    ).rejects.toThrow();
  });
});

async function seedTenant(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  slug: string,
): Promise<void> {
  await sql`
    insert into app.tenants (id, slug, name)
    values (${tenantId}::uuid, ${slug}, ${slug})
  `.execute(database.db);
}

async function seedUser(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  userId: string,
  suffix: string,
): Promise<void> {
  await sql`
    insert into app.users (tenant_id, id, display_name, email)
    values (${tenantId}::uuid, ${userId}::uuid, ${suffix}, ${`${suffix}@example.test`})
  `.execute(database.db);
}

async function seedEntityType(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  typeId: string,
  code: string,
): Promise<void> {
  await sql`
    insert into app.business_entity_types (tenant_id, id, code, name)
    values (${tenantId}::uuid, ${typeId}::uuid, ${code}, ${code})
  `.execute(database.db);
}

async function seedEntity(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  entityId: string,
  typeId: string,
  name: string,
): Promise<void> {
  await sql`
    insert into app.business_entities (tenant_id, id, type_id, name)
    values (${tenantId}::uuid, ${entityId}::uuid, ${typeId}::uuid, ${name})
  `.execute(database.db);
}

async function seedContact(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  contactId: string,
  name: string,
): Promise<void> {
  await sql`
    insert into app.contacts (tenant_id, id, display_name)
    values (${tenantId}::uuid, ${contactId}::uuid, ${name})
  `.execute(database.db);
}

async function seedEntityPrincipals(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedTenant(database, TENANT_ALPHA, "alpha");
  await seedUser(database, TENANT_ALPHA, USER_ALPHA, "sales-a");
  await seedUser(database, TENANT_ALPHA, USER_BETA, "sales-b");
  await seedUser(database, TENANT_ALPHA, USER_GAMMA, "sales-c");
  await seedEntityType(database, TENANT_ALPHA, TYPE_ALPHA, "customer");
  await seedEntity(database, TENANT_ALPHA, ENTITY_ALPHA, TYPE_ALPHA, "甲客户");
}

async function insertEntityAssignment(
  database: DatabaseHandle<BattlefieldDatabase>,
  assignmentId: string,
  userId: string,
  role: "owner" | "collaborator" | "management_observer",
  isPrimary: boolean,
): Promise<void> {
  await sql`
    insert into app.entity_assignments (
      tenant_id,
      id,
      entity_id,
      user_id,
      assignment_role,
      is_primary
    ) values (
      ${TENANT_ALPHA}::uuid,
      ${assignmentId}::uuid,
      ${ENTITY_ALPHA}::uuid,
      ${userId}::uuid,
      ${role},
      ${isPrimary}
    )
  `.execute(database.db);
}

async function insertAffiliation(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  affiliationId: string,
  contactId: string,
  entityId: string,
  validTo: string | null,
): Promise<void> {
  await sql`
    insert into app.contact_affiliations (
      tenant_id,
      id,
      contact_id,
      entity_id,
      valid_from,
      valid_to
    ) values (
      ${tenantId}::uuid,
      ${affiliationId}::uuid,
      ${contactId}::uuid,
      ${entityId}::uuid,
      '2026-07-01T00:00:00.000Z'::timestamptz,
      ${validTo}::timestamptz
    )
  `.execute(database.db);
}

async function insertOpportunity(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  opportunityId: string,
  entityId: string,
  isPrimary: boolean,
): Promise<void> {
  await sql`
    insert into app.opportunities (
      tenant_id,
      id,
      entity_id,
      name,
      estimated_amount,
      currency,
      stage_code,
      stage_progress,
      status,
      is_primary
    ) values (
      ${tenantId}::uuid,
      ${opportunityId}::uuid,
      ${entityId}::uuid,
      '演示商机',
      100000,
      'CNY',
      'qualification',
      10,
      'open',
      ${isPrimary}
    )
  `.execute(database.db);
}

async function insertStageHistory(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  historyId: string,
  opportunityId: string,
  fromStageCode: string | null,
  toStageCode: string,
  toProgress: number,
): Promise<void> {
  await sql`
    insert into app.opportunity_stage_history (
      tenant_id,
      id,
      opportunity_id,
      from_stage_code,
      to_stage_code,
      to_progress,
      change_source
    ) values (
      ${tenantId}::uuid,
      ${historyId}::uuid,
      ${opportunityId}::uuid,
      ${fromStageCode},
      ${toStageCode},
      ${toProgress},
      'user'
    )
  `.execute(database.db);
}
