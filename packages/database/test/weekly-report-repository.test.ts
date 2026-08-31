import { fileURLToPath } from "node:url";
import {
  InvalidWeeklyReportCursorError,
  WeeklyReportIdempotencyConflictError,
  WeeklyReportNotFoundError,
  WeeklyReportResultLimitExceededError,
  WeeklyReportScopeConflictError,
  WeeklyReportVersionConflictError,
} from "@battlefield/core";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";
import { KyselyWeeklyReportRepository } from "../src/weekly-reports/kysely-weekly-report-repository.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ALPHA = "10000000-0000-4000-8000-000000000001";
const TENANT_BETA = "20000000-0000-4000-8000-000000000001";
const SELLER_ALPHA = "30000000-0000-4000-8000-000000000001";
const SELLER_UNOBSERVED = "30000000-0000-4000-8000-000000000003";
const MANAGER_ALPHA = "30000000-0000-4000-8000-000000000013";
const USER_BETA = "30000000-0000-4000-8000-000000000002";
const ENTITY_ALPHA = "50000000-0000-4000-8000-000000000001";
const ENTITY_UNOBSERVED = "50000000-0000-4000-8000-000000000003";
const ENTITY_BETA = "50000000-0000-4000-8000-000000000002";
const REPORT_ID = "91000000-0000-4000-8000-000000000001";
const VERSION_ID = "92000000-0000-4000-8000-000000000001";
const VERSION_ID_SECOND = "92000000-0000-4000-8000-000000000002";
const ITEM_ID = "93000000-0000-4000-8000-000000000001";
const PROGRESS_ITEM_ID = "93000000-0000-4000-8000-000000000011";
const RISK_ITEM_ID = "93000000-0000-4000-8000-000000000012";
const NEXT_ACTION_ITEM_ID = "93000000-0000-4000-8000-000000000013";
const PERIOD_START = "2026-08-24T00:00:00.000Z";
const PERIOD_END = "2026-08-31T00:00:00.000Z";
const GENERATED_AT = "2026-08-31T02:00:00.000Z";
const EVENT_ID = "94000000-0000-4000-8000-000000000001";
const OUTBOX_ID = "95000000-0000-4000-8000-000000000001";

