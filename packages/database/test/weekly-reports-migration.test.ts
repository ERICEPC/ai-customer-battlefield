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
const USER_ALPHA_SECOND = "30000000-0000-4000-8000-000000000003";
const USER_BETA = "30000000-0000-4000-8000-000000000002";
const ENTITY_ALPHA = "50000000-0000-4000-8000-000000000001";
const ENTITY_BETA = "50000000-0000-4000-8000-000000000002";
const REPORT_ALPHA = "91000000-0000-4000-8000-000000000001";
const REPORT_ALPHA_SECOND = "91000000-0000-4000-8000-000000000002";
const VERSION_ALPHA = "92000000-0000-4000-8000-000000000001";
const VERSION_ALPHA_SECOND = "92000000-0000-4000-8000-000000000002";
const ITEM_ALPHA = "93000000-0000-4000-8000-000000000001";
const EVIDENCE_ALPHA = "70000000-0000-4000-8000-000000000001";

describe("0006_weekly_reports migration", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedIdentity(database);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates and force-protects every weekly-report table", async () => {
    const tables = [
      "report_evidence_links",
      "weekly_report_audiences",
      "weekly_report_item_contributors",
      "weekly_report_items",
      "weekly_report_scope_entities",
      "weekly_report_versions",
      "weekly_reports",
    ];
    const result = await sql<{ protected_count: number; total_count: number }>`
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

    expect(result.rows[0]).toEqual({ protected_count: 7, total_count: 7 });
  });

  test("enforces personal/managed series identity and tenant-safe users", async () => {
    await insertReport(database);
    await expect(
      insertReport(database, {
        reportId: REPORT_ALPHA_SECOND,
      }),
    ).rejects.toThrow();
    await expect(
      insertReport(database, {
        reportId: REPORT_ALPHA_SECOND,
        ownerUserId: USER_BETA,
      }),
    ).rejects.toThrow();
    await expect(
      insertReport(database, {
        reportId: REPORT_ALPHA_SECOND,
        reportType: "managed_portfolio",
        subjectUserId: USER_ALPHA,
      }),
    ).rejects.toThrow();
    await expect(
      insertReport(database, {
        reportId: REPORT_ALPHA_SECOND,
        reportType: "personal",
        ownerUserId: USER_ALPHA,
        subjectUserId: USER_ALPHA_SECOND,
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-09-08T00:00:00.000Z",
      }),
    ).rejects.toThrow();
    await insertReport(database, {
      reportId: REPORT_ALPHA_SECOND,
      reportType: "managed_portfolio",
      subjectUserId: null,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-09-08T00:00:00.000Z",
    });
  });

  test("requires coherent revision lineage, cutoffs and publication metadata", async () => {
    await insertReport(database);
    await insertVersion(database);
    await expect(
      insertVersion(database, {
        versionId: VERSION_ALPHA_SECOND,
        revisionNo: 2,
        previousVersionId: null,
      }),
    ).rejects.toThrow();
    await expect(
      insertVersion(database, {
        versionId: VERSION_ALPHA_SECOND,
        dataCutoffAt: "2026-08-20T00:00:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      sql`
        update app.weekly_report_versions
        set status = 'published', published_at = now(), lock_version = 2
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${VERSION_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();

    await sql`
      update app.weekly_report_versions
      set status = 'published', published_at = now(),
          published_by = ${USER_ALPHA}::uuid, lock_version = 2,
          updated_at = now()
      where tenant_id = ${TENANT_ALPHA}::uuid and id = ${VERSION_ALPHA}::uuid
    `.execute(database.db);
    await expect(
      sql`
        update app.weekly_report_versions
        set note = 'tampered', lock_version = 3, updated_at = now()
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${VERSION_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
  });

  test("keeps source-derived rows immutable while allowing in-review inclusion", async () => {
    await insertReport(database);
    await insertVersion(database);
    await insertScopeEntity(database);
    await insertItem(database);
    await insertEvidence(database);
    await insertContributor(database);
    await insertAudience(database);

    await expect(
      sql`
        update app.weekly_report_items set summary = 'rewritten fact'
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${ITEM_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await sql`
      update app.weekly_report_items set included = false
      where tenant_id = ${TENANT_ALPHA}::uuid and id = ${ITEM_ALPHA}::uuid
    `.execute(database.db);
    const item = await sql<{ included: boolean }>`
      select included from app.weekly_report_items
      where tenant_id = ${TENANT_ALPHA}::uuid and id = ${ITEM_ALPHA}::uuid
    `.execute(database.db);
    expect(item.rows[0]?.included).toBe(false);

    await sql`
      update app.weekly_report_versions
      set status = 'published', published_at = now(),
          published_by = ${USER_ALPHA}::uuid, lock_version = 2,
          updated_at = now()
      where tenant_id = ${TENANT_ALPHA}::uuid and id = ${VERSION_ALPHA}::uuid
    `.execute(database.db);
    await expect(
      sql`
        update app.weekly_report_items set included = true
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${ITEM_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      sql`
        delete from app.report_evidence_links
        where tenant_id = ${TENANT_ALPHA}::uuid and report_item_id = ${ITEM_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      insertEvidence(database, {
        evidenceId: "70000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow();
    await expect(
      insertContributor(database, { userId: USER_ALPHA_SECOND }),
    ).rejects.toThrow();
  });

  test("rejects cross-tenant scope, evidence contributors and audiences", async () => {
    await insertReport(database);
    await insertVersion(database);
    await expect(
      insertScopeEntity(database, { entityId: ENTITY_BETA }),
    ).rejects.toThrow();
    await insertScopeEntity(database);
    await expect(
      insertItem(database, { entityId: ENTITY_BETA }),
    ).rejects.toThrow();
    await insertItem(database);
    await expect(
      insertContributor(database, { userId: USER_BETA }),
    ).rejects.toThrow();
    await expect(
      insertAudience(database, { userId: USER_BETA }),
    ).rejects.toThrow();
    await expect(
      insertEvidence(database, {
        deepLink: "https://unsafe.example/private",
      }),
    ).rejects.toThrow();
  });

  test("extends notification events with one coherent report source", async () => {
    await insertReport(database);
    await insertVersion(database);
    await sql`
      insert into app.notification_events (
        tenant_id, id, recipient_user_id, report_version_id, event_type,
        title, body, deep_link, priority, dedupe_key, created_at
      ) values (
        ${TENANT_ALPHA}::uuid,
        'f0000000-0000-4000-8000-000000000091'::uuid,
        ${USER_ALPHA}::uuid, ${VERSION_ALPHA}::uuid,
        'weekly_report_published', '周报已发布', '查看本周经营进展',
        ${`/reports?reportId=${REPORT_ALPHA}&versionId=${VERSION_ALPHA}`},
        'medium', 'weekly-report-published:1', now()
      )
    `.execute(database.db);
    await expect(
      sql`
        insert into app.notification_events (
          tenant_id, id, recipient_user_id, reminder_id, report_version_id,
          event_type, title, body, deep_link, priority, dedupe_key, created_at
        ) values (
          ${TENANT_ALPHA}::uuid,
          'f0000000-0000-4000-8000-000000000092'::uuid,
          ${USER_ALPHA}::uuid,
          '72000000-0000-4000-8000-000000000099'::uuid,
          ${VERSION_ALPHA}::uuid, 'weekly_report_published', 'invalid', 'invalid',
          '/reports', 'medium', 'weekly-report-invalid-source', now()
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });
});

async function seedIdentity(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`
    insert into app.tenants (id, slug, name) values
      (${TENANT_ALPHA}::uuid, 'report-alpha', 'report-alpha'),
      (${TENANT_BETA}::uuid, 'report-beta', 'report-beta')
  `.execute(database.db);
  await sql`
    insert into app.users (tenant_id, id, display_name) values
      (${TENANT_ALPHA}::uuid, ${USER_ALPHA}::uuid, 'alpha-user'),
      (${TENANT_ALPHA}::uuid, ${USER_ALPHA_SECOND}::uuid, 'alpha-second'),
      (${TENANT_BETA}::uuid, ${USER_BETA}::uuid, 'beta-user')
  `.execute(database.db);
  await sql`
    insert into app.business_entity_types (tenant_id, id, code, name) values
      (${TENANT_ALPHA}::uuid, '40000000-0000-4000-8000-000000000001'::uuid, 'customer', '客户'),
      (${TENANT_BETA}::uuid, '40000000-0000-4000-8000-000000000002'::uuid, 'customer', '客户')
  `.execute(database.db);
  await sql`
    insert into app.business_entities (tenant_id, id, type_id, name) values
      (${TENANT_ALPHA}::uuid, ${ENTITY_ALPHA}::uuid, '40000000-0000-4000-8000-000000000001'::uuid, 'alpha-entity'),
      (${TENANT_BETA}::uuid, ${ENTITY_BETA}::uuid, '40000000-0000-4000-8000-000000000002'::uuid, 'beta-entity')
  `.execute(database.db);
}

async function insertReport(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    reportId?: string;
    reportType?: "personal" | "managed_portfolio";
    ownerUserId?: string;
    subjectUserId?: string | null;
    periodStart?: string;
    periodEnd?: string;
  } = {},
): Promise<void> {
  const ownerUserId = input.ownerUserId ?? USER_ALPHA;
  const subjectUserId =
    input.subjectUserId === undefined ? ownerUserId : input.subjectUserId;
  await sql`
    insert into app.weekly_reports (
      tenant_id, id, report_type, owner_user_id, subject_user_id,
      period_start, period_end, created_by, created_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.reportId ?? REPORT_ALPHA}::uuid,
      ${input.reportType ?? "personal"}, ${ownerUserId}::uuid,
      ${subjectUserId}::uuid,
      ${input.periodStart ?? "2026-08-24T00:00:00.000Z"}::timestamptz,
      ${input.periodEnd ?? "2026-08-31T00:00:00.000Z"}::timestamptz,
      ${USER_ALPHA}::uuid, '2026-08-31T01:00:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertVersion(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    versionId?: string;
    reportId?: string;
    revisionNo?: number;
    previousVersionId?: string | null;
    dataCutoffAt?: string;
  } = {},
): Promise<void> {
  await sql`
    insert into app.weekly_report_versions (
      tenant_id, id, report_id, revision_no, lock_version, status,
      data_cutoff_at, title, note, scope_fingerprint, scope_entity_count,
      contributor_count, confirmed_followup_count, valid_fact_count,
      stage_change_count, completed_action_count, open_action_count,
      overdue_action_count, generator_kind, generator_version,
      previous_version_id, created_by, created_at, updated_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.versionId ?? VERSION_ALPHA}::uuid,
      ${input.reportId ?? REPORT_ALPHA}::uuid, ${input.revisionNo ?? 1}, 1,
      'in_review',
      ${input.dataCutoffAt ?? "2026-08-31T00:00:00.000Z"}::timestamptz,
      '个人周报', '', ${"a".repeat(64)}, 1, 1, 2, 3, 1, 1, 2, 1,
      'deterministic', 'weekly-progress-v1',
      ${input.previousVersionId ?? null}::uuid, ${USER_ALPHA}::uuid,
      '2026-08-31T01:00:00.000Z'::timestamptz,
      '2026-08-31T01:00:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertScopeEntity(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: { entityId?: string } = {},
): Promise<void> {
  await sql`
    insert into app.weekly_report_scope_entities (
      tenant_id, report_version_id, entity_id, sort_order
    ) values (
      ${TENANT_ALPHA}::uuid, ${VERSION_ALPHA}::uuid,
      ${input.entityId ?? ENTITY_ALPHA}::uuid, 1
    )
  `.execute(database.db);
}

async function insertItem(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: { entityId?: string } = {},
): Promise<void> {
  await sql`
    insert into app.weekly_report_items (
      tenant_id, id, report_version_id, section_type, entity_id,
      title, summary, severity, occurred_at, included, sort_order, created_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${ITEM_ALPHA}::uuid, ${VERSION_ALPHA}::uuid,
      'progress', ${input.entityId ?? ENTITY_ALPHA}::uuid,
      '本周进展', '客户确认安全评审时间', 'positive',
      '2026-08-30T03:00:00.000Z'::timestamptz, true, 1, now()
    )
  `.execute(database.db);
}

async function insertEvidence(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: { evidenceId?: string; deepLink?: string } = {},
): Promise<void> {
  await sql`
    insert into app.report_evidence_links (
      tenant_id, report_item_id, evidence_type, evidence_id,
      occurred_at, label, deep_link, created_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${ITEM_ALPHA}::uuid, 'fact',
      ${input.evidenceId ?? EVIDENCE_ALPHA}::uuid,
      '2026-08-30T03:00:00.000Z'::timestamptz,
      '客户确认安全评审时间',
      ${input.deepLink ?? `/battle-map?entityId=${ENTITY_ALPHA}`}, now()
    )
  `.execute(database.db);
}

async function insertContributor(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: { userId?: string } = {},
): Promise<void> {
  await sql`
    insert into app.weekly_report_item_contributors (
      tenant_id, report_item_id, user_id, display_name, created_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${ITEM_ALPHA}::uuid,
      ${input.userId ?? USER_ALPHA}::uuid, 'alpha-user', now()
    )
  `.execute(database.db);
}

async function insertAudience(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: { userId?: string } = {},
): Promise<void> {
  await sql`
    insert into app.weekly_report_audiences (
      tenant_id, report_version_id, user_id, audience_role, created_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${VERSION_ALPHA}::uuid,
      ${input.userId ?? USER_ALPHA}::uuid, 'reviewer', now()
    )
  `.execute(database.db);
}
