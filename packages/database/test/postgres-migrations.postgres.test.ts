import { fileURLToPath } from "node:url";
import {
  type BusinessEntityReader,
  ManagementQuerySubjectNotFoundError,
} from "@battlefield/core";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { KyselyActionDecisionStore } from "../src/action-decisions/kysely-action-decision-store.js";
import { KyselyActionQueryReader } from "../src/action-decisions/kysely-action-query-reader.js";
import {
  KyselyBattleAnalysisStore,
  KyselyConfirmedFactSnapshotReader,
} from "../src/battle-analysis/kysely-battle-analysis-store.js";
import { KyselyBattleQueryReader } from "../src/battle-analysis/kysely-battle-query-reader.js";
import { KyselyBusinessEntityReader } from "../src/business-entities/kysely-business-entity-reader.js";
import { createPostgresDatabase } from "../src/database-factory.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { KyselyFollowupConfirmationStore } from "../src/followup-confirmation/kysely-followup-confirmation-store.js";
import { KyselyManagementQueryRepository } from "../src/management-queries/kysely-management-query-repository.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import {
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_OTHER_TENANT_ID,
  SYNTHETIC_OTHER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "../src/testing/synthetic-directory.js";
import { KyselyWorkspaceReader } from "../src/workspace/kysely-workspace-reader.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const DATABASE_URL = process.env.DATABASE_URL;
const MANAGER_ID = "30000000-0000-4000-8000-000000000013";
const UNASSIGNED_USER_ID = "30000000-0000-4000-8000-000000000014";
const MANAGER_QUERY_ID = "90000000-0000-4000-8000-000000000013";
const SELLER_QUERY_ID = "90000000-0000-4000-8000-000000000014";
const CONCURRENT_MANAGER_QUERY_ID = "90000000-0000-4000-8000-000000000015";
const MANAGEMENT_QUERY_NOW = "2026-09-06T00:00:00.000Z";
const MANAGEMENT_PERIOD_START = "2026-08-31T00:00:00.000Z";
const MANAGEMENT_PERIOD_END = "2026-09-05T00:00:00.000Z";
const MANAGEMENT_DATA_CUTOFF = MANAGEMENT_PERIOD_END;
const FUTURE_MANAGEMENT_STATE_ID = "b0000000-0000-4000-8000-000000000013";

