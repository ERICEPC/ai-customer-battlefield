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
const TYPE_ALPHA = "40000000-0000-4000-8000-000000000001";
const TYPE_BETA = "40000000-0000-4000-8000-000000000002";
const ENTITY_ALPHA = "50000000-0000-4000-8000-000000000001";
const ENTITY_BETA = "50000000-0000-4000-8000-000000000002";
const CONTACT_ALPHA = "60000000-0000-4000-8000-000000000001";
const OPPORTUNITY_ALPHA = "70000000-0000-4000-8000-000000000001";
const OPPORTUNITY_ALPHA_SECONDARY = "70000000-0000-4000-8000-000000000002";
const SOURCE_ALPHA = "80000000-0000-4000-8000-000000000001";
const DRAFT_ALPHA = "81000000-0000-4000-8000-000000000001";
const FOLLOWUP_ALPHA = "82000000-0000-4000-8000-000000000001";
const FACT_ALPHA = "83000000-0000-4000-8000-000000000001";
const EVIDENCE_ALPHA = "84000000-0000-4000-8000-000000000001";

describe("0003_followup_confirmation migration", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates and force-protects every follow-up confirmation table", async () => {
    const tables = [
      "audit_entries",
      "business_facts",
      "domain_events",
      "draft_revisions",
      "fact_evidence_links",
      "followup_corrections",
      "followup_drafts",
      "followup_opportunities",
      "followup_participants",
      "followups",
      "idempotency_records",
      "outbox_messages",
      "source_evidence",
      "source_inputs",
    ];
    const result = await sql<{
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
        and class.relname in (${sql.join(tables)})
    `.execute(database.db);

    expect(result.rows[0]).toEqual({ protected_count: 14, total_count: 14 });
  });

  test("rejects cross-tenant draft, opportunity, and evidence relations", async () => {
    await seedPrincipals(database);
    await insertSource(database, TENANT_ALPHA, SOURCE_ALPHA, USER_ALPHA);

    await expect(
      insertDraft(
        database,
        TENANT_BETA,
        DRAFT_ALPHA,
        SOURCE_ALPHA,
        ENTITY_BETA,
      ),
    ).rejects.toThrow();

    await insertDraft(
      database,
      TENANT_ALPHA,
      DRAFT_ALPHA,
      SOURCE_ALPHA,
      ENTITY_ALPHA,
    );
    await insertFollowup(database);
    await expect(
      sql`
        insert into app.followup_opportunities (
          tenant_id, followup_id, opportunity_id, is_primary
        ) values (
          ${TENANT_BETA}::uuid,
          ${FOLLOWUP_ALPHA}::uuid,
          ${OPPORTUNITY_ALPHA}::uuid,
          true
        )
      `.execute(database.db),
    ).rejects.toThrow();

    await insertFact(database, FACT_ALPHA);
    await sql`
      insert into app.source_evidence (
        tenant_id, id, source_input_id, source_type, content_hash, captured_at
      ) values (
        ${TENANT_ALPHA}::uuid,
        ${EVIDENCE_ALPHA}::uuid,
        ${SOURCE_ALPHA}::uuid,
        'web',
        repeat('a', 64),
        '2026-08-31T02:30:00.000Z'::timestamptz
      )
    `.execute(database.db);
    await expect(
      sql`
        insert into app.fact_evidence_links (
          tenant_id, fact_id, evidence_id, relation_type
        ) values (
          ${TENANT_BETA}::uuid,
          ${FACT_ALPHA}::uuid,
          ${EVIDENCE_ALPHA}::uuid,
          'supports'
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });

  test("allows one draft per source and constrains draft state and version", async () => {
    await seedAlphaPrincipals(database);
    await insertSource(database, TENANT_ALPHA, SOURCE_ALPHA, USER_ALPHA);
    await insertDraft(
      database,
      TENANT_ALPHA,
      DRAFT_ALPHA,
      SOURCE_ALPHA,
      ENTITY_ALPHA,
    );

    await expect(
      insertDraft(
        database,
        TENANT_ALPHA,
        "81000000-0000-4000-8000-000000000002",
        SOURCE_ALPHA,
        ENTITY_ALPHA,
      ),
    ).rejects.toThrow();
    await expect(
      sql`
        update app.followup_drafts
        set status = 'published'
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${DRAFT_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      sql`
        update app.followup_drafts
        set version_no = 0
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${DRAFT_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
  });

  test("keeps positive, unique revisions for a draft", async () => {
    await seedDraft(database);
    await insertRevision(database, "85000000-0000-4000-8000-000000000001", 1);

    await expect(
      insertRevision(database, "85000000-0000-4000-8000-000000000002", 1),
    ).rejects.toThrow();
    await expect(
      insertRevision(database, "85000000-0000-4000-8000-000000000003", 0),
    ).rejects.toThrow();
  });

  test("requires exactly one user or contact participant", async () => {
    await seedConfirmedFollowup(database);

    await sql`
      insert into app.followup_participants (
        tenant_id, id, followup_id, user_id, participant_role
      ) values (
        ${TENANT_ALPHA}::uuid,
        '86000000-0000-4000-8000-000000000001'::uuid,
        ${FOLLOWUP_ALPHA}::uuid,
        ${USER_ALPHA}::uuid,
        'sales_owner'
      )
    `.execute(database.db);
    await expect(
      sql`
        insert into app.followup_participants (
          tenant_id, id, followup_id, user_id, contact_id, participant_role
        ) values (
          ${TENANT_ALPHA}::uuid,
          '86000000-0000-4000-8000-000000000002'::uuid,
          ${FOLLOWUP_ALPHA}::uuid,
          ${USER_ALPHA}::uuid,
          ${CONTACT_ALPHA}::uuid,
          'participant'
        )
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      sql`
        insert into app.followup_participants (
          tenant_id, id, followup_id, participant_role
        ) values (
          ${TENANT_ALPHA}::uuid,
          '86000000-0000-4000-8000-000000000003'::uuid,
          ${FOLLOWUP_ALPHA}::uuid,
          'participant'
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });

  test("allows at most one primary opportunity and requires one for multiple links", async () => {
    await seedConfirmedFollowup(database);

    await database.db.transaction().execute(async (transaction) => {
      await sql`
        insert into app.followup_opportunities (
          tenant_id, followup_id, opportunity_id, is_primary
        ) values
          (${TENANT_ALPHA}::uuid, ${FOLLOWUP_ALPHA}::uuid, ${OPPORTUNITY_ALPHA}::uuid, true),
          (${TENANT_ALPHA}::uuid, ${FOLLOWUP_ALPHA}::uuid, ${OPPORTUNITY_ALPHA_SECONDARY}::uuid, false)
      `.execute(transaction);
    });
    await expect(
      sql`
        update app.followup_opportunities
        set is_primary = true
        where tenant_id = ${TENANT_ALPHA}::uuid
          and followup_id = ${FOLLOWUP_ALPHA}::uuid
          and opportunity_id = ${OPPORTUNITY_ALPHA_SECONDARY}::uuid
      `.execute(database.db),
    ).rejects.toThrow();

    await seedDraft(database, {
      sourceId: "80000000-0000-4000-8000-000000000002",
      draftId: "81000000-0000-4000-8000-000000000002",
    });
    await insertFollowup(database, {
      followupId: "82000000-0000-4000-8000-000000000002",
      sourceId: "80000000-0000-4000-8000-000000000002",
      draftId: "81000000-0000-4000-8000-000000000002",
    });
    await expect(
      database.db.transaction().execute(async (transaction) => {
        await sql`
          insert into app.followup_opportunities (
            tenant_id, followup_id, opportunity_id, is_primary
          ) values
            (${TENANT_ALPHA}::uuid, '82000000-0000-4000-8000-000000000002'::uuid, ${OPPORTUNITY_ALPHA}::uuid, false),
            (${TENANT_ALPHA}::uuid, '82000000-0000-4000-8000-000000000002'::uuid, ${OPPORTUNITY_ALPHA_SECONDARY}::uuid, false)
        `.execute(transaction);
      }),
    ).rejects.toThrow();
  });

  test("allows a fact to be superseded only once", async () => {
    await seedConfirmedFollowup(database);
    await insertFact(database, FACT_ALPHA);
    await insertFact(
      database,
      "83000000-0000-4000-8000-000000000002",
      FACT_ALPHA,
    );

    await expect(
      insertFact(database, "83000000-0000-4000-8000-000000000003", FACT_ALPHA),
    ).rejects.toThrow();
  });

  test("deduplicates idempotent operations and Outbox messages per tenant", async () => {
    await seedAlphaPrincipals(database);
    await insertIdempotency(database, "87000000-0000-4000-8000-000000000001");
    await expect(
      insertIdempotency(database, "87000000-0000-4000-8000-000000000002"),
    ).rejects.toThrow();

    await sql`
      insert into app.domain_events (
        tenant_id, id, aggregate_type, aggregate_id, event_type, event_version,
        payload, occurred_at
      ) values (
        ${TENANT_ALPHA}::uuid,
        '88000000-0000-4000-8000-000000000001'::uuid,
        'followup',
        ${FOLLOWUP_ALPHA}::uuid,
        'followup.confirmed.v1',
        1,
        '{}'::jsonb,
        '2026-08-31T02:35:00.000Z'::timestamptz
      )
    `.execute(database.db);
    await insertOutbox(database, "89000000-0000-4000-8000-000000000001");
    await expect(
      insertOutbox(database, "89000000-0000-4000-8000-000000000002"),
    ).rejects.toThrow();
  });
});

async function seedPrincipals(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedTenantPrincipals(database, {
    tenantId: TENANT_ALPHA,
    userId: USER_ALPHA,
    typeId: TYPE_ALPHA,
    entityId: ENTITY_ALPHA,
    slug: "alpha",
  });
  await seedTenantPrincipals(database, {
    tenantId: TENANT_BETA,
    userId: USER_BETA,
    typeId: TYPE_BETA,
    entityId: ENTITY_BETA,
    slug: "beta",
  });
}

async function seedAlphaPrincipals(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedTenantPrincipals(database, {
    tenantId: TENANT_ALPHA,
    userId: USER_ALPHA,
    typeId: TYPE_ALPHA,
    entityId: ENTITY_ALPHA,
    slug: "alpha",
  });
}

async function seedTenantPrincipals(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    tenantId: string;
    userId: string;
    typeId: string;
    entityId: string;
    slug: string;
  },
): Promise<void> {
  await sql`
    insert into app.tenants (id, slug, name)
    values (${input.tenantId}::uuid, ${input.slug}, ${input.slug})
  `.execute(database.db);
  await sql`
    insert into app.users (tenant_id, id, display_name)
    values (${input.tenantId}::uuid, ${input.userId}::uuid, ${`${input.slug}-user`})
  `.execute(database.db);
  await sql`
    insert into app.business_entity_types (tenant_id, id, code, name)
    values (${input.tenantId}::uuid, ${input.typeId}::uuid, 'customer', '客户')
  `.execute(database.db);
  await sql`
    insert into app.business_entities (tenant_id, id, type_id, name)
    values (${input.tenantId}::uuid, ${input.entityId}::uuid, ${input.typeId}::uuid, ${`${input.slug}-entity`})
  `.execute(database.db);
  await sql`
    insert into app.opportunities (
      tenant_id, id, entity_id, name, stage_code, stage_progress, is_primary
    ) values
      (${input.tenantId}::uuid, ${input.tenantId === TENANT_ALPHA ? OPPORTUNITY_ALPHA : "70000000-0000-4000-8000-000000000003"}::uuid, ${input.entityId}::uuid, '主商机', 'proposal', 30, true)
  `.execute(database.db);
  if (input.tenantId === TENANT_ALPHA) {
    await sql`
      insert into app.opportunities (
        tenant_id, id, entity_id, name, stage_code, stage_progress, is_primary
      ) values (
        ${TENANT_ALPHA}::uuid,
        ${OPPORTUNITY_ALPHA_SECONDARY}::uuid,
        ${ENTITY_ALPHA}::uuid,
        '次商机',
        'qualification',
        10,
        false
      )
    `.execute(database.db);
    await sql`
      insert into app.contacts (tenant_id, id, display_name)
      values (${TENANT_ALPHA}::uuid, ${CONTACT_ALPHA}::uuid, '关键联系人')
    `.execute(database.db);
  }
}

async function seedDraft(
  database: DatabaseHandle<BattlefieldDatabase>,
  ids: { sourceId?: string; draftId?: string } = {},
): Promise<void> {
  if (ids.sourceId || ids.draftId) {
    await insertSource(
      database,
      TENANT_ALPHA,
      ids.sourceId ?? SOURCE_ALPHA,
      USER_ALPHA,
    );
    await insertDraft(
      database,
      TENANT_ALPHA,
      ids.draftId ?? DRAFT_ALPHA,
      ids.sourceId ?? SOURCE_ALPHA,
      ENTITY_ALPHA,
    );
    return;
  }
  await seedAlphaPrincipals(database);
  await insertSource(database, TENANT_ALPHA, SOURCE_ALPHA, USER_ALPHA);
  await insertDraft(
    database,
    TENANT_ALPHA,
    DRAFT_ALPHA,
    SOURCE_ALPHA,
    ENTITY_ALPHA,
  );
}

async function seedConfirmedFollowup(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedDraft(database);
  await insertFollowup(database);
}

async function insertSource(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  sourceId: string,
  userId: string,
): Promise<void> {
  await sql`
    insert into app.source_inputs (
      tenant_id, id, source_type, submitted_by, raw_content, content_hash,
      received_at
    ) values (
      ${tenantId}::uuid,
      ${sourceId}::uuid,
      'web',
      ${userId}::uuid,
      '客户确认预算',
      repeat('b', 64),
      '2026-08-31T02:30:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertDraft(
  database: DatabaseHandle<BattlefieldDatabase>,
  tenantId: string,
  draftId: string,
  sourceId: string,
  entityId: string,
): Promise<void> {
  await sql`
    insert into app.followup_drafts (
      tenant_id, id, source_input_id, entity_id, candidate_payload, created_by,
      expires_at
    ) values (
      ${tenantId}::uuid,
      ${draftId}::uuid,
      ${sourceId}::uuid,
      ${entityId}::uuid,
      '{"summary":"客户确认预算"}'::jsonb,
      ${tenantId === TENANT_ALPHA ? USER_ALPHA : USER_BETA}::uuid,
      '2026-09-07T02:30:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertRevision(
  database: DatabaseHandle<BattlefieldDatabase>,
  id: string,
  revisionNo: number,
): Promise<void> {
  await sql`
    insert into app.draft_revisions (
      tenant_id, id, draft_id, revision_no, candidate_payload, changed_by,
      changed_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      ${id}::uuid,
      ${DRAFT_ALPHA}::uuid,
      ${revisionNo},
      '{"summary":"修订"}'::jsonb,
      ${USER_ALPHA}::uuid,
      '2026-08-31T02:31:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertFollowup(
  database: DatabaseHandle<BattlefieldDatabase>,
  ids: { followupId?: string; sourceId?: string; draftId?: string } = {},
): Promise<void> {
  await sql`
    insert into app.followups (
      tenant_id, id, entity_id, source_input_id, source_draft_id, occurred_at,
      followup_type, summary, submitted_by, confirmed_by, confirmed_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      ${ids.followupId ?? FOLLOWUP_ALPHA}::uuid,
      ${ENTITY_ALPHA}::uuid,
      ${ids.sourceId ?? SOURCE_ALPHA}::uuid,
      ${ids.draftId ?? DRAFT_ALPHA}::uuid,
      '2026-08-31T02:30:00.000Z'::timestamptz,
      'meeting',
      '客户确认预算',
      ${USER_ALPHA}::uuid,
      ${USER_ALPHA}::uuid,
      '2026-08-31T02:35:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertFact(
  database: DatabaseHandle<BattlefieldDatabase>,
  factId: string,
  supersedesFactId: string | null = null,
): Promise<void> {
  await sql`
    insert into app.business_facts (
      tenant_id, id, entity_id, followup_id, fact_type, fact_value, occurred_at,
      confirmed_at, confirmed_by, supersedes_fact_id
    ) values (
      ${TENANT_ALPHA}::uuid,
      ${factId}::uuid,
      ${ENTITY_ALPHA}::uuid,
      ${FOLLOWUP_ALPHA}::uuid,
      'budget_status',
      '预算已确认',
      '2026-08-31T02:30:00.000Z'::timestamptz,
      '2026-08-31T02:35:00.000Z'::timestamptz,
      ${USER_ALPHA}::uuid,
      ${supersedesFactId}::uuid
    )
  `.execute(database.db);
}

async function insertIdempotency(
  database: DatabaseHandle<BattlefieldDatabase>,
  id: string,
): Promise<void> {
  await sql`
    insert into app.idempotency_records (
      tenant_id, id, operation, idempotency_key, request_hash, status,
      created_by, created_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      ${id}::uuid,
      'followup.confirm',
      'confirm-draft-001',
      repeat('c', 64),
      'in_progress',
      ${USER_ALPHA}::uuid,
      '2026-08-31T02:35:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertOutbox(
  database: DatabaseHandle<BattlefieldDatabase>,
  id: string,
): Promise<void> {
  await sql`
    insert into app.outbox_messages (
      tenant_id, id, event_id, topic, payload, status, dedupe_key, available_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      ${id}::uuid,
      '88000000-0000-4000-8000-000000000001'::uuid,
      'followup.confirmed.v1',
      '{}'::jsonb,
      'pending',
      'followup-confirmed-001',
      '2026-08-31T02:35:00.000Z'::timestamptz
    )
  `.execute(database.db);
}