describe("KyselyWeeklyReportRepository generation", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedReportScope(database);
  });

  afterEach(async () => {
    await database.close();
  });

  test("generates and replays one personal report snapshot with four sections", async () => {
    const repository = createRepository(database);
    const input = {
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      idempotencyKey: "personal-report-1",
      reportType: "personal" as const,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    };

    const first = await repository.generate(input);
    const replay = await repository.generate(input);
    const delayedReplay = await repository.generate({
      ...input,
      generatedAt: "2026-08-31T03:00:00.000Z",
      dataCutoffAt: "2026-08-31T00:00:01.000Z",
    });

    expect(replay).toEqual(first);
    expect(delayedReplay).toEqual(first);
    expect(first).toMatchObject({
      reportId: REPORT_ID,
      versionId: VERSION_ID,
      reportType: "personal",
      revisionNo: 1,
      lockVersion: 2,
      status: "in_review",
      title: "个人周报",
      note: "",
      period: { start: PERIOD_START, end: PERIOD_END },
      dataCutoffAt: PERIOD_END,
      scope: {
        label: "本人责任范围",
        entityCount: 1,
        contributorCount: 1,
      },
      metrics: {
        confirmedFollowupCount: 0,
        validFactCount: 0,
        stageChangeCount: 0,
        completedActionCount: 0,
        openActionCount: 0,
        overdueActionCount: 0,
      },
      generator: { kind: "deterministic", version: "weekly-progress-v1" },
      previousVersionId: null,
      publishedAt: null,
      capabilities: { canReview: true, canPublish: true, canRevise: false },
    });
    expect(first.sections.map((section) => section.kind)).toEqual([
      "progress",
      "risk",
      "next_action",
      "data_gap",
    ]);
    expect(first.sections[3]?.items).toEqual([
      expect.objectContaining({
        itemId: ITEM_ID,
        sectionKind: "data_gap",
        entityId: ENTITY_ALPHA,
        entityName: "alpha-entity",
        included: true,
        evidence: [],
        contributors: [{ userId: SELLER_ALPHA, displayName: "alpha-seller" }],
      }),
    ]);

    const persisted = await sql<{
      audit_count: number;
      audience_count: number;
      item_count: number;
      report_count: number;
      scope_count: number;
      version_count: number;
    }>`
      select
        (select count(*)::int from app.weekly_reports) as report_count,
        (select count(*)::int from app.weekly_report_versions) as version_count,
        (select count(*)::int from app.weekly_report_scope_entities) as scope_count,
        (select count(*)::int from app.weekly_report_items) as item_count,
        (select count(*)::int from app.weekly_report_audiences) as audience_count,
        (select count(*)::int from app.audit_entries
          where aggregate_type = 'weekly_report'
            and action = 'weekly_report.generated') as audit_count
    `.execute(database.db);
    expect(persisted.rows[0]).toEqual({
      audit_count: 1,
      audience_count: 2,
      item_count: 1,
      report_count: 1,
      scope_count: 1,
      version_count: 1,
    });
  });

  test("returns the existing series when the same period is generated with a new key", async () => {
    const reportIds = [REPORT_ID, "91000000-0000-4000-8000-000000000099"];
    const versionIds = [VERSION_ID, "92000000-0000-4000-8000-000000000099"];
    const repository = new KyselyWeeklyReportRepository(database.db, {
      reportIdFactory: () => reportIds.shift() ?? REPORT_ID,
      versionIdFactory: () => versionIds.shift() ?? VERSION_ID,
      itemIdFactory: () => ITEM_ID,
    });
    const baseInput = {
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      reportType: "personal" as const,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    };

    const first = await repository.generate({
      ...baseInput,
      idempotencyKey: "personal-report-first-key",
    });
    const duplicate = await repository.generate({
      ...baseInput,
      idempotencyKey: "personal-report-second-key",
    });

    expect(duplicate).toEqual(first);
    const counts = await sql<{
      idempotency_count: number;
      report_count: number;
      version_count: number;
    }>`
      select
        (select count(*)::int from app.idempotency_records
          where operation = 'weekly_report.generate') as idempotency_count,
        (select count(*)::int from app.weekly_reports) as report_count,
        (select count(*)::int from app.weekly_report_versions) as version_count
    `.execute(database.db);
    expect(counts.rows[0]).toEqual({
      idempotency_count: 2,
      report_count: 1,
      version_count: 1,
    });
  });

  test("uses only the manager's observed portfolio and snapshots contributors", async () => {
    const repository = createRepository(database);
    const report = await repository.generate({
      actor: { tenantId: TENANT_ALPHA, userId: MANAGER_ALPHA },
      idempotencyKey: "managed-report-1",
      reportType: "managed_portfolio",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    });

    expect(report.scope).toEqual({
      label: "当前管理关注范围",
      entityCount: 1,
      contributorCount: 1,
    });
    const gaps = report.sections.find(
      (section) => section.kind === "data_gap",
    )?.items;
    expect(gaps?.map((item) => item.entityId)).toEqual([ENTITY_ALPHA]);
    expect(gaps?.[0]?.contributors).toEqual([
      { userId: SELLER_ALPHA, displayName: "alpha-seller" },
    ]);
    expect(JSON.stringify(report)).not.toContain(ENTITY_UNOBSERVED);
    expect(JSON.stringify(report)).not.toContain(ENTITY_BETA);
  });

  test("projects formal progress, risk, next actions and exact evidence", async () => {
    await seedWeeklyActivity(database);
    const itemIds = [PROGRESS_ITEM_ID, RISK_ITEM_ID, NEXT_ACTION_ITEM_ID];
    const repository = new KyselyWeeklyReportRepository(database.db, {
      reportIdFactory: () => REPORT_ID,
      versionIdFactory: () => VERSION_ID,
      itemIdFactory: () => itemIds.shift() ?? ITEM_ID,
      requestIdFactory: () => "90000000-0000-4000-8000-000000000092",
    });
    const report = await repository.generate({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      idempotencyKey: "personal-report-with-activity",
      reportType: "personal",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    });

    expect(report.metrics).toEqual({
      confirmedFollowupCount: 1,
      validFactCount: 1,
      stageChangeCount: 1,
      completedActionCount: 1,
      openActionCount: 2,
      overdueActionCount: 1,
    });
    expect(
      report.sections.map((section) => [section.kind, section.items.length]),
    ).toEqual([
      ["progress", 1],
      ["risk", 1],
      ["next_action", 1],
      ["data_gap", 0],
    ]);
    const progress = report.sections[0]?.items[0];
    const risk = report.sections[1]?.items[0];
    const nextAction = report.sections[2]?.items[0];
    expect(progress).toMatchObject({
      itemId: PROGRESS_ITEM_ID,
      sectionKind: "progress",
      entityId: ENTITY_ALPHA,
      severity: "positive",
    });
    expect(progress?.evidence.map((evidence) => evidence.kind).sort()).toEqual([
      "action",
      "fact",
      "followup",
      "stage_change",
    ]);
    expect(risk).toMatchObject({
      itemId: RISK_ITEM_ID,
      sectionKind: "risk",
      entityId: ENTITY_ALPHA,
      severity: "critical",
    });
    expect(risk?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "action",
          evidenceId: "d0000000-0000-4000-8000-000000000092",
          deepLink: "/actions?actionId=d0000000-0000-4000-8000-000000000092",
        }),
        expect.objectContaining({
          kind: "battle_state",
          evidenceId: "b0000000-0000-4000-8000-000000000091",
          deepLink: `/battle-map?entityId=${ENTITY_ALPHA}&stateVersion=b0000000-0000-4000-8000-000000000091`,
        }),
      ]),
    );
    expect(nextAction).toMatchObject({
      itemId: NEXT_ACTION_ITEM_ID,
      sectionKind: "next_action",
      entityId: ENTITY_ALPHA,
      severity: "info",
    });
    expect(nextAction?.evidence).toHaveLength(2);

    const persisted = await sql<{
      contributor_count: number;
      evidence_count: number;
      item_count: number;
    }>`
      select
        (select count(*)::int from app.weekly_report_items) as item_count,
        (select count(*)::int from app.report_evidence_links) as evidence_count,
        (select count(*)::int from app.weekly_report_item_contributors)
          as contributor_count
    `.execute(database.db);
    expect(persisted.rows[0]).toEqual({
      contributor_count: 3,
      evidence_count: 8,
      item_count: 3,
    });
  });

  test("excludes backdated followups and facts confirmed after the cutoff", async () => {
    await seedWeeklyActivity(database);
    await sql`
      update app.followups
      set confirmed_at = '2026-09-01T00:00:00.000Z'::timestamptz
      where tenant_id = ${TENANT_ALPHA}::uuid
        and entity_id = ${ENTITY_ALPHA}::uuid
    `.execute(database.db);
    await sql`
      update app.business_facts
      set confirmed_at = '2026-09-01T00:00:00.000Z'::timestamptz
      where tenant_id = ${TENANT_ALPHA}::uuid
        and entity_id = ${ENTITY_ALPHA}::uuid
    `.execute(database.db);

    const itemIds = [PROGRESS_ITEM_ID, RISK_ITEM_ID, NEXT_ACTION_ITEM_ID];
    const report = await new KyselyWeeklyReportRepository(database.db, {
      reportIdFactory: () => REPORT_ID,
      versionIdFactory: () => VERSION_ID,
      itemIdFactory: () => itemIds.shift() ?? ITEM_ID,
    }).generate({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      idempotencyKey: "personal-report-late-confirmation",
      reportType: "personal",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    });

    expect(report.metrics.confirmedFollowupCount).toBe(0);
    expect(report.metrics.validFactCount).toBe(0);
    expect(
      report.sections
        .flatMap((section) => section.items)
        .flatMap((item) => item.evidence)
        .map((evidence) => evidence.kind),
    ).not.toEqual(expect.arrayContaining(["followup", "fact"]));
  });

  test("fails closed when the actor has no report scope", async () => {
    const repository = createRepository(database);
    await expect(
      repository.generate({
        actor: { tenantId: TENANT_ALPHA, userId: SELLER_UNOBSERVED },
        idempotencyKey: "managed-report-no-scope",
        reportType: "managed_portfolio",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        generatedAt: GENERATED_AT,
        dataCutoffAt: PERIOD_END,
      }),
    ).rejects.toBeInstanceOf(WeeklyReportNotFoundError);
  });

  test("rolls back cleanly when the scoped entity limit is exceeded", async () => {
    await sql`
      insert into app.entity_assignments (
        tenant_id, entity_id, user_id, assignment_role, valid_from
      ) values (
        ${TENANT_ALPHA}::uuid, ${ENTITY_UNOBSERVED}::uuid,
        ${SELLER_ALPHA}::uuid, 'owner',
        '2026-08-01T00:00:00.000Z'::timestamptz
      )
    `.execute(database.db);
    const repository = new KyselyWeeklyReportRepository(database.db, {
      maxScopedEntities: 1,
    });

    await expect(
      repository.generate({
        actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
        idempotencyKey: "personal-report-entity-overflow",
        reportType: "personal",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        generatedAt: GENERATED_AT,
        dataCutoffAt: PERIOD_END,
      }),
    ).rejects.toBeInstanceOf(WeeklyReportResultLimitExceededError);
    await expectWeeklyReportTablesEmpty(database);
  });

  test("rolls back idempotency and audit when an event limit is exceeded", async () => {
    await seedWeeklyActivity(database);
    const repository = new KyselyWeeklyReportRepository(database.db, {
      maxEventRowsPerKind: 1,
    });

    await expect(
      repository.generate({
        actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
        idempotencyKey: "personal-report-event-overflow",
        reportType: "personal",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        generatedAt: GENERATED_AT,
        dataCutoffAt: PERIOD_END,
      }),
    ).rejects.toBeInstanceOf(WeeklyReportResultLimitExceededError);
    await expectWeeklyReportTablesEmpty(database);
  });

  test("conflicts instead of replaying evidence after the current scope changes", async () => {
    const repository = createRepository(database);
    const input = {
      actor: { tenantId: TENANT_ALPHA, userId: MANAGER_ALPHA },
      idempotencyKey: "managed-report-scope-change",
      reportType: "managed_portfolio" as const,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    };
    await repository.generate(input);
    await sql`
      insert into app.entity_assignments (
        tenant_id, entity_id, user_id, assignment_role, valid_from
      ) values (
        ${TENANT_ALPHA}::uuid, ${ENTITY_UNOBSERVED}::uuid,
        ${MANAGER_ALPHA}::uuid, 'management_observer',
        '2026-08-01T00:00:00.000Z'::timestamptz
      )
    `.execute(database.db);

    await expect(repository.generate(input)).rejects.toBeInstanceOf(
      WeeklyReportIdempotencyConflictError,
    );
    const audits = await sql<{ count: number }>`
      select count(*)::int as count from app.audit_entries
      where aggregate_type = 'weekly_report'
        and action = 'weekly_report.generated'
    `.execute(database.db);
    expect(audits.rows[0]?.count).toBe(1);
  });

  test("lists, reads, reviews and publishes one immutable report exactly once", async () => {
    const repository = createRepository(database);
    const generated = await repository.generate({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      idempotencyKey: "personal-report-lifecycle",
      reportType: "personal",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    });

    const page = await repository.list({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      reportType: "personal",
      limit: 20,
    });
    expect(page.items).toEqual([
      expect.objectContaining({
        reportId: REPORT_ID,
        versionId: VERSION_ID,
        revisionNo: 1,
        status: "in_review",
      }),
    ]);
    await expect(
      repository.get({
        actor: { tenantId: TENANT_ALPHA, userId: SELLER_UNOBSERVED },
        versionId: VERSION_ID,
      }),
    ).rejects.toBeInstanceOf(WeeklyReportNotFoundError);
    expect(
      await repository.get({
        actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
        versionId: VERSION_ID,
      }),
    ).toEqual(generated);

    const reviewed = await repository.review({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      versionId: VERSION_ID,
      lockVersion: generated.lockVersion,
      note: "本周优先补齐作战状态。",
      items: [{ itemId: ITEM_ID, included: false }],
    });
    expect(reviewed).toMatchObject({
      lockVersion: generated.lockVersion + 1,
      note: "本周优先补齐作战状态。",
      status: "in_review",
    });
    expect(reviewed.sections[3]?.items[0]?.included).toBe(false);
    await expect(
      repository.review({
        actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
        versionId: VERSION_ID,
        lockVersion: generated.lockVersion,
        note: "stale",
        items: [],
      }),
    ).rejects.toBeInstanceOf(WeeklyReportVersionConflictError);

    const published = await repository.publish({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      versionId: VERSION_ID,
      lockVersion: reviewed.lockVersion,
      idempotencyKey: "publish-personal-report",
    });
    const replay = await repository.publish({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      versionId: VERSION_ID,
      lockVersion: reviewed.lockVersion,
      idempotencyKey: "publish-personal-report",
    });
    expect(replay).toEqual(published);
    expect(published).toMatchObject({
      status: "published",
      lockVersion: reviewed.lockVersion + 1,
      capabilities: { canReview: false, canPublish: false, canRevise: true },
    });
    expect(published.publishedAt).not.toBeNull();
    await expect(
      repository.review({
        actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
        versionId: VERSION_ID,
        lockVersion: published.lockVersion,
        note: "tampered",
        items: [],
      }),
    ).rejects.toBeInstanceOf(WeeklyReportVersionConflictError);

    const persisted = await sql<{
      event_count: number;
      outbox_count: number;
      publish_audit_count: number;
      review_audit_count: number;
    }>`
      select
        (select count(*)::int from app.domain_events
          where event_type = 'weekly_report.published.v1') as event_count,
        (select count(*)::int from app.outbox_messages
          where topic = 'weekly_report.published.v1') as outbox_count,
        (select count(*)::int from app.audit_entries
          where aggregate_type = 'weekly_report'
            and action = 'weekly_report.published') as publish_audit_count,
        (select count(*)::int from app.audit_entries
          where aggregate_type = 'weekly_report'
            and action = 'weekly_report.reviewed'
            and after_payload ->> 'excludedCount' = '1') as review_audit_count
    `.execute(database.db);
    expect(persisted.rows[0]).toEqual({
      event_count: 1,
      outbox_count: 1,
      publish_audit_count: 1,
      review_audit_count: 1,
    });

    await sql`
      update app.business_entities
      set name = 'renamed-after-publication'
      where tenant_id = ${TENANT_ALPHA}::uuid
        and id = ${ENTITY_ALPHA}::uuid
    `.execute(database.db);
    const frozen = await repository.get({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      versionId: VERSION_ID,
    });
    expect(frozen.sections[3]?.items[0]?.entityName).toBe("alpha-entity");
  });

  test("revalidates the current scope before publication", async () => {
    const repository = createRepository(database);
    const generated = await repository.generate({
      actor: { tenantId: TENANT_ALPHA, userId: MANAGER_ALPHA },
      idempotencyKey: "managed-before-publish",
      reportType: "managed_portfolio",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    });
    await sql`
      insert into app.entity_assignments (
        tenant_id, entity_id, user_id, assignment_role, valid_from
      ) values (
        ${TENANT_ALPHA}::uuid, ${ENTITY_UNOBSERVED}::uuid,
        ${MANAGER_ALPHA}::uuid, 'management_observer',
        '2026-08-01T00:00:00.000Z'::timestamptz
      )
    `.execute(database.db);

    await expect(
      repository.publish({
        actor: { tenantId: TENANT_ALPHA, userId: MANAGER_ALPHA },
        versionId: VERSION_ID,
        lockVersion: generated.lockVersion,
        idempotencyKey: "publish-revoked-managed-report",
      }),
    ).rejects.toBeInstanceOf(WeeklyReportScopeConflictError);
    const events = await sql<{ count: number }>`
      select count(*)::int as count from app.domain_events
      where event_type = 'weekly_report.published.v1'
    `.execute(database.db);
    expect(events.rows[0]?.count).toBe(0);
  });

  test("creates and replays a new in-review revision from the current scope", async () => {
    const versionIds = [VERSION_ID, VERSION_ID_SECOND];
    const itemIds = [
      ITEM_ID,
      "93000000-0000-4000-8000-000000000002",
      "93000000-0000-4000-8000-000000000003",
    ];
    const repository = new KyselyWeeklyReportRepository(database.db, {
      reportIdFactory: () => REPORT_ID,
      versionIdFactory: () => versionIds.shift() ?? VERSION_ID_SECOND,
      itemIdFactory: () => itemIds.shift() ?? ITEM_ID,
      requestIdFactory: () => "90000000-0000-4000-8000-000000000093",
      eventIdFactory: () => EVENT_ID,
      outboxIdFactory: () => OUTBOX_ID,
    });
    const generated = await repository.generate({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      idempotencyKey: "personal-before-revision",
      reportType: "personal",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: GENERATED_AT,
      dataCutoffAt: PERIOD_END,
    });
    const published = await repository.publish({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      versionId: VERSION_ID,
      lockVersion: generated.lockVersion,
      idempotencyKey: "publish-before-revision",
    });
    await sql`
      insert into app.entity_assignments (
        tenant_id, entity_id, user_id, assignment_role, valid_from
      ) values (
        ${TENANT_ALPHA}::uuid, ${ENTITY_UNOBSERVED}::uuid,
        ${SELLER_ALPHA}::uuid, 'collaborator',
        '2026-08-01T00:00:00.000Z'::timestamptz
      )
    `.execute(database.db);

    const revised = await repository.revise({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      versionId: VERSION_ID,
      lockVersion: published.lockVersion,
      idempotencyKey: "revise-personal-report",
    });
    const replay = await repository.revise({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      versionId: VERSION_ID,
      lockVersion: published.lockVersion,
      idempotencyKey: "revise-personal-report",
    });

    expect(replay).toEqual(revised);
    expect(revised).toMatchObject({
      reportId: REPORT_ID,
      versionId: VERSION_ID_SECOND,
      revisionNo: 2,
      lockVersion: 2,
      status: "in_review",
      previousVersionId: VERSION_ID,
      scope: { entityCount: 2, contributorCount: 1 },
      capabilities: { canReview: true, canPublish: true, canRevise: false },
    });
    expect(revised.sections[3]?.items.map((item) => item.entityId)).toEqual([
      ENTITY_ALPHA,
      ENTITY_UNOBSERVED,
    ]);
    const oldVersion = await repository.get({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      versionId: VERSION_ID,
    });
    expect(oldVersion.status).toBe("published");
    const counts = await sql<{
      report_count: number;
      revise_audit_count: number;
      version_count: number;
    }>`
      select
        (select count(*)::int from app.weekly_reports) as report_count,
        (select count(*)::int from app.weekly_report_versions) as version_count,
        (select count(*)::int from app.audit_entries
          where action = 'weekly_report.revised') as revise_audit_count
    `.execute(database.db);
    expect(counts.rows[0]).toEqual({
      report_count: 1,
      revise_audit_count: 1,
      version_count: 2,
    });
  });

  test("paginates report history with a canonical opaque cursor", async () => {
    const reportIds = [REPORT_ID, "91000000-0000-4000-8000-000000000002"];
    const versionIds = [VERSION_ID, VERSION_ID_SECOND];
    const itemIds = [ITEM_ID, "93000000-0000-4000-8000-000000000002"];
    const repository = new KyselyWeeklyReportRepository(database.db, {
      reportIdFactory: () => reportIds.shift() ?? REPORT_ID,
      versionIdFactory: () => versionIds.shift() ?? VERSION_ID,
      itemIdFactory: () => itemIds.shift() ?? ITEM_ID,
    });
    await repository.generate({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      idempotencyKey: "newer-report-page",
      reportType: "personal",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: "2026-08-31T02:00:00.000Z",
      dataCutoffAt: PERIOD_END,
    });
    await repository.generate({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      idempotencyKey: "older-report-page",
      reportType: "personal",
      periodStart: "2026-08-17T00:00:00.000Z",
      periodEnd: "2026-08-24T00:00:00.000Z",
      generatedAt: "2026-08-31T01:00:00.000Z",
      dataCutoffAt: "2026-08-24T00:00:00.000Z",
    });

    const first = await repository.list({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      limit: 1,
    });
    expect(first.items.map((item) => item.versionId)).toEqual([VERSION_ID]);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.list({
      actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });
    expect(second.items.map((item) => item.versionId)).toEqual([
      VERSION_ID_SECOND,
    ]);
    expect(second.nextCursor).toBeNull();
    await expect(
      repository.list({
        actor: { tenantId: TENANT_ALPHA, userId: SELLER_ALPHA },
        cursor: "not-a-valid-cursor",
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidWeeklyReportCursorError);
  });
});