describe("PostgreSQL migrations", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let reader: BusinessEntityReader;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is required for PostgreSQL integration tests.",
      );
    }
    database = createPostgresDatabase<BattlefieldDatabase>(DATABASE_URL, {
      applicationName: "battlefield-postgres-integration-test",
      maxConnections: 4,
    });
    const databaseName = await sql<{ name: string }>`
      select current_database() as name
    `.execute(database.db);
    if (!databaseName.rows[0]?.name.endsWith("_test")) {
      throw new Error(
        "PostgreSQL integration tests require a *_test database.",
      );
    }

    await resetApplicationSchemas(database);
    reader = new KyselyBusinessEntityReader(database.db);
  });

  afterAll(async () => {
    if (!database) {
      return;
    }
    await resetApplicationSchemas(database);
    await database.close();
  });

  test("rebuilds the schema and serves a tenant-scoped directory", async () => {
    const firstRun = await migrateDatabase(
      database.migrations,
      MIGRATION_DIRECTORY,
    );
    const secondRun = await migrateDatabase(
      database.migrations,
      MIGRATION_DIRECTORY,
    );
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementScope(database);
    const page = await reader.list({
      actor: { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID },
      limit: 20,
    });
    const followupStore = new KyselyFollowupConfirmationStore(database.db);
    const draftId = "70000000-0000-4000-8000-000000000011";
    await followupStore.create({
      actor: { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID },
      draftId,
      rawInput: "Synthetic customer confirmed the budget.",
      candidate: {
        entityId: SYNTHETIC_ENTITY_ID,
        summary: "Synthetic customer confirmed the budget.",
        occurredAt: "2026-08-31T02:30:00.000Z",
        followupType: "meeting",
        relatedOpportunityIds: [],
        primaryOpportunityId: null,
        facts: [{ factType: "budget_status", factValue: "Budget confirmed" }],
      },
      createdAt: "2026-08-31T02:30:00.000Z",
      expiresAt: "2026-09-07T02:30:00.000Z",
    });
    const confirmation = await followupStore.confirm({
      actor: { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID },
      draftId,
      versionNo: "1",
      idempotencyKey: "postgres-confirmation-001",
      confirmedAt: "2026-08-31T02:35:00.000Z",
    });
    const actor = {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
    };
    const snapshotReader = new KyselyConfirmedFactSnapshotReader(database.db);
    const snapshot = await snapshotReader.read({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });
    const analysisStore = new KyselyBattleAnalysisStore(database.db);
    const analysisRunId = "a0000000-0000-4000-8000-000000000011";
    await analysisStore.start({
      actor,
      analysisRunId,
      entityId: SYNTHETIC_ENTITY_ID,
      inputVersion: snapshot.inputVersion,
      ruleVersion: "battle-rules-v1",
      analyzerConfigVersion: "deterministic-v1",
      startedAt: "2026-08-31T02:36:00.000Z",
    });
    const analysis = await analysisStore.complete({
      actor,
      analysisRunId,
      inputVersion: snapshot.inputVersion,
      candidate: {
        relationshipScore: "72.50",
        potentialScore: "81.00",
        quadrantCode: "high_relationship_high_potential",
        primaryOpportunityId: null,
        riskLevel: "medium",
        dataSufficiency: "sufficient",
        dataGaps: [],
        summary: "Synthetic confirmed fact supports the current position.",
        signals: [
          {
            factId: snapshot.facts[0]?.factId ?? "",
            dimension: "potential",
            direction: "positive",
            strength: 80,
            reason: "Budget was confirmed.",
          },
        ],
        evidenceFactIds: [snapshot.facts[0]?.factId ?? ""],
        actionProposals: [
          {
            title: "Submit the formal solution",
            description: "Include security and delivery milestones.",
            suggestedOwnerId: SYNTHETIC_USER_ID,
            suggestedPriority: "high",
            suggestedPlannedAt: "2026-09-03T09:00:00.000Z",
          },
        ],
      },
      finishedAt: "2026-08-31T02:37:00.000Z",
    });
    if (analysis.status !== "completed" || !analysis.proposalIds[0]) {
      throw new Error(
        "PostgreSQL analysis smoke test did not create a proposal.",
      );
    }
    const actionStore = new KyselyActionDecisionStore(database.db);
    const action = await actionStore.accept({
      actor,
      proposalId: analysis.proposalIds[0],
      actionId: "d0000000-0000-4000-8000-000000000011",
      versionNo: "1",
      idempotencyKey: "postgres-action-accept-001",
      title: "Submit the formal solution",
      description: "Include security and delivery milestones.",
      ownerUserId: SYNTHETIC_USER_ID,
      priority: "high",
      plannedAt: "2026-09-03T09:00:00.000Z",
      decidedAt: "2026-08-31T02:38:00.000Z",
    });
    const battleQueryReader = new KyselyBattleQueryReader(database.db);
    const actionQueryReader = new KyselyActionQueryReader(database.db);
    const [
      stateDetail,
      mapPage,
      proposalDetail,
      proposalPage,
      actionDetail,
      actionPage,
    ] = await Promise.all([
      battleQueryReader.getCurrent({
        actor,
        entityId: SYNTHETIC_ENTITY_ID,
      }),
      battleQueryReader.listMap({ actor, limit: 20 }),
      actionQueryReader.getProposal({
        actor,
        proposalId: analysis.proposalIds[0],
      }),
      actionQueryReader.listProposals({ actor, limit: 20 }),
      actionQueryReader.getAction({ actor, actionId: action.actionId }),
      actionQueryReader.listActions({ actor, limit: 20 }),
    ]);
    const confirmationCounts = await withTenantTransaction(
      database.db,
      {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_USER_ID,
        requestId: "90000000-0000-4000-8000-000000000011",
      },
      async (transaction) => {
        const result = await sql<{
          action_count: number;
          followup_count: number;
          history_count: number;
          outbox_count: number;
          state_count: number;
        }>`
          select
            (select count(*)::int from app.business_actions) as action_count,
            (select count(*)::int from app.followups) as followup_count,
            (select count(*)::int from app.action_status_history) as history_count,
            (select count(*)::int from app.outbox_messages) as outbox_count,
            (select count(*)::int from app.battle_state_versions) as state_count
        `.execute(transaction);
        return result.rows[0];
      },
    );
    const rlsState = await sql<{
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
    `.execute(database.db);
    const workspace = await new KyselyWorkspaceReader(database.db).read({
      actor,
      now: "2026-09-04T00:00:00.000Z",
    });
    await seedSyntheticBoundaryEvidence(database, confirmation.followupId);
    const queryIds = [MANAGER_QUERY_ID, SELLER_QUERY_ID];
    const managementRepository = new KyselyManagementQueryRepository(
      database.db,
      {
        queryIdFactory: () =>
          queryIds.shift() ?? "90000000-0000-4000-8000-000000000099",
      },
    );
    const manager = { tenantId: SYNTHETIC_TENANT_ID, userId: MANAGER_ID };
    const [managerSubjects, sellerSubjects] = await Promise.all([
      managementRepository.listSubjects({ actor: manager, limit: 20 }),
      managementRepository.listSubjects({ actor, limit: 20 }),
    ]);
    const managerProgress = await managementRepository.runSalesWeeklyProgress({
      actor: manager,
      idempotencyKey: "postgres-management-query-manager",
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: MANAGEMENT_PERIOD_START,
      periodEnd: MANAGEMENT_PERIOD_END,
      queryNow: MANAGEMENT_QUERY_NOW,
      dataCutoffAt: MANAGEMENT_DATA_CUTOFF,
    });
    const sellerProgress = await managementRepository.runSalesWeeklyProgress({
      actor,
      idempotencyKey: "postgres-management-query-seller",
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: MANAGEMENT_PERIOD_START,
      periodEnd: MANAGEMENT_PERIOD_END,
      queryNow: MANAGEMENT_QUERY_NOW,
      dataCutoffAt: MANAGEMENT_DATA_CUTOFF,
    });
    const concurrentRepository = new KyselyManagementQueryRepository(
      database.db,
      { queryIdFactory: () => CONCURRENT_MANAGER_QUERY_ID },
    );
    const concurrentInput = {
      actor: manager,
      idempotencyKey: "postgres-management-query-concurrent",
      subjectUserId: SYNTHETIC_USER_ID,
      periodStart: MANAGEMENT_PERIOD_START,
      periodEnd: MANAGEMENT_PERIOD_END,
      queryNow: MANAGEMENT_QUERY_NOW,
      dataCutoffAt: MANAGEMENT_DATA_CUTOFF,
    };
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      concurrentRepository.runSalesWeeklyProgress(concurrentInput),
      concurrentRepository.runSalesWeeklyProgress(concurrentInput),
    ]);
    await expect(
      managementRepository.runSalesWeeklyProgress({
        actor: manager,
        idempotencyKey: "postgres-management-query-unassigned",
        subjectUserId: UNASSIGNED_USER_ID,
        periodStart: MANAGEMENT_PERIOD_START,
        periodEnd: MANAGEMENT_PERIOD_END,
        queryNow: MANAGEMENT_QUERY_NOW,
        dataCutoffAt: MANAGEMENT_DATA_CUTOFF,
      }),
    ).rejects.toBeInstanceOf(ManagementQuerySubjectNotFoundError);
    await expect(
      managementRepository.runSalesWeeklyProgress({
        actor: {
          tenantId: SYNTHETIC_OTHER_TENANT_ID,
          userId: SYNTHETIC_OTHER_USER_ID,
        },
        idempotencyKey: "postgres-management-query-foreign",
        subjectUserId: SYNTHETIC_USER_ID,
        periodStart: MANAGEMENT_PERIOD_START,
        periodEnd: MANAGEMENT_PERIOD_END,
        queryNow: MANAGEMENT_QUERY_NOW,
        dataCutoffAt: MANAGEMENT_DATA_CUTOFF,
      }),
    ).rejects.toBeInstanceOf(ManagementQuerySubjectNotFoundError);
    const managementAudits = await readManagementQueryAudits(database);
    const workspacePlans = await readWorkspacePlanEvidence(database);

    expect(firstRun.map((migration) => migration.name)).toEqual([
      "0001_foundation",
      "0002_customer_operations",
      "0003_followup_confirmation",
      "0004_battle_analysis_actions",
      "0005_reminders_notifications",
    ]);
    expect(secondRun).toEqual([]);
    expect(rlsState.rows[0]).toEqual({ protected_count: 40, total_count: 40 });
    expect(page.items.map((item) => item.id)).toEqual([SYNTHETIC_ENTITY_ID]);
    expect(confirmation.status).toBe("confirmed");
    expect(analysis.status).toBe("completed");
    expect(action.status).toBe("accepted");
    expect(stateDetail.state.entityId).toBe(SYNTHETIC_ENTITY_ID);
    expect(stateDetail.evidenceFacts).toHaveLength(1);
    expect(stateDetail.signals).toHaveLength(1);
    expect(mapPage.items.map((item) => item.entityId)).toEqual([
      SYNTHETIC_ENTITY_ID,
    ]);
    expect(proposalDetail).toMatchObject({
      proposalId: analysis.proposalIds[0],
      status: "accepted",
      actionId: action.actionId,
    });
    expect(proposalPage.items.map((item) => item.proposalId)).toEqual([
      analysis.proposalIds[0],
    ]);
    expect(actionDetail).toMatchObject({
      actionId: action.actionId,
      status: "planned",
      sourceProposalId: analysis.proposalIds[0],
    });
    expect(actionPage.items.map((item) => item.actionId)).toEqual([
      action.actionId,
    ]);
    expect(workspace).toMatchObject({
      scopeMode: "personal",
      kpis: {
        assignedEntityCount: 1,
        pendingDraftCount: 0,
        pendingProposalCount: 0,
        overdueActionCount: 1,
        unreadNotificationCount: 0,
        highRiskEntityCount: 0,
        dataIncompleteEntityCount: 0,
      },
      priorityActions: [
        expect.objectContaining({
          actionId: action.actionId,
          isOverdue: true,
        }),
      ],
      quadrantDistribution: [
        { quadrantCode: "high_relationship_high_potential", count: 1 },
      ],
    });
    expect(workspacePlans.assignment).toContain(
      "entity_assignments_user_current_idx",
    );
    expect(workspacePlans.action).toContain("business_actions_owner_due_idx");
    expect(workspacePlans.managementScope).toMatch(
      /entity_assignments_(?:user|entity)_current_idx/,
    );
    expect(workspacePlans.managementOpenAction).toContain(
      "business_actions_entity_idx",
    );
    expect(workspacePlans.managementOpenAction).toContain(
      "action_status_history_action_idx",
    );
    expect(managerSubjects).toEqual({
      items: [
        {
          userId: SYNTHETIC_USER_ID,
          displayName: "alpha-owner",
          scopeKind: "observed_portfolio",
        },
      ],
      nextCursor: null,
    });
    expect(sellerSubjects).toEqual({
      items: [
        {
          userId: SYNTHETIC_USER_ID,
          displayName: "alpha-owner",
          scopeKind: "self",
        },
      ],
      nextCursor: null,
    });
    expect(managerProgress).toMatchObject({
      queryId: MANAGER_QUERY_ID,
      subject: {
        userId: SYNTHETIC_USER_ID,
        displayName: "alpha-owner",
      },
      scope: { kind: "observed_portfolio", entityCount: 1 },
      metrics: {
        confirmedFollowupCount: 1,
        validFactCount: 1,
        stageChangeCount: 0,
        completedActionCount: 0,
        openActionCount: 1,
        overdueActionCount: 1,
      },
      dataGaps: [],
    });
    expect(
      new Set(managerProgress.highlights[0]?.evidence.map((item) => item.kind)),
    ).toEqual(new Set(["followup", "fact", "action", "battle_state"]));
    expect(
      managerProgress.highlights[0]?.evidence.some(
        (item) => item.evidenceId === stateDetail.state.battleStateVersionId,
      ),
    ).toBe(true);
    expect(
      managerProgress.highlights[0]?.evidence.some(
        (item) => item.evidenceId === FUTURE_MANAGEMENT_STATE_ID,
      ),
    ).toBe(false);
    expect(sellerProgress).toMatchObject({
      queryId: SELLER_QUERY_ID,
      scope: { kind: "self", entityCount: 1 },
      metrics: managerProgress.metrics,
    });
    expect(concurrentFirst).toEqual(concurrentSecond);
    expect(concurrentFirst.queryId).toBe(CONCURRENT_MANAGER_QUERY_ID);
    expect(managementAudits).toHaveLength(3);
    expect(
      managementAudits.map((audit) => ({
        aggregate_id: audit.aggregate_id,
        actor_user_id: audit.actor_user_id,
        action: audit.action,
      })),
    ).toEqual([
      {
        aggregate_id: MANAGER_QUERY_ID,
        actor_user_id: MANAGER_ID,
        action: "management_query.executed",
      },
      {
        aggregate_id: SELLER_QUERY_ID,
        actor_user_id: SYNTHETIC_USER_ID,
        action: "management_query.executed",
      },
      {
        aggregate_id: CONCURRENT_MANAGER_QUERY_ID,
        actor_user_id: MANAGER_ID,
        action: "management_query.executed",
      },
    ]);
    expect(JSON.stringify(managementAudits)).not.toContain(
      "Synthetic customer confirmed the budget.",
    );
    expect(confirmationCounts).toEqual({
      action_count: 1,
      followup_count: 1,
      history_count: 1,
      outbox_count: 2,
      state_count: 1,
    });
  });
});

async function readWorkspacePlanEvidence(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<{
  assignment: string;
  action: string;
  managementScope: string;
  managementOpenAction: string;
}> {
  return withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: "90000000-0000-4000-8000-000000000012",
    },
    async (transaction) => {
      await sql`set local enable_seqscan = off`.execute(transaction);
      const assignmentPlan = await sql<{ "QUERY PLAN": unknown }>`
        explain (format json)
        select assignment.entity_id
        from app.entity_assignments as assignment
        where assignment.tenant_id = ${SYNTHETIC_TENANT_ID}::uuid
          and assignment.user_id = ${SYNTHETIC_USER_ID}::uuid
          and assignment.valid_from <= '2026-09-04T00:00:00.000Z'::timestamptz
          and (
            assignment.valid_to is null
            or assignment.valid_to > '2026-09-04T00:00:00.000Z'::timestamptz
          )
      `.execute(transaction);
      const actionPlan = await sql<{ "QUERY PLAN": unknown }>`
        explain (format json)
        select action.id
        from app.business_actions as action
        where action.tenant_id = ${SYNTHETIC_TENANT_ID}::uuid
          and action.owner_user_id = ${SYNTHETIC_USER_ID}::uuid
          and action.status in ('planned', 'in_progress')
        order by action.planned_at, action.id
        limit 5
      `.execute(transaction);
      const managementScopePlan = await sql<{ "QUERY PLAN": unknown }>`
        explain (format json)
        select subject_assignment.entity_id
        from app.entity_assignments as subject_assignment
        inner join app.entity_assignments as observer_assignment
          on observer_assignment.tenant_id = subject_assignment.tenant_id
          and observer_assignment.entity_id = subject_assignment.entity_id
        where subject_assignment.tenant_id = ${SYNTHETIC_TENANT_ID}::uuid
          and subject_assignment.user_id = ${SYNTHETIC_USER_ID}::uuid
          and subject_assignment.assignment_role in ('owner', 'collaborator')
          and subject_assignment.valid_from <= ${MANAGEMENT_QUERY_NOW}::timestamptz
          and (
            subject_assignment.valid_to is null
            or subject_assignment.valid_to > ${MANAGEMENT_QUERY_NOW}::timestamptz
          )
          and observer_assignment.user_id = ${MANAGER_ID}::uuid
          and observer_assignment.assignment_role = 'management_observer'
          and observer_assignment.valid_from <= ${MANAGEMENT_QUERY_NOW}::timestamptz
          and (
            observer_assignment.valid_to is null
            or observer_assignment.valid_to > ${MANAGEMENT_QUERY_NOW}::timestamptz
          )
      `.execute(transaction);
      const managementOpenActionPlan = await sql<{ "QUERY PLAN": unknown }>`
        explain (format json)
        select action.id
        from app.business_actions as action
        inner join lateral (
          select history.to_status
          from app.action_status_history as history
          where history.tenant_id = action.tenant_id
            and history.action_id = action.id
            and history.changed_at < ${MANAGEMENT_PERIOD_END}::timestamptz
            and history.changed_at <= ${MANAGEMENT_DATA_CUTOFF}::timestamptz
          order by history.version_no desc
          limit 1
        ) as cutoff_status on true
        where action.tenant_id = ${SYNTHETIC_TENANT_ID}::uuid
          and action.entity_id = ${SYNTHETIC_ENTITY_ID}::uuid
          and action.owner_user_id = ${SYNTHETIC_USER_ID}::uuid
          and action.confirmed_at < ${MANAGEMENT_PERIOD_END}::timestamptz
          and action.confirmed_at <= ${MANAGEMENT_DATA_CUTOFF}::timestamptz
          and cutoff_status.to_status in ('planned', 'in_progress')
      `.execute(transaction);
      return {
        assignment: JSON.stringify(
          assignmentPlan.rows[0]?.["QUERY PLAN"] ?? null,
        ),
        action: JSON.stringify(actionPlan.rows[0]?.["QUERY PLAN"] ?? null),
        managementScope: JSON.stringify(
          managementScopePlan.rows[0]?.["QUERY PLAN"] ?? null,
        ),
        managementOpenAction: JSON.stringify(
          managementOpenActionPlan.rows[0]?.["QUERY PLAN"] ?? null,
        ),
      };
    },
  );
}

async function seedSyntheticManagementScope(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: "90000000-0000-4000-8000-000000000015",
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
            display_name: "synthetic-manager",
            email: null,
            mobile: null,
            status: "active",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: UNASSIGNED_USER_ID,
            display_name: "synthetic-unassigned",
            email: null,
            mobile: null,
            status: "active",
          },
        ])
        .execute();
      await transaction
        .insertInto("app.entity_assignments")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: "60000000-0000-4000-8000-000000000013",
          entity_id: SYNTHETIC_ENTITY_ID,
          user_id: MANAGER_ID,
          assignment_role: "management_observer",
          is_primary: false,
          valid_from: "2026-08-01T00:00:00.000Z",
          valid_to: null,
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function seedSyntheticBoundaryEvidence(
  database: DatabaseHandle<BattlefieldDatabase>,
  followupId: string,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: "90000000-0000-4000-8000-000000000017",
    },
    async (transaction) => {
      const runId = "a0000000-0000-4000-8000-000000000013";
      const inputVersion = "f".repeat(64);
      await transaction
        .insertInto("app.analysis_runs")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: runId,
          entity_id: SYNTHETIC_ENTITY_ID,
          trigger_event_id: null,
          rule_version: "postgres-boundary-v2",
          analyzer_config_version: "deterministic-v1",
          input_version: inputVersion,
          status: "completed",
          error_code: null,
          error_message: null,
          started_at: MANAGEMENT_PERIOD_END,
          finished_at: MANAGEMENT_PERIOD_END,
          created_by: SYNTHETIC_USER_ID,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.battle_state_versions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: FUTURE_MANAGEMENT_STATE_ID,
          entity_id: SYNTHETIC_ENTITY_ID,
          version_no: 2,
          input_version: inputVersion,
          relationship_score: 88,
          potential_score: 77,
          quadrant_code: "boundary_state",
          primary_opportunity_id: null,
          risk_level: "low",
          data_sufficiency: "sufficient",
          data_gaps: JSON.stringify([]),
          summary: "Boundary state must belong to the next period.",
          analysis_run_id: runId,
          effective_at: MANAGEMENT_PERIOD_END,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("app.battle_state_current")
        .set({
          battle_state_version_id: FUTURE_MANAGEMENT_STATE_ID,
          version_no: 2,
          input_version: inputVersion,
          updated_at: MANAGEMENT_PERIOD_END,
        })
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("entity_id", "=", SYNTHETIC_ENTITY_ID)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.business_facts")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: "70000000-0000-4000-8000-000000000013",
          entity_id: SYNTHETIC_ENTITY_ID,
          opportunity_id: null,
          followup_id: followupId,
          fact_type: "boundary.note",
          fact_value: "Boundary fact must belong to the next period.",
          occurred_at: MANAGEMENT_PERIOD_END,
          confirmed_at: MANAGEMENT_PERIOD_END,
          confirmed_by: SYNTHETIC_USER_ID,
          valid_status: "valid",
          supersedes_fact_id: null,
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function readManagementQueryAudits(
  database: DatabaseHandle<BattlefieldDatabase>,
) {
  return withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: "90000000-0000-4000-8000-000000000016",
    },
    (transaction) =>
      transaction
        .selectFrom("app.audit_entries")
        .select(["aggregate_id", "actor_user_id", "action", "after_payload"])
        .where("aggregate_type", "=", "management_query")
        .orderBy("aggregate_id")
        .execute(),
  );
}

async function resetApplicationSchemas(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`drop schema if exists app cascade`.execute(database.db);
  await sql`drop schema if exists app_meta cascade`.execute(database.db);
}
