import { fileURLToPath } from "node:url";
import {
  InvalidManagementQueryCursorError,
  ManagementQueryIdempotencyConflictError,
  ManagementQueryResultLimitExceededError,
  ManagementQuerySubjectNotFoundError,
} from "@battlefield/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { KyselyManagementQueryRepository } from "../src/management-queries/kysely-management-query-repository.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";
import {
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_OTHER_TENANT_ID,
  SYNTHETIC_OTHER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "../src/testing/synthetic-directory.js";
import { seedSyntheticAcceptedAction } from "../src/testing/synthetic-reminders.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const MANAGER_ID = "30000000-0000-4000-8000-000000000082";
const FUTURE_USER_ID = "30000000-0000-4000-8000-000000000083";
const ENDED_USER_ID = "30000000-0000-4000-8000-000000000084";
const UNASSIGNED_USER_ID = "30000000-0000-4000-8000-000000000085";
const SECOND_ENTITY_ID = "50000000-0000-4000-8000-000000000082";
const FOLLOWUP_ID = "80000000-0000-4000-8000-000000000082";
const FACT_ID = "70000000-0000-4000-8000-000000000082";
const FUTURE_FACT_ID = "70000000-0000-4000-8000-000000000083";
const STAGE_HISTORY_ID = "88000000-0000-4000-8000-000000000082";
const HIDDEN_STAGE_HISTORY_ID = "88000000-0000-4000-8000-000000000083";
const FOREIGN_STAGE_HISTORY_ID = "88000000-0000-4000-8000-000000000084";
const COMPLETED_ACTION_ID = "d0000000-0000-4000-8000-000000000082";
const BOUNDARY_FACT_ID = "70000000-0000-4000-8000-000000000086";
const ORIGINAL_STATE_ID = "b0000000-0000-4000-8000-000000000071";
const FUTURE_STATE_ID = "b0000000-0000-4000-8000-000000000086";
const QUERY_ID = "90000000-0000-4000-8000-000000000082";
const QUERY_REQUEST_ID = "90000000-0000-4000-8000-000000000083";
const QUERY_IDEMPOTENCY_KEY = "management-query-repository-test";
const SEED_REQUEST_ID = "90000000-0000-4000-8000-000000000084";
const READ_AUDIT_REQUEST_ID = "90000000-0000-4000-8000-000000000085";
const COUNT_AUDIT_REQUEST_ID = "90000000-0000-4000-8000-000000000086";
const QUERY_NOW = "2026-08-31T04:00:00.000Z";
const PERIOD_START = "2026-08-25T00:00:00.000Z";
const PERIOD_END = "2026-09-01T00:00:00.000Z";
const manager = { tenantId: SYNTHETIC_TENANT_ID, userId: MANAGER_ID };
const seller = { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID };
const otherActor = {
  tenantId: SYNTHETIC_OTHER_TENANT_ID,
  userId: SYNTHETIC_OTHER_USER_ID,
};

describe("Kysely management-query repository", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let repository: KyselyManagementQueryRepository;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticAcceptedAction(database);
    await seedManagementQueryScenario(database);
    repository = new KyselyManagementQueryRepository(database.db, {
      queryIdFactory: () => QUERY_ID,
      requestIdFactory: () => QUERY_REQUEST_ID,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("lists only current self and observed-portfolio subjects", async () => {
    await expect(
      repository.listSubjects({ actor: manager, limit: 50 }),
    ).resolves.toEqual({
      items: [
        {
          userId: SYNTHETIC_USER_ID,
          displayName: "alpha-owner",
          scopeKind: "observed_portfolio",
        },
      ],
      nextCursor: null,
    });
    await expect(
      repository.listSubjects({ actor: seller, limit: 50 }),
    ).resolves.toEqual({
      items: [
        {
          userId: SYNTHETIC_USER_ID,
          displayName: "alpha-owner",
          scopeKind: "self",
        },
      ],
      nextCursor: null,
    });
    await expect(
      repository.listSubjects({ actor: otherActor, limit: 50 }),
    ).resolves.toEqual({
      items: [
        {
          userId: SYNTHETIC_OTHER_USER_ID,
          displayName: "beta-owner",
          scopeKind: "self",
        },
      ],
      nextCursor: null,
    });
    await expect(
      repository.listSubjects({ actor: manager, limit: 20, cursor: "bad" }),
    ).rejects.toBeInstanceOf(InvalidManagementQueryCursorError);
  });

  test("returns deterministic scoped metrics, typed evidence, gaps and safe audit metadata", async () => {
    const result = await repository.runSalesWeeklyProgress({
      actor: manager,
      idempotencyKey: QUERY_IDEMPOTENCY_KEY,
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      queryNow: QUERY_NOW,
      dataCutoffAt: QUERY_NOW,
    });

    expect(result).toMatchObject({
      queryId: QUERY_ID,
      capability: "sales_weekly_progress",
      subject: { userId: SYNTHETIC_USER_ID, displayName: "alpha-owner" },
      period: { start: PERIOD_START, end: PERIOD_END },
      dataCutoffAt: QUERY_NOW,
      scope: { kind: "observed_portfolio", entityCount: 1 },
      metrics: {
        confirmedFollowupCount: 1,
        validFactCount: 1,
        stageChangeCount: 1,
        completedActionCount: 1,
        openActionCount: 1,
        overdueActionCount: 1,
      },
      dataGaps: [],
    });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]).toMatchObject({
      entityId: SYNTHETIC_ENTITY_ID,
      entityName: "Aurora Systems",
      latestActivityAt: "2026-08-31T03:30:00.000Z",
      confirmedFollowupCount: 1,
      validFactCount: 1,
      stageChangeCount: 1,
      completedActionCount: 1,
      openActionCount: 1,
      overdueActionCount: 1,
    });
    expect(
      new Set(result.highlights[0]?.evidence.map((item) => item.kind)),
    ).toEqual(
      new Set(["followup", "fact", "stage_change", "action", "battle_state"]),
    );
    expect(result.highlights[0]?.evidence).not.toContainEqual(
      expect.objectContaining({ evidenceId: FUTURE_FACT_ID }),
    );
    expect(JSON.stringify(result)).not.toContain(HIDDEN_STAGE_HISTORY_ID);
    expect(JSON.stringify(result)).not.toContain(FOREIGN_STAGE_HISTORY_ID);
    expect(
      result.highlights.flatMap((highlight) => highlight.evidence),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "followup",
          deepLink: `/followups/${FOLLOWUP_ID}`,
        }),
        expect.objectContaining({
          kind: "fact",
          deepLink: `/followups/${FOLLOWUP_ID}`,
        }),
        expect.objectContaining({
          kind: "stage_change",
          deepLink: `/battle-map?entityId=${SYNTHETIC_ENTITY_ID}`,
        }),
      ]),
    );
    expect(
      result.highlights
        .flatMap((highlight) => highlight.evidence)
        .every((evidence) => evidence.label.length <= 500),
    ).toBe(true);

    const audit = await readQueryAudit(database);
    expect(audit).toMatchObject({
      aggregate_id: QUERY_ID,
      action: "management_query.executed",
      actor_user_id: MANAGER_ID,
      request_id: QUERY_REQUEST_ID,
    });
    expect(audit.after_payload).toMatchObject({
      capability: "sales_weekly_progress",
      subjectUserId: SYNTHETIC_USER_ID,
      scopeKind: "observed_portfolio",
      entityCount: 1,
      highlightCount: 1,
      dataGapCount: 0,
    });
    expect(JSON.stringify(audit.after_payload)).not.toContain(
      "客户确认采购窗口",
    );
  });

  test("replays a completed query without recomputing or duplicating its audit", async () => {
    const input = {
      actor: manager,
      idempotencyKey: "management-query-replay",
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      queryNow: QUERY_NOW,
      dataCutoffAt: QUERY_NOW,
    };

    const first = await repository.runSalesWeeklyProgress(input);
    const replay = await repository.runSalesWeeklyProgress({
      ...input,
      queryNow: "2026-08-31T05:00:00.000Z",
      dataCutoffAt: "2026-08-31T05:00:00.000Z",
    });

    expect(replay).toEqual(first);
    expect(await countQueryAudits(database)).toBe(1);
  });

  test("does not replay a stored result after the observer scope expands", async () => {
    const input = {
      actor: manager,
      idempotencyKey: "management-query-scope-change",
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      queryNow: QUERY_NOW,
      dataCutoffAt: QUERY_NOW,
    };
    await repository.runSalesWeeklyProgress(input);
    await withTenantTransaction(
      database.db,
      { ...manager, requestId: SEED_REQUEST_ID },
      (transaction) =>
        transaction
          .insertInto("app.entity_assignments")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            entity_id: SECOND_ENTITY_ID,
            user_id: MANAGER_ID,
            assignment_role: "management_observer",
            valid_from: "2026-08-31T04:30:00.000Z",
          })
          .executeTakeFirstOrThrow(),
    );

    await expect(
      repository.runSalesWeeklyProgress({
        ...input,
        queryNow: "2026-08-31T05:00:00.000Z",
        dataCutoffAt: "2026-08-31T05:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ManagementQueryIdempotencyConflictError);
    expect(await countQueryAudits(database)).toBe(1);
  });

  test("does not replay a stored result after observer access is revoked", async () => {
    const input = {
      actor: manager,
      idempotencyKey: "management-query-revoked",
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      queryNow: QUERY_NOW,
      dataCutoffAt: QUERY_NOW,
    };
    await repository.runSalesWeeklyProgress(input);
    await withTenantTransaction(
      database.db,
      { ...manager, requestId: SEED_REQUEST_ID },
      (transaction) =>
        transaction
          .updateTable("app.entity_assignments")
          .set({ valid_to: "2026-08-31T04:30:00.000Z" })
          .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
          .where("entity_id", "=", SYNTHETIC_ENTITY_ID)
          .where("user_id", "=", MANAGER_ID)
          .where("assignment_role", "=", "management_observer")
          .executeTakeFirstOrThrow(),
    );

    await expect(
      repository.runSalesWeeklyProgress({
        ...input,
        queryNow: "2026-08-31T05:00:00.000Z",
        dataCutoffAt: "2026-08-31T05:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ManagementQuerySubjectNotFoundError);
    expect(await countQueryAudits(database)).toBe(1);
  });

  test("uses current self scope and reports missing analysis without inventing risk", async () => {
    const result = await repository.runSalesWeeklyProgress({
      actor: seller,
      idempotencyKey: QUERY_IDEMPOTENCY_KEY,
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      queryNow: QUERY_NOW,
      dataCutoffAt: QUERY_NOW,
    });

    expect(result.scope).toEqual({ kind: "self", entityCount: 2 });
    expect(result.dataGaps).toEqual([
      {
        entityId: SECOND_ENTITY_ID,
        entityName: "Beacon Labs",
        code: "missing_battle_state",
        message: "当前没有已发布作战状态，不能据此判断风险高低。",
      },
    ]);
  });

  test("reconstructs open actions at a historical data cutoff", async () => {
    const historicalCutoff = "2026-08-31T03:00:00.000Z";
    const result = await repository.runSalesWeeklyProgress({
      actor: manager,
      idempotencyKey: QUERY_IDEMPOTENCY_KEY,
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: PERIOD_START,
      periodEnd: historicalCutoff,
      queryNow: QUERY_NOW,
      dataCutoffAt: historicalCutoff,
    });

    expect(result.metrics).toMatchObject({
      completedActionCount: 0,
      openActionCount: 2,
      overdueActionCount: 1,
    });
    expect(
      result.highlights[0]?.evidence.some(
        (evidence) => evidence.evidenceId === COMPLETED_ACTION_ID,
      ),
    ).toBe(true);
  });

  test("keeps period end exclusive and reconstructs battle state at the cutoff", async () => {
    const result = await repository.runSalesWeeklyProgress({
      actor: manager,
      idempotencyKey: QUERY_IDEMPOTENCY_KEY,
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      queryNow: "2026-09-02T00:00:00.000Z",
      dataCutoffAt: PERIOD_END,
    });

    expect(result.metrics.validFactCount).toBe(2);
    expect(
      result.highlights[0]?.evidence.some(
        (evidence) => evidence.evidenceId === BOUNDARY_FACT_ID,
      ),
    ).toBe(false);
    expect(
      result.highlights[0]?.evidence.some(
        (evidence) => evidence.evidenceId === ORIGINAL_STATE_ID,
      ),
    ).toBe(true);
    expect(
      result.highlights[0]?.evidence.some(
        (evidence) => evidence.evidenceId === FUTURE_STATE_ID,
      ),
    ).toBe(false);
  });

  test("fails closed before auditing when the authorized scope or event volume exceeds its bound", async () => {
    const scopeLimited = new KyselyManagementQueryRepository(database.db, {
      queryIdFactory: () => QUERY_ID,
      requestIdFactory: () => QUERY_REQUEST_ID,
      maxScopedEntities: 1,
    });
    await expect(
      scopeLimited.runSalesWeeklyProgress({
        actor: seller,
        idempotencyKey: QUERY_IDEMPOTENCY_KEY,
        subjectUserId: SYNTHETIC_USER_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        queryNow: QUERY_NOW,
        dataCutoffAt: QUERY_NOW,
      }),
    ).rejects.toBeInstanceOf(ManagementQueryResultLimitExceededError);

    const eventLimited = new KyselyManagementQueryRepository(database.db, {
      queryIdFactory: () => QUERY_ID,
      requestIdFactory: () => QUERY_REQUEST_ID,
      maxEventRowsPerKind: 1,
    });
    await expect(
      eventLimited.runSalesWeeklyProgress({
        actor: manager,
        idempotencyKey: QUERY_IDEMPOTENCY_KEY,
        subjectUserId: SYNTHETIC_USER_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        queryNow: "2026-09-02T00:00:00.000Z",
        dataCutoffAt: PERIOD_END,
      }),
    ).rejects.toBeInstanceOf(ManagementQueryResultLimitExceededError);

    const actionLimited = new KyselyManagementQueryRepository(database.db, {
      queryIdFactory: () => QUERY_ID,
      requestIdFactory: () => QUERY_REQUEST_ID,
      maxEventRowsPerKind: 1,
    });
    await expect(
      actionLimited.runSalesWeeklyProgress({
        actor: manager,
        idempotencyKey: QUERY_IDEMPOTENCY_KEY,
        subjectUserId: SYNTHETIC_USER_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        queryNow: QUERY_NOW,
        dataCutoffAt: QUERY_NOW,
      }),
    ).rejects.toBeInstanceOf(ManagementQueryResultLimitExceededError);
    expect(await countQueryAudits(database)).toBe(0);
  });

  test("hides future, ended, unassigned and foreign-tenant subjects without auditing denial", async () => {
    for (const subjectUserId of [
      FUTURE_USER_ID,
      ENDED_USER_ID,
      UNASSIGNED_USER_ID,
    ]) {
      await expect(
        repository.runSalesWeeklyProgress({
          actor: manager,
          idempotencyKey: QUERY_IDEMPOTENCY_KEY,
          subjectUserId,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          queryNow: QUERY_NOW,
          dataCutoffAt: QUERY_NOW,
        }),
      ).rejects.toBeInstanceOf(ManagementQuerySubjectNotFoundError);
    }
    await expect(
      repository.runSalesWeeklyProgress({
        actor: otherActor,
        idempotencyKey: QUERY_IDEMPOTENCY_KEY,
        subjectUserId: SYNTHETIC_USER_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        queryNow: QUERY_NOW,
        dataCutoffAt: QUERY_NOW,
      }),
    ).rejects.toBeInstanceOf(ManagementQuerySubjectNotFoundError);

    expect(await countQueryAudits(database)).toBe(0);
  });
});

async function seedManagementQueryScenario(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: SEED_REQUEST_ID,
    },
    async (transaction) => {
      await transaction
        .updateTable("app.entity_assignments")
        .set({ valid_from: "2026-08-01T00:00:00.000Z" })
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("entity_id", "=", SYNTHETIC_ENTITY_ID)
        .where("user_id", "=", SYNTHETIC_USER_ID)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.users")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: MANAGER_ID,
            display_name: "管理观察者",
            email: null,
            mobile: null,
            status: "active",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: FUTURE_USER_ID,
            display_name: "未来负责人",
            email: null,
            mobile: null,
            status: "active",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: ENDED_USER_ID,
            display_name: "历史负责人",
            email: null,
            mobile: null,
            status: "active",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: UNASSIGNED_USER_ID,
            display_name: "未分配用户",
            email: null,
            mobile: null,
            status: "active",
          },
        ])
        .execute();
      await transaction
        .insertInto("app.business_entities")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: SECOND_ENTITY_ID,
          type_id: "40000000-0000-4000-8000-000000000001",
          name: "Beacon Labs",
          is_t0: false,
          updated_at: "2026-08-31T03:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
      const hiddenOpportunityId = "60000000-0000-4000-8000-000000000082";
      await transaction
        .insertInto("app.opportunities")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: hiddenOpportunityId,
          entity_id: SECOND_ENTITY_ID,
          name: "Beacon hidden opportunity",
          stage_code: "proposal",
          stage_progress: 30,
          status: "open",
          is_primary: true,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.entity_assignments")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: "61000000-0000-4000-8000-000000000082",
            entity_id: SYNTHETIC_ENTITY_ID,
            user_id: MANAGER_ID,
            assignment_role: "management_observer",
            is_primary: false,
            valid_from: "2026-08-01T00:00:00.000Z",
            valid_to: null,
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: "61000000-0000-4000-8000-000000000083",
            entity_id: SYNTHETIC_ENTITY_ID,
            user_id: FUTURE_USER_ID,
            assignment_role: "collaborator",
            is_primary: false,
            valid_from: "2026-09-02T00:00:00.000Z",
            valid_to: null,
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: "61000000-0000-4000-8000-000000000084",
            entity_id: SYNTHETIC_ENTITY_ID,
            user_id: ENDED_USER_ID,
            assignment_role: "collaborator",
            is_primary: false,
            valid_from: "2026-08-01T00:00:00.000Z",
            valid_to: "2026-08-30T00:00:00.000Z",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: "61000000-0000-4000-8000-000000000085",
            entity_id: SECOND_ENTITY_ID,
            user_id: SYNTHETIC_USER_ID,
            assignment_role: "owner",
            is_primary: true,
            valid_from: "2026-08-01T00:00:00.000Z",
            valid_to: null,
          },
        ])
        .execute();

      const opportunity = await transaction
        .selectFrom("app.opportunities")
        .select("id")
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("entity_id", "=", SYNTHETIC_ENTITY_ID)
        .executeTakeFirstOrThrow();
      const sourceInputId = "81000000-0000-4000-8000-000000000082";
      const draftId = "82000000-0000-4000-8000-000000000082";
      await transaction
        .insertInto("app.source_inputs")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: sourceInputId,
          source_type: "web",
          source_message_id: null,
          submitted_by: SYNTHETIC_USER_ID,
          raw_content: "客户确认采购窗口",
          content_hash: "b".repeat(64),
          received_at: "2026-08-31T00:50:00.000Z",
          created_at: "2026-08-31T00:50:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.followup_drafts")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: draftId,
          source_input_id: sourceInputId,
          entity_id: SYNTHETIC_ENTITY_ID,
          status: "confirmed",
          candidate_payload: JSON.stringify({ summary: "客户确认采购窗口" }),
          created_by: SYNTHETIC_USER_ID,
          expires_at: "2026-09-07T00:50:00.000Z",
          confirmed_at: "2026-08-31T01:00:00.000Z",
          confirmed_by: SYNTHETIC_USER_ID,
          cancelled_at: null,
          version_no: 1,
          created_at: "2026-08-31T00:50:00.000Z",
          updated_at: "2026-08-31T01:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.followups")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: FOLLOWUP_ID,
          entity_id: SYNTHETIC_ENTITY_ID,
          source_input_id: sourceInputId,
          source_draft_id: draftId,
          occurred_at: "2026-08-31T00:55:00.000Z",
          followup_type: "meeting",
          summary: "客户确认采购窗口",
          result_summary: "进入商务确认",
          submitted_by: SYNTHETIC_USER_ID,
          confirmed_by: SYNTHETIC_USER_ID,
          confirmed_at: "2026-08-31T01:00:00.000Z",
          version_no: 1,
          created_at: "2026-08-31T01:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.business_facts")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: FACT_ID,
            entity_id: SYNTHETIC_ENTITY_ID,
            opportunity_id: opportunity.id,
            followup_id: FOLLOWUP_ID,
            fact_type: "purchase.window",
            fact_value: `客户确认采购窗口${"长".repeat(1_000)}`,
            occurred_at: "2026-08-31T00:55:00.000Z",
            confirmed_at: "2026-08-31T01:00:00.000Z",
            confirmed_by: SYNTHETIC_USER_ID,
            valid_status: "valid",
            supersedes_fact_id: null,
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: FUTURE_FACT_ID,
            entity_id: SYNTHETIC_ENTITY_ID,
            opportunity_id: opportunity.id,
            followup_id: FOLLOWUP_ID,
            fact_type: "future.note",
            fact_value: "截止时间之后的事实",
            occurred_at: "2026-08-31T05:00:00.000Z",
            confirmed_at: "2026-08-31T05:00:00.000Z",
            confirmed_by: SYNTHETIC_USER_ID,
            valid_status: "valid",
            supersedes_fact_id: null,
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: BOUNDARY_FACT_ID,
            entity_id: SYNTHETIC_ENTITY_ID,
            opportunity_id: opportunity.id,
            followup_id: FOLLOWUP_ID,
            fact_type: "boundary.note",
            fact_value: "结束边界上的事实",
            occurred_at: PERIOD_END,
            confirmed_at: PERIOD_END,
            confirmed_by: SYNTHETIC_USER_ID,
            valid_status: "valid",
            supersedes_fact_id: null,
          },
        ])
        .execute();
      await transaction
        .insertInto("app.opportunity_stage_history")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: STAGE_HISTORY_ID,
            opportunity_id: opportunity.id,
            from_stage_code: "needs_confirmed",
            to_stage_code: "proposal",
            from_progress: 20,
            to_progress: 30,
            changed_by_user_id: SYNTHETIC_USER_ID,
            change_source: "user",
            note: "客户进入正式方案",
            changed_at: "2026-08-31T02:00:00.000Z",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: HIDDEN_STAGE_HISTORY_ID,
            opportunity_id: hiddenOpportunityId,
            from_stage_code: "needs_confirmed",
            to_stage_code: "proposal",
            from_progress: 20,
            to_progress: 30,
            changed_by_user_id: SYNTHETIC_USER_ID,
            change_source: "user",
            note: "同租户但不在观察范围",
            changed_at: "2026-08-31T03:15:00.000Z",
          },
        ])
        .execute();

      await transaction
        .updateTable("app.business_actions")
        .set({
          status: "in_progress",
          planned_at: QUERY_NOW,
          version_no: 2,
        })
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("id", "=", "d0000000-0000-4000-8000-000000000071")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_status_history")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: "89000000-0000-4000-8000-000000000087",
          action_id: "d0000000-0000-4000-8000-000000000071",
          from_status: "planned",
          to_status: "in_progress",
          changed_by: SYNTHETIC_USER_ID,
          reason: "进入执行并调整计划时间",
          changed_at: "2026-08-31T00:02:00.000Z",
          version_no: 2,
        })
        .executeTakeFirstOrThrow();
      const completedProposalId = "c0000000-0000-4000-8000-000000000082";
      await transaction
        .insertInto("app.action_proposals")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: completedProposalId,
          entity_id: SYNTHETIC_ENTITY_ID,
          opportunity_id: opportunity.id,
          title: "完成采购方案",
          description: "本周已经完成",
          suggested_owner_id: SYNTHETIC_USER_ID,
          suggested_priority: "high",
          suggested_planned_at: "2026-08-31T03:00:00.000Z",
          source_battle_state_version_id:
            "b0000000-0000-4000-8000-000000000071",
          status: "accepted",
          version_no: 1,
          proposed_at: "2026-08-31T00:40:00.000Z",
          expires_at: "2026-09-07T00:40:00.000Z",
          decided_at: "2026-08-31T00:45:00.000Z",
          decided_by: SYNTHETIC_USER_ID,
          decision_reason: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.business_actions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: COMPLETED_ACTION_ID,
          entity_id: SYNTHETIC_ENTITY_ID,
          opportunity_id: opportunity.id,
          title: "完成采购方案",
          description: "本周已经完成",
          owner_user_id: SYNTHETIC_USER_ID,
          priority: "high",
          status: "completed",
          planned_at: "2026-08-31T03:00:00.000Z",
          completed_at: "2026-08-31T03:30:00.000Z",
          source_proposal_id: completedProposalId,
          confirmed_by: SYNTHETIC_USER_ID,
          confirmed_at: "2026-08-31T00:45:00.000Z",
          version_no: 3,
          created_at: "2026-08-31T00:45:00.000Z",
          updated_at: "2026-08-31T03:30:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_status_history")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: "89000000-0000-4000-8000-000000000082",
            action_id: COMPLETED_ACTION_ID,
            from_status: null,
            to_status: "planned",
            changed_by: SYNTHETIC_USER_ID,
            reason: null,
            changed_at: "2026-08-31T00:45:00.000Z",
            version_no: 1,
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: "89000000-0000-4000-8000-000000000083",
            action_id: COMPLETED_ACTION_ID,
            from_status: "planned",
            to_status: "in_progress",
            changed_by: SYNTHETIC_USER_ID,
            reason: null,
            changed_at: "2026-08-31T02:30:00.000Z",
            version_no: 2,
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: "89000000-0000-4000-8000-000000000084",
            action_id: COMPLETED_ACTION_ID,
            from_status: "in_progress",
            to_status: "completed",
            changed_by: SYNTHETIC_USER_ID,
            reason: null,
            changed_at: "2026-08-31T03:30:00.000Z",
            version_no: 3,
          },
        ])
        .execute();
      const futureRunId = "a0000000-0000-4000-8000-000000000086";
      const futureInputVersion = "c".repeat(64);
      await transaction
        .insertInto("app.analysis_runs")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: futureRunId,
          entity_id: SYNTHETIC_ENTITY_ID,
          trigger_event_id: null,
          rule_version: "management-query-fixture-v2",
          analyzer_config_version: "deterministic-v1",
          input_version: futureInputVersion,
          status: "completed",
          error_code: null,
          error_message: null,
          started_at: PERIOD_END,
          finished_at: PERIOD_END,
          created_by: SYNTHETIC_USER_ID,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.battle_state_versions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: FUTURE_STATE_ID,
          entity_id: SYNTHETIC_ENTITY_ID,
          version_no: 2,
          input_version: futureInputVersion,
          relationship_score: 65,
          potential_score: 70,
          quadrant_code: "future_state",
          primary_opportunity_id: null,
          risk_level: "low",
          data_sufficiency: "sufficient",
          data_gaps: JSON.stringify([]),
          summary: "结束边界上的作战状态",
          analysis_run_id: futureRunId,
          effective_at: PERIOD_END,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("app.battle_state_current")
        .set({
          battle_state_version_id: FUTURE_STATE_ID,
          version_no: 2,
          input_version: futureInputVersion,
          updated_at: PERIOD_END,
        })
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("entity_id", "=", SYNTHETIC_ENTITY_ID)
        .executeTakeFirstOrThrow();
    },
  );
  await withTenantTransaction(
    database.db,
    { ...otherActor, requestId: SEED_REQUEST_ID },
    async (transaction) => {
      const opportunity = await transaction
        .selectFrom("app.opportunities")
        .select("id")
        .where("tenant_id", "=", SYNTHETIC_OTHER_TENANT_ID)
        .where("entity_id", "=", "50000000-0000-4000-8000-000000000002")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.opportunity_stage_history")
        .values({
          tenant_id: SYNTHETIC_OTHER_TENANT_ID,
          id: FOREIGN_STAGE_HISTORY_ID,
          opportunity_id: opportunity.id,
          from_stage_code: "needs_confirmed",
          to_stage_code: "proposal",
          from_progress: 20,
          to_progress: 30,
          changed_by_user_id: SYNTHETIC_OTHER_USER_ID,
          change_source: "user",
          note: "其他租户的阶段变化",
          changed_at: "2026-08-31T03:20:00.000Z",
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function readQueryAudit(database: DatabaseHandle<BattlefieldDatabase>) {
  return withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: READ_AUDIT_REQUEST_ID,
    },
    (transaction) =>
      transaction
        .selectFrom("app.audit_entries")
        .select([
          "aggregate_id",
          "action",
          "actor_user_id",
          "request_id",
          "after_payload",
        ])
        .where("aggregate_type", "=", "management_query")
        .executeTakeFirstOrThrow(),
  );
}

async function countQueryAudits(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<number> {
  const result = await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: COUNT_AUDIT_REQUEST_ID,
    },
    (transaction) =>
      transaction
        .selectFrom("app.audit_entries")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("aggregate_type", "=", "management_query")
        .executeTakeFirstOrThrow(),
  );
  return Number(result.count);
}