function createRepository(database: DatabaseHandle<BattlefieldDatabase>) {
  return new KyselyWeeklyReportRepository(database.db, {
    reportIdFactory: () => REPORT_ID,
    versionIdFactory: () => VERSION_ID,
    itemIdFactory: () => ITEM_ID,
    requestIdFactory: () => "90000000-0000-4000-8000-000000000091",
    eventIdFactory: () => EVENT_ID,
    outboxIdFactory: () => OUTBOX_ID,
  });
}

async function expectWeeklyReportTablesEmpty(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  const result = await sql<{
    audit_count: number;
    idempotency_count: number;
    report_count: number;
    version_count: number;
  }>`
    select
      (select count(*)::int from app.weekly_reports) as report_count,
      (select count(*)::int from app.weekly_report_versions) as version_count,
      (select count(*)::int from app.idempotency_records
        where operation = 'weekly_report.generate') as idempotency_count,
      (select count(*)::int from app.audit_entries
        where aggregate_type = 'weekly_report') as audit_count
  `.execute(database.db);
  expect(result.rows[0]).toEqual({
    audit_count: 0,
    idempotency_count: 0,
    report_count: 0,
    version_count: 0,
  });
}

async function seedReportScope(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`
    insert into app.tenants (id, slug, name) values
      (${TENANT_ALPHA}::uuid, 'repo-alpha', 'repo-alpha'),
      (${TENANT_BETA}::uuid, 'repo-beta', 'repo-beta')
  `.execute(database.db);
  await sql`
    insert into app.users (tenant_id, id, display_name) values
      (${TENANT_ALPHA}::uuid, ${SELLER_ALPHA}::uuid, 'alpha-seller'),
      (${TENANT_ALPHA}::uuid, ${SELLER_UNOBSERVED}::uuid, 'unobserved-seller'),
      (${TENANT_ALPHA}::uuid, ${MANAGER_ALPHA}::uuid, 'alpha-manager'),
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
      (${TENANT_ALPHA}::uuid, ${ENTITY_UNOBSERVED}::uuid, '40000000-0000-4000-8000-000000000001'::uuid, 'unobserved-entity'),
      (${TENANT_BETA}::uuid, ${ENTITY_BETA}::uuid, '40000000-0000-4000-8000-000000000002'::uuid, 'beta-entity')
  `.execute(database.db);
  await sql`
    insert into app.entity_assignments (
      tenant_id, entity_id, user_id, assignment_role, valid_from
    ) values
      (${TENANT_ALPHA}::uuid, ${ENTITY_ALPHA}::uuid, ${SELLER_ALPHA}::uuid,
        'owner', '2026-08-01T00:00:00.000Z'::timestamptz),
      (${TENANT_ALPHA}::uuid, ${ENTITY_ALPHA}::uuid, ${MANAGER_ALPHA}::uuid,
        'management_observer', '2026-08-01T00:00:00.000Z'::timestamptz),
      (${TENANT_ALPHA}::uuid, ${ENTITY_UNOBSERVED}::uuid,
        ${SELLER_UNOBSERVED}::uuid, 'owner',
        '2026-08-01T00:00:00.000Z'::timestamptz),
      (${TENANT_BETA}::uuid, ${ENTITY_BETA}::uuid, ${USER_BETA}::uuid,
        'owner', '2026-08-01T00:00:00.000Z'::timestamptz)
  `.execute(database.db);
}

async function seedWeeklyActivity(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`
    insert into app.opportunities (
      tenant_id, id, entity_id, name, stage_code, stage_progress,
      status, is_primary
    ) values (
      ${TENANT_ALPHA}::uuid,
      '60000000-0000-4000-8000-000000000091'::uuid,
      ${ENTITY_ALPHA}::uuid, 'alpha-opportunity', 'proposal', 40,
      'open', true
    )
  `.execute(database.db);
  await sql`
    insert into app.source_inputs (
      tenant_id, id, source_type, submitted_by, raw_content,
      content_hash, received_at, created_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      '81000000-0000-4000-8000-000000000091'::uuid,
      'web', ${SELLER_ALPHA}::uuid, '客户确认安全评审时间',
      ${"b".repeat(64)}, '2026-08-29T01:00:00.000Z',
      '2026-08-29T01:00:00.000Z'
    )
  `.execute(database.db);
  await sql`
    insert into app.followup_drafts (
      tenant_id, id, source_input_id, entity_id, status,
      candidate_payload, created_by, expires_at, confirmed_at,
      confirmed_by, version_no, created_at, updated_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      '82000000-0000-4000-8000-000000000091'::uuid,
      '81000000-0000-4000-8000-000000000091'::uuid,
      ${ENTITY_ALPHA}::uuid, 'confirmed', '{}'::jsonb,
      ${SELLER_ALPHA}::uuid, '2026-09-05T01:00:00.000Z',
      '2026-08-29T01:05:00.000Z', ${SELLER_ALPHA}::uuid, 1,
      '2026-08-29T01:00:00.000Z', '2026-08-29T01:05:00.000Z'
    )
  `.execute(database.db);
  await sql`
    insert into app.followups (
      tenant_id, id, entity_id, source_input_id, source_draft_id,
      occurred_at, followup_type, summary, submitted_by, confirmed_by,
      confirmed_at, version_no, created_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      '83000000-0000-4000-8000-000000000091'::uuid,
      ${ENTITY_ALPHA}::uuid,
      '81000000-0000-4000-8000-000000000091'::uuid,
      '82000000-0000-4000-8000-000000000091'::uuid,
      '2026-08-29T01:00:00.000Z', 'meeting', '客户确认安全评审时间',
      ${SELLER_ALPHA}::uuid, ${SELLER_ALPHA}::uuid,
      '2026-08-29T01:05:00.000Z', 1, '2026-08-29T01:05:00.000Z'
    )
  `.execute(database.db);
  await sql`
    insert into app.business_facts (
      tenant_id, id, entity_id, opportunity_id, followup_id,
      fact_type, fact_value, occurred_at, confirmed_at, confirmed_by
    ) values (
      ${TENANT_ALPHA}::uuid,
      '84000000-0000-4000-8000-000000000091'::uuid,
      ${ENTITY_ALPHA}::uuid,
      '60000000-0000-4000-8000-000000000091'::uuid,
      '83000000-0000-4000-8000-000000000091'::uuid,
      'security.review', '客户确认安全评审时间',
      '2026-08-29T01:00:00.000Z', '2026-08-29T01:05:00.000Z',
      ${SELLER_ALPHA}::uuid
    )
  `.execute(database.db);
  await sql`
    insert into app.opportunity_stage_history (
      tenant_id, id, opportunity_id, from_stage_code, to_stage_code,
      from_progress, to_progress, changed_by_user_id, change_source,
      changed_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      '85000000-0000-4000-8000-000000000091'::uuid,
      '60000000-0000-4000-8000-000000000091'::uuid,
      'discovery', 'proposal', 20, 40, ${SELLER_ALPHA}::uuid,
      'user', '2026-08-29T02:00:00.000Z'
    )
  `.execute(database.db);
  await sql`
    insert into app.analysis_runs (
      tenant_id, id, entity_id, rule_version, analyzer_config_version,
      input_version, status, started_at, finished_at, created_by
    ) values (
      ${TENANT_ALPHA}::uuid,
      'a0000000-0000-4000-8000-000000000091'::uuid,
      ${ENTITY_ALPHA}::uuid, 'rules-v1', 'deterministic-v1',
      ${"c".repeat(64)}, 'completed', '2026-08-29T02:10:00.000Z',
      '2026-08-29T02:11:00.000Z', ${SELLER_ALPHA}::uuid
    )
  `.execute(database.db);
  await sql`
    insert into app.battle_state_versions (
      tenant_id, id, entity_id, version_no, input_version,
      relationship_score, potential_score, quadrant_code, risk_level,
      data_sufficiency, data_gaps, summary, analysis_run_id, effective_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      'b0000000-0000-4000-8000-000000000091'::uuid,
      ${ENTITY_ALPHA}::uuid, 1, ${"c".repeat(64)}, 60, 80,
      'high_potential', 'critical', 'sufficient', '[]'::jsonb,
      '安全评审时间紧张',
      'a0000000-0000-4000-8000-000000000091'::uuid,
      '2026-08-29T02:11:00.000Z'
    )
  `.execute(database.db);
  await database.db.transaction().execute(async (transaction) => {
    await sql`
      insert into app.action_proposals (
      tenant_id, id, entity_id, opportunity_id, title, description,
      suggested_owner_id, suggested_priority, suggested_planned_at,
      source_battle_state_version_id, status, version_no, proposed_at,
      expires_at, decided_at, decided_by
    ) values
      (${TENANT_ALPHA}::uuid,
        'c0000000-0000-4000-8000-000000000091'::uuid,
        ${ENTITY_ALPHA}::uuid,
        '60000000-0000-4000-8000-000000000091'::uuid,
        '完成方案初稿', '完成方案初稿', ${SELLER_ALPHA}::uuid,
        'high', '2026-08-29T03:00:00.000Z',
        'b0000000-0000-4000-8000-000000000091'::uuid,
        'accepted', 1, '2026-08-29T02:20:00.000Z',
        '2026-09-05T02:20:00.000Z', '2026-08-29T02:21:00.000Z',
        ${SELLER_ALPHA}::uuid),
      (${TENANT_ALPHA}::uuid,
        'c0000000-0000-4000-8000-000000000092'::uuid,
        ${ENTITY_ALPHA}::uuid,
        '60000000-0000-4000-8000-000000000091'::uuid,
        '确认技术交流', '确认技术交流', ${SELLER_ALPHA}::uuid,
        'urgent', '2026-08-28T03:00:00.000Z',
        'b0000000-0000-4000-8000-000000000091'::uuid,
        'accepted', 1, '2026-08-27T02:22:00.000Z',
        '2026-09-03T02:22:00.000Z', '2026-08-27T02:23:00.000Z',
        ${SELLER_ALPHA}::uuid),
      (${TENANT_ALPHA}::uuid,
        'c0000000-0000-4000-8000-000000000093'::uuid,
        ${ENTITY_ALPHA}::uuid,
        '60000000-0000-4000-8000-000000000091'::uuid,
        '准备评审材料', '准备评审材料', ${SELLER_ALPHA}::uuid,
        'medium', '2026-09-02T03:00:00.000Z',
        'b0000000-0000-4000-8000-000000000091'::uuid,
        'accepted', 1, '2026-08-29T02:24:00.000Z',
        '2026-09-05T02:24:00.000Z', '2026-08-29T02:25:00.000Z',
        ${SELLER_ALPHA}::uuid)
    `.execute(transaction);
    await sql`
      insert into app.business_actions (
      tenant_id, id, entity_id, opportunity_id, title, description,
      owner_user_id, priority, status, planned_at, completed_at,
      source_proposal_id, confirmed_by, confirmed_at, version_no,
      created_at, updated_at
    ) values
      (${TENANT_ALPHA}::uuid,
        'd0000000-0000-4000-8000-000000000091'::uuid,
        ${ENTITY_ALPHA}::uuid,
        '60000000-0000-4000-8000-000000000091'::uuid,
        '完成方案初稿', '完成方案初稿', ${SELLER_ALPHA}::uuid,
        'high', 'completed', '2026-08-29T03:00:00.000Z',
        '2026-08-30T03:00:00.000Z',
        'c0000000-0000-4000-8000-000000000091'::uuid,
        ${SELLER_ALPHA}::uuid, '2026-08-29T02:21:00.000Z', 3,
        '2026-08-29T02:21:00.000Z', '2026-08-30T03:00:00.000Z'),
      (${TENANT_ALPHA}::uuid,
        'd0000000-0000-4000-8000-000000000092'::uuid,
        ${ENTITY_ALPHA}::uuid,
        '60000000-0000-4000-8000-000000000091'::uuid,
        '确认技术交流', '确认技术交流', ${SELLER_ALPHA}::uuid,
        'urgent', 'planned', '2026-08-28T03:00:00.000Z', null,
        'c0000000-0000-4000-8000-000000000092'::uuid,
        ${SELLER_ALPHA}::uuid, '2026-08-27T02:23:00.000Z', 1,
        '2026-08-27T02:23:00.000Z', '2026-08-27T02:23:00.000Z'),
      (${TENANT_ALPHA}::uuid,
        'd0000000-0000-4000-8000-000000000093'::uuid,
        ${ENTITY_ALPHA}::uuid,
        '60000000-0000-4000-8000-000000000091'::uuid,
        '准备评审材料', '准备评审材料', ${SELLER_ALPHA}::uuid,
        'medium', 'in_progress', '2026-09-02T03:00:00.000Z', null,
        'c0000000-0000-4000-8000-000000000093'::uuid,
        ${SELLER_ALPHA}::uuid, '2026-08-29T02:25:00.000Z', 2,
        '2026-08-29T02:25:00.000Z', '2026-08-30T02:00:00.000Z')
    `.execute(transaction);
    await sql`
      insert into app.action_status_history (
      tenant_id, id, action_id, from_status, to_status,
      changed_by, changed_at, version_no
    ) values
      (${TENANT_ALPHA}::uuid,
        '89000000-0000-4000-8000-000000000091'::uuid,
        'd0000000-0000-4000-8000-000000000091'::uuid,
        null, 'planned', ${SELLER_ALPHA}::uuid,
        '2026-08-29T02:21:00.000Z', 1),
      (${TENANT_ALPHA}::uuid,
        '89000000-0000-4000-8000-000000000096'::uuid,
        'd0000000-0000-4000-8000-000000000091'::uuid,
        'planned', 'in_progress', ${SELLER_ALPHA}::uuid,
        '2026-08-29T12:00:00.000Z', 2),
      (${TENANT_ALPHA}::uuid,
        '89000000-0000-4000-8000-000000000094'::uuid,
        'd0000000-0000-4000-8000-000000000091'::uuid,
        'in_progress', 'completed', ${SELLER_ALPHA}::uuid,
        '2026-08-30T03:00:00.000Z', 3),
      (${TENANT_ALPHA}::uuid,
        '89000000-0000-4000-8000-000000000092'::uuid,
        'd0000000-0000-4000-8000-000000000092'::uuid,
        null, 'planned', ${SELLER_ALPHA}::uuid,
        '2026-08-27T02:23:00.000Z', 1),
      (${TENANT_ALPHA}::uuid,
        '89000000-0000-4000-8000-000000000093'::uuid,
        'd0000000-0000-4000-8000-000000000093'::uuid,
        null, 'planned', ${SELLER_ALPHA}::uuid,
        '2026-08-29T02:25:00.000Z', 1),
      (${TENANT_ALPHA}::uuid,
        '89000000-0000-4000-8000-000000000095'::uuid,
        'd0000000-0000-4000-8000-000000000093'::uuid,
        'planned', 'in_progress', ${SELLER_ALPHA}::uuid,
        '2026-08-30T02:00:00.000Z', 2)
    `.execute(transaction);
  });
}
