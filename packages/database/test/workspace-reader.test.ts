import { fileURLToPath } from "node:url";
import {
  ActionProposalNotFoundError,
  BattleStateNotFoundError,
  BusinessActionNotFoundError,
} from "@battlefield/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { KyselyActionQueryReader } from "../src/action-decisions/kysely-action-query-reader.js";
import { KyselyBattleQueryReader } from "../src/battle-analysis/kysely-battle-query-reader.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
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
import { seedSyntheticReminderConfiguration } from "../src/testing/synthetic-reminders.js";
import {
  InvalidWorkspaceNowError,
  KyselyWorkspaceReader,
} from "../src/workspace/kysely-workspace-reader.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const REQUEST_ID = "90000000-0000-4000-8000-000000000081";
const NOW = "2026-09-01T00:00:00.000Z";
const COLLEAGUE_ID = "30000000-0000-4000-8000-000000000003";
const MANAGER_ID = "30000000-0000-4000-8000-000000000004";
const UNASSIGNED_USER_ID = "30000000-0000-4000-8000-000000000005";
const FUTURE_OWNER_ID = "30000000-0000-4000-8000-000000000006";
const OBSERVED_ENTITY_ID = "50000000-0000-4000-8000-000000000003";
const UNASSIGNED_ENTITY_ID = "50000000-0000-4000-8000-000000000004";
const ENDED_ENTITY_ID = "50000000-0000-4000-8000-000000000005";
const OWNED_CURRENT_STATE_ID = "b1000000-0000-4000-8000-000000000002";
const OWNED_PREVIOUS_STATE_ID = "b1000000-0000-4000-8000-000000000001";
const OBSERVED_SOURCE_STATE_ID = "b1000000-0000-4000-8000-000000000003";
const UNASSIGNED_STATE_ID = "b1000000-0000-4000-8000-000000000004";
const ENDED_STATE_ID = "b1000000-0000-4000-8000-000000000005";
const OWN_ACTION_ID = "d1000000-0000-4000-8000-000000000001";
const COLLEAGUE_OWN_ENTITY_ACTION_ID = "d1000000-0000-4000-8000-000000000002";
const OBSERVED_ACTION_ID = "d1000000-0000-4000-8000-000000000003";
const COMPLETED_OBSERVED_ACTION_ID = "d1000000-0000-4000-8000-000000000004";
const UNASSIGNED_ACTION_ID = "d1000000-0000-4000-8000-000000000005";
const ENDED_ACTION_ID = "d1000000-0000-4000-8000-000000000006";
const OWN_PROPOSAL_ID = "c1000000-0000-4000-8000-000000000001";
const OBSERVED_PROPOSAL_ID = "c1000000-0000-4000-8000-000000000002";
const UNASSIGNED_PROPOSAL_ID = "c1000000-0000-4000-8000-000000000003";
const ENDED_PROPOSAL_ID = "c1000000-0000-4000-8000-000000000005";
const actor = { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID };
const manager = { tenantId: SYNTHETIC_TENANT_ID, userId: MANAGER_ID };
const colleague = { tenantId: SYNTHETIC_TENANT_ID, userId: COLLEAGUE_ID };
const unassignedUser = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: UNASSIGNED_USER_ID,
};
const otherActor = {
  tenantId: SYNTHETIC_OTHER_TENANT_ID,
  userId: SYNTHETIC_OTHER_USER_ID,
};

describe("Kysely role-scoped workspace reader", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let reader: KyselyWorkspaceReader;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedWorkspaceScenario(database);
    reader = new KyselyWorkspaceReader(database.db);
  });

  afterEach(async () => {
    await database.close();
  });

  test("builds one mixed workspace from active assignments and actor-specific responsibilities", async () => {
    const result = await reader.read({ actor, now: NOW });

    expect(result.scopeMode).toBe("mixed");
    expect(result.kpis).toEqual({
      assignedEntityCount: 2,
      pendingDraftCount: 1,
      pendingProposalCount: 2,
      overdueActionCount: 1,
      unreadNotificationCount: 2,
      highRiskEntityCount: 1,
      dataIncompleteEntityCount: 2,
    });
    expect(result.priorityActions.map((action) => action.actionId)).toEqual([
      OWN_ACTION_ID,
      OBSERVED_ACTION_ID,
    ]);
    expect(result.priorityActions[0]).toMatchObject({
      ownerUserId: SYNTHETIC_USER_ID,
      isOverdue: true,
      deepLink: `/actions?actionId=${OWN_ACTION_ID}`,
    });
    expect(result.priorityActions[1]).toMatchObject({
      ownerUserId: COLLEAGUE_ID,
      isOverdue: false,
    });
    expect(result.priorityActions).not.toContainEqual(
      expect.objectContaining({ actionId: COLLEAGUE_OWN_ENTITY_ACTION_ID }),
    );

    expect(result.recentBattleChanges).toHaveLength(1);
    const change = result.recentBattleChanges[0];
    expect(change).toMatchObject({
      entityId: SYNTHETIC_ENTITY_ID,
      battleStateVersionId: OWNED_CURRENT_STATE_ID,
      quadrantCode: "focus",
      riskLevel: "high",
      dataSufficiency: "partial",
      previousState: {
        battleStateVersionId: OWNED_PREVIOUS_STATE_ID,
        quadrantCode: "develop",
      },
      relationshipDelta: 15,
      potentialDelta: 12,
      quadrantChanged: true,
      changeKind: "updated",
      deepLink: `/battle-map?entityId=${SYNTHETIC_ENTITY_ID}&stateVersion=${OWNED_CURRENT_STATE_ID}`,
    });
    expect(Number(change?.relationshipScore)).toBe(75);
    expect(Number(change?.potentialScore)).toBe(82);
    expect(result.quadrantDistribution).toEqual([
      { quadrantCode: "focus", count: 1 },
      { quadrantCode: null, count: 1 },
    ]);
  });

  test("separates observer, personal, empty, and foreign-tenant scopes", async () => {
    const observed = await reader.read({ actor: manager, now: NOW });
    expect(observed).toMatchObject({
      scopeMode: "observed_portfolio",
      kpis: {
        assignedEntityCount: 1,
        pendingDraftCount: 0,
        pendingProposalCount: 1,
        overdueActionCount: 0,
        unreadNotificationCount: 0,
        highRiskEntityCount: 0,
        dataIncompleteEntityCount: 1,
      },
      priorityActions: [
        expect.objectContaining({ actionId: OBSERVED_ACTION_ID }),
      ],
      recentBattleChanges: [],
      quadrantDistribution: [{ quadrantCode: null, count: 1 }],
    });

    const personal = await reader.read({ actor: colleague, now: NOW });
    expect(personal.scopeMode).toBe("personal");
    expect(personal.kpis.assignedEntityCount).toBe(3);
    expect(personal.priorityActions).toContainEqual(
      expect.objectContaining({ actionId: OBSERVED_ACTION_ID }),
    );

    const empty = await reader.read({ actor: unassignedUser, now: NOW });
    expect(empty).toMatchObject({
      scopeMode: "personal",
      kpis: {
        assignedEntityCount: 0,
        pendingDraftCount: 0,
        pendingProposalCount: 0,
        overdueActionCount: 0,
        unreadNotificationCount: 0,
        highRiskEntityCount: 0,
        dataIncompleteEntityCount: 0,
      },
      priorityActions: [],
      recentBattleChanges: [],
      quadrantDistribution: [],
    });

    const foreignTenant = await reader.read({ actor: otherActor, now: NOW });
    expect(foreignTenant.kpis.assignedEntityCount).toBe(1);
    expect(foreignTenant.kpis.pendingProposalCount).toBe(0);
    expect(foreignTenant.priorityActions).toEqual([]);
    expect(foreignTenant.quadrantDistribution).toEqual([
      { quadrantCode: null, count: 1 },
    ]);
  });

  test("deduplicates multiple assignments, ignores ended scope, and keeps lists bounded", async () => {
    await seedAdditionalOwnedActions(database, 6);

    const first = await reader.read({ actor, now: NOW });
    const repeated = await reader.read({ actor, now: NOW });

    expect(first).toEqual(repeated);
    expect(first.kpis.assignedEntityCount).toBe(2);
    expect(first.kpis.overdueActionCount).toBe(7);
    expect(first.priorityActions).toHaveLength(5);
    expect(
      new Set(first.priorityActions.map((action) => action.actionId)),
    ).toHaveLength(5);
    expect(
      first.priorityActions.every(
        (action) =>
          action.entityId !== ENDED_ENTITY_ID &&
          action.entityId !== UNASSIGNED_ENTITY_ID,
      ),
    ).toBe(true);
  });

  test("authorizes exact historical action reads without widening active assignment scope", async () => {
    const actionReader = new KyselyActionQueryReader(database.db);

    await expect(
      actionReader.getAction({ actor, actionId: OWN_ACTION_ID }),
    ).resolves.toMatchObject({ actionId: OWN_ACTION_ID });
    await expect(
      actionReader.getAction({ actor: manager, actionId: OBSERVED_ACTION_ID }),
    ).resolves.toMatchObject({ actionId: OBSERVED_ACTION_ID });
    await expect(
      actionReader.getAction({
        actor: manager,
        actionId: COMPLETED_OBSERVED_ACTION_ID,
      }),
    ).resolves.toMatchObject({
      actionId: COMPLETED_OBSERVED_ACTION_ID,
      status: "completed",
      canTransition: false,
    });
    await expect(
      actionReader.getAction({
        actor: colleague,
        actionId: COMPLETED_OBSERVED_ACTION_ID,
      }),
    ).resolves.toMatchObject({ actionId: COMPLETED_OBSERVED_ACTION_ID });

    for (const [deniedActor, actionId] of [
      [actor, COLLEAGUE_OWN_ENTITY_ACTION_ID],
      [actor, UNASSIGNED_ACTION_ID],
      [actor, ENDED_ACTION_ID],
      [unassignedUser, OWN_ACTION_ID],
      [otherActor, OWN_ACTION_ID],
    ] as const) {
      await expect(
        actionReader.getAction({ actor: deniedActor, actionId }),
      ).rejects.toBeInstanceOf(BusinessActionNotFoundError);
    }

    await expect(
      actionReader.listActions({ actor, limit: 20 }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ actionId: OWN_ACTION_ID }),
        expect.objectContaining({ actionId: OBSERVED_ACTION_ID }),
      ],
      nextCursor: null,
    });
    await expect(
      actionReader.listActions({ actor: manager, limit: 20 }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ actionId: OBSERVED_ACTION_ID })],
      nextCursor: null,
    });
    await expect(
      actionReader.listActions({ actor: unassignedUser, limit: 20 }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  test("keeps proposal reads inside active assignment scope while allowing observer read-only access", async () => {
    const actionReader = new KyselyActionQueryReader(database.db);

    await expect(
      actionReader.getProposal({ actor, proposalId: OWN_PROPOSAL_ID }),
    ).resolves.toMatchObject({ proposalId: OWN_PROPOSAL_ID, canDecide: true });
    await expect(
      actionReader.getProposal({
        actor: manager,
        proposalId: OBSERVED_PROPOSAL_ID,
      }),
    ).resolves.toMatchObject({
      proposalId: OBSERVED_PROPOSAL_ID,
      canDecide: false,
    });
    await expect(
      actionReader.listProposals({
        actor: manager,
        status: "pending_confirmation",
        limit: 20,
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ proposalId: OBSERVED_PROPOSAL_ID })],
      nextCursor: null,
    });

    for (const [deniedActor, proposalId] of [
      [actor, UNASSIGNED_PROPOSAL_ID],
      [actor, ENDED_PROPOSAL_ID],
      [unassignedUser, OWN_PROPOSAL_ID],
      [otherActor, OWN_PROPOSAL_ID],
    ] as const) {
      await expect(
        actionReader.getProposal({ actor: deniedActor, proposalId }),
      ).rejects.toBeInstanceOf(ActionProposalNotFoundError);
    }
    await expect(
      actionReader.listProposals({ actor: unassignedUser, limit: 20 }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  test("keeps map lists and exact battle-state reads inside active assignment scope", async () => {
    const battleReader = new KyselyBattleQueryReader(database.db);

    await expect(
      battleReader.listMap({ actor: manager, limit: 20 }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          entityId: OBSERVED_ENTITY_ID,
          primaryOwnerName: "协同销售",
        }),
      ],
      nextCursor: null,
    });
    await expect(
      battleReader.getVersion({
        actor: manager,
        entityId: OBSERVED_ENTITY_ID,
        battleStateVersionId: OBSERVED_SOURCE_STATE_ID,
      }),
    ).resolves.toMatchObject({
      state: { battleStateVersionId: OBSERVED_SOURCE_STATE_ID },
    });

    for (const [entityId, stateId] of [
      [UNASSIGNED_ENTITY_ID, UNASSIGNED_STATE_ID],
      [ENDED_ENTITY_ID, ENDED_STATE_ID],
    ] as const) {
      await expect(
        battleReader.getVersion({
          actor,
          entityId,
          battleStateVersionId: stateId,
        }),
      ).rejects.toBeInstanceOf(BattleStateNotFoundError);
    }
    await expect(
      battleReader.getVersion({
        actor: otherActor,
        entityId: SYNTHETIC_ENTITY_ID,
        battleStateVersionId: OWNED_CURRENT_STATE_ID,
      }),
    ).rejects.toBeInstanceOf(BattleStateNotFoundError);
    await expect(
      battleReader.listMap({ actor: unassignedUser, limit: 20 }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  test("rejects an invalid projection instant before opening a query snapshot", async () => {
    await expect(
      reader.read({ actor, now: "not-an-instant" }),
    ).rejects.toBeInstanceOf(InvalidWorkspaceNowError);
  });
});

async function seedWorkspaceScenario(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .insertInto("app.users")
        .values([
          userRow(COLLEAGUE_ID, "协同销售"),
          userRow(MANAGER_ID, "观察管理者"),
          userRow(UNASSIGNED_USER_ID, "无责任用户"),
          userRow(FUTURE_OWNER_ID, "未来负责人"),
        ])
        .execute();
      await transaction
        .insertInto("app.business_entities")
        .values([
          entityRow(OBSERVED_ENTITY_ID, "观察对象"),
          entityRow(UNASSIGNED_ENTITY_ID, "未分配对象"),
          entityRow(ENDED_ENTITY_ID, "已结束责任对象"),
        ])
        .execute();
      await transaction
        .insertInto("app.entity_assignments")
        .values([
          assignmentRow(
            "61000000-0000-4000-8000-000000000001",
            SYNTHETIC_ENTITY_ID,
            SYNTHETIC_USER_ID,
            "collaborator",
          ),
          {
            ...assignmentRow(
              "61000000-0000-4000-8000-000000000002",
              OBSERVED_ENTITY_ID,
              COLLEAGUE_ID,
              "owner",
              true,
            ),
            valid_to: "2099-01-01T00:00:00.000Z",
          },
          assignmentRow(
            "61000000-0000-4000-8000-000000000003",
            OBSERVED_ENTITY_ID,
            SYNTHETIC_USER_ID,
            "management_observer",
          ),
          assignmentRow(
            "61000000-0000-4000-8000-000000000004",
            OBSERVED_ENTITY_ID,
            MANAGER_ID,
            "management_observer",
          ),
          assignmentRow(
            "61000000-0000-4000-8000-000000000005",
            UNASSIGNED_ENTITY_ID,
            COLLEAGUE_ID,
            "owner",
            true,
          ),
          assignmentRow(
            "61000000-0000-4000-8000-000000000006",
            ENDED_ENTITY_ID,
            COLLEAGUE_ID,
            "owner",
            true,
          ),
          {
            ...assignmentRow(
              "61000000-0000-4000-8000-000000000007",
              ENDED_ENTITY_ID,
              SYNTHETIC_USER_ID,
              "owner",
            ),
            valid_from: "2026-08-01T00:00:00.000Z",
            valid_to: "2026-08-15T00:00:00.000Z",
          },
          {
            ...assignmentRow(
              "61000000-0000-4000-8000-000000000008",
              OBSERVED_ENTITY_ID,
              FUTURE_OWNER_ID,
              "owner",
              true,
            ),
            valid_from: "2099-01-01T00:00:00.000Z",
          },
        ])
        .execute();
    },
  );

  await seedBattleState(database, {
    entityId: SYNTHETIC_ENTITY_ID,
    runId: "a1000000-0000-4000-8000-000000000001",
    stateId: OWNED_PREVIOUS_STATE_ID,
    versionNo: 1,
    inputVersion: "1".repeat(64),
    relationshipScore: 60,
    potentialScore: 70,
    quadrantCode: "develop",
    riskLevel: "medium",
    dataSufficiency: "sufficient",
    dataGaps: [],
    effectiveAt: "2026-08-31T02:00:00.000Z",
  });
  await seedBattleState(database, {
    entityId: SYNTHETIC_ENTITY_ID,
    runId: "a1000000-0000-4000-8000-000000000002",
    stateId: OWNED_CURRENT_STATE_ID,
    versionNo: 2,
    inputVersion: "2".repeat(64),
    relationshipScore: 75,
    potentialScore: 82,
    quadrantCode: "focus",
    riskLevel: "high",
    dataSufficiency: "partial",
    dataGaps: ["缺少采购时间表"],
    effectiveAt: "2026-08-31T03:00:00.000Z",
    makeCurrent: true,
  });
  await seedBattleState(database, {
    entityId: OBSERVED_ENTITY_ID,
    runId: "a1000000-0000-4000-8000-000000000003",
    stateId: OBSERVED_SOURCE_STATE_ID,
    versionNo: 1,
    inputVersion: "3".repeat(64),
    relationshipScore: 45,
    potentialScore: 65,
    quadrantCode: "develop",
    riskLevel: "medium",
    dataSufficiency: "partial",
    dataGaps: ["缺少近期跟进"],
    effectiveAt: "2026-08-31T02:30:00.000Z",
  });
  await seedBattleState(database, {
    entityId: UNASSIGNED_ENTITY_ID,
    runId: "a1000000-0000-4000-8000-000000000004",
    stateId: UNASSIGNED_STATE_ID,
    versionNo: 1,
    inputVersion: "4".repeat(64),
    relationshipScore: 90,
    potentialScore: 90,
    quadrantCode: "focus",
    riskLevel: "critical",
    dataSufficiency: "sufficient",
    dataGaps: [],
    effectiveAt: "2026-08-31T03:30:00.000Z",
    makeCurrent: true,
  });
  await seedBattleState(database, {
    entityId: ENDED_ENTITY_ID,
    runId: "a1000000-0000-4000-8000-000000000005",
    stateId: ENDED_STATE_ID,
    versionNo: 1,
    inputVersion: "5".repeat(64),
    relationshipScore: 80,
    potentialScore: 80,
    quadrantCode: "focus",
    riskLevel: "low",
    dataSufficiency: "sufficient",
    dataGaps: [],
    effectiveAt: "2026-08-31T03:15:00.000Z",
    makeCurrent: true,
  });

  await seedPendingDrafts(database);
  await seedPendingProposals(database);
  await seedAction(database, {
    actionId: OWN_ACTION_ID,
    proposalId: "c1000000-0000-4000-8000-000000000011",
    entityId: SYNTHETIC_ENTITY_ID,
    sourceStateId: OWNED_CURRENT_STATE_ID,
    ownerUserId: SYNTHETIC_USER_ID,
    title: "提交正式方案",
    priority: "urgent",
    plannedAt: "2026-08-31T23:00:00.000Z",
  });
  await seedAction(database, {
    actionId: COLLEAGUE_OWN_ENTITY_ACTION_ID,
    proposalId: "c1000000-0000-4000-8000-000000000012",
    entityId: SYNTHETIC_ENTITY_ID,
    sourceStateId: OWNED_CURRENT_STATE_ID,
    ownerUserId: COLLEAGUE_ID,
    title: "不应向普通协作者展示",
    priority: "high",
    plannedAt: "2026-08-31T22:00:00.000Z",
  });
  await seedAction(database, {
    actionId: OBSERVED_ACTION_ID,
    proposalId: "c1000000-0000-4000-8000-000000000013",
    entityId: OBSERVED_ENTITY_ID,
    sourceStateId: OBSERVED_SOURCE_STATE_ID,
    ownerUserId: COLLEAGUE_ID,
    title: "管理观察范围动作",
    priority: "high",
    status: "in_progress",
    plannedAt: "2026-09-02T09:00:00.000Z",
  });
  await seedAction(database, {
    actionId: "d1000000-0000-4000-8000-000000000004",
    proposalId: "c1000000-0000-4000-8000-000000000014",
    entityId: OBSERVED_ENTITY_ID,
    sourceStateId: OBSERVED_SOURCE_STATE_ID,
    ownerUserId: COLLEAGUE_ID,
    title: "已完成动作",
    priority: "medium",
    status: "completed",
    plannedAt: "2026-08-31T20:00:00.000Z",
    completedAt: "2026-08-31T21:00:00.000Z",
  });
  await seedAction(database, {
    actionId: "d1000000-0000-4000-8000-000000000005",
    proposalId: "c1000000-0000-4000-8000-000000000015",
    entityId: UNASSIGNED_ENTITY_ID,
    sourceStateId: UNASSIGNED_STATE_ID,
    ownerUserId: SYNTHETIC_USER_ID,
    title: "未分配对象动作",
    priority: "urgent",
    plannedAt: "2026-08-31T19:00:00.000Z",
  });
  await seedAction(database, {
    actionId: "d1000000-0000-4000-8000-000000000006",
    proposalId: "c1000000-0000-4000-8000-000000000016",
    entityId: ENDED_ENTITY_ID,
    sourceStateId: ENDED_STATE_ID,
    ownerUserId: SYNTHETIC_USER_ID,
    title: "已结束责任动作",
    priority: "urgent",
    plannedAt: "2026-08-31T18:00:00.000Z",
  });

  await seedSyntheticReminderConfiguration(database);
  await seedNotifications(database, OWN_ACTION_ID);
}

function userRow(userId: string, displayName: string) {
  return {
    tenant_id: SYNTHETIC_TENANT_ID,
    id: userId,
    display_name: displayName,
    email: null,
    mobile: null,
    status: "active" as const,
  };
}

function entityRow(entityId: string, name: string) {
  return {
    tenant_id: SYNTHETIC_TENANT_ID,
    id: entityId,
    type_id: "40000000-0000-4000-8000-000000000001",
    name,
    short_name: null,
    status: "active" as const,
    is_t0: false,
    metadata: JSON.stringify({}),
    version_no: 1,
    updated_at: "2026-08-31T03:00:00.000Z",
  };
}

function assignmentRow(
  id: string,
  entityId: string,
  userId: string,
  assignmentRole: "owner" | "collaborator" | "management_observer",
  isPrimary = false,
) {
  return {
    tenant_id: SYNTHETIC_TENANT_ID,
    id,
    entity_id: entityId,
    user_id: userId,
    assignment_role: assignmentRole,
    is_primary: isPrimary,
    valid_from: "2026-08-01T00:00:00.000Z",
    valid_to: null,
  };
}

async function seedBattleState(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    entityId: string;
    runId: string;
    stateId: string;
    versionNo: number;
    inputVersion: string;
    relationshipScore: number;
    potentialScore: number;
    quadrantCode: string;
    riskLevel: "low" | "medium" | "high" | "critical";
    dataSufficiency: "partial" | "sufficient";
    dataGaps: string[];
    effectiveAt: string;
    makeCurrent?: boolean;
  },
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .insertInto("app.analysis_runs")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: input.runId,
          entity_id: input.entityId,
          trigger_event_id: null,
          rule_version: "workspace-fixture-v1",
          analyzer_config_version: "deterministic-v1",
          input_version: input.inputVersion,
          status: "completed",
          error_code: null,
          error_message: null,
          started_at: "2026-08-31T01:00:00.000Z",
          finished_at: input.effectiveAt,
          created_by: SYNTHETIC_USER_ID,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.battle_state_versions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: input.stateId,
          entity_id: input.entityId,
          version_no: input.versionNo,
          input_version: input.inputVersion,
          relationship_score: input.relationshipScore,
          potential_score: input.potentialScore,
          quadrant_code: input.quadrantCode,
          primary_opportunity_id: null,
          risk_level: input.riskLevel,
          data_sufficiency: input.dataSufficiency,
          data_gaps: JSON.stringify(input.dataGaps),
          summary: `${input.entityId} workspace state`,
          analysis_run_id: input.runId,
          effective_at: input.effectiveAt,
        })
        .executeTakeFirstOrThrow();
      if (input.makeCurrent) {
        await transaction
          .insertInto("app.battle_state_current")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            entity_id: input.entityId,
            battle_state_version_id: input.stateId,
            version_no: input.versionNo,
            input_version: input.inputVersion,
            updated_at: input.effectiveAt,
          })
          .executeTakeFirstOrThrow();
      }
    },
  );
}

async function seedPendingDrafts(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const rows = [
        {
          sourceId: "81000000-0000-4000-8000-000000000001",
          draftId: "71000000-0000-4000-8000-000000000001",
          submitter: SYNTHETIC_USER_ID,
          expiresAt: "2026-09-02T00:00:00.000Z",
        },
        {
          sourceId: "81000000-0000-4000-8000-000000000002",
          draftId: "71000000-0000-4000-8000-000000000002",
          submitter: COLLEAGUE_ID,
          expiresAt: "2026-09-02T00:00:00.000Z",
        },
        {
          sourceId: "81000000-0000-4000-8000-000000000003",
          draftId: "71000000-0000-4000-8000-000000000003",
          submitter: SYNTHETIC_USER_ID,
          expiresAt: "2026-08-31T23:00:00.000Z",
        },
      ];
      for (const [index, row] of rows.entries()) {
        await transaction
          .insertInto("app.source_inputs")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: row.sourceId,
            source_type: "web",
            source_message_id: null,
            submitted_by: row.submitter,
            raw_content: `workspace draft ${index}`,
            content_hash: String(index + 6).repeat(64),
            received_at: "2026-08-30T00:00:00.000Z",
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.followup_drafts")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: row.draftId,
            source_input_id: row.sourceId,
            entity_id: SYNTHETIC_ENTITY_ID,
            status: "pending_confirmation",
            candidate_payload: JSON.stringify({ summary: `draft ${index}` }),
            created_by: row.submitter,
            expires_at: row.expiresAt,
            confirmed_at: null,
            confirmed_by: null,
            cancelled_at: null,
            version_no: 1,
            created_at: "2026-08-30T00:00:00.000Z",
            updated_at: "2026-08-30T00:00:00.000Z",
          })
          .executeTakeFirstOrThrow();
      }
    },
  );
}

async function seedPendingProposals(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const proposals = [
        {
          id: "c1000000-0000-4000-8000-000000000001",
          entityId: SYNTHETIC_ENTITY_ID,
          stateId: OWNED_CURRENT_STATE_ID,
          ownerId: SYNTHETIC_USER_ID,
          expiresAt: "2026-09-03T00:00:00.000Z",
        },
        {
          id: "c1000000-0000-4000-8000-000000000002",
          entityId: OBSERVED_ENTITY_ID,
          stateId: OBSERVED_SOURCE_STATE_ID,
          ownerId: COLLEAGUE_ID,
          expiresAt: "2026-09-03T00:00:00.000Z",
        },
        {
          id: "c1000000-0000-4000-8000-000000000003",
          entityId: UNASSIGNED_ENTITY_ID,
          stateId: UNASSIGNED_STATE_ID,
          ownerId: SYNTHETIC_USER_ID,
          expiresAt: "2026-09-03T00:00:00.000Z",
        },
        {
          id: "c1000000-0000-4000-8000-000000000004",
          entityId: SYNTHETIC_ENTITY_ID,
          stateId: OWNED_CURRENT_STATE_ID,
          ownerId: SYNTHETIC_USER_ID,
          expiresAt: "2026-08-31T23:00:00.000Z",
        },
        {
          id: ENDED_PROPOSAL_ID,
          entityId: ENDED_ENTITY_ID,
          stateId: ENDED_STATE_ID,
          ownerId: SYNTHETIC_USER_ID,
          expiresAt: "2026-09-03T00:00:00.000Z",
        },
      ];
      await transaction
        .insertInto("app.action_proposals")
        .values(
          proposals.map((proposal, index) => ({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: proposal.id,
            entity_id: proposal.entityId,
            opportunity_id: null,
            title: `待确认建议 ${index}`,
            description: "等待人工确认",
            suggested_owner_id: proposal.ownerId,
            suggested_priority: "high" as const,
            suggested_planned_at: "2026-09-04T00:00:00.000Z",
            source_battle_state_version_id: proposal.stateId,
            status: "pending_confirmation" as const,
            version_no: 1,
            proposed_at: "2026-08-31T00:00:00.000Z",
            expires_at: proposal.expiresAt,
            decided_at: null,
            decided_by: null,
            decision_reason: null,
          })),
        )
        .execute();
    },
  );
}

async function seedAction(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    actionId: string;
    proposalId: string;
    entityId: string;
    sourceStateId: string;
    ownerUserId: string;
    title: string;
    priority: "low" | "medium" | "high" | "urgent";
    status?: "planned" | "in_progress" | "completed";
    plannedAt: string;
    completedAt?: string;
  },
): Promise<void> {
  const confirmedAt = "2026-08-30T00:00:00.000Z";
  const status = input.status ?? "planned";
  const versionNo = status === "completed" ? 3 : status === "planned" ? 1 : 2;
  const transitionedAt = input.completedAt ?? "2026-08-31T12:00:00.000Z";
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .insertInto("app.action_proposals")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: input.proposalId,
          entity_id: input.entityId,
          opportunity_id: null,
          title: input.title,
          description: input.title,
          suggested_owner_id: input.ownerUserId,
          suggested_priority: input.priority,
          suggested_planned_at: input.plannedAt,
          source_battle_state_version_id: input.sourceStateId,
          status: "accepted",
          version_no: 2,
          proposed_at: "2026-08-29T00:00:00.000Z",
          expires_at: "2026-09-10T00:00:00.000Z",
          decided_at: confirmedAt,
          decided_by: SYNTHETIC_USER_ID,
          decision_reason: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.business_actions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: input.actionId,
          entity_id: input.entityId,
          opportunity_id: null,
          title: input.title,
          description: input.title,
          owner_user_id: input.ownerUserId,
          priority: input.priority,
          status,
          planned_at: input.plannedAt,
          completed_at: input.completedAt ?? null,
          source_proposal_id: input.proposalId,
          confirmed_by: SYNTHETIC_USER_ID,
          confirmed_at: confirmedAt,
          version_no: versionNo,
          created_at: confirmedAt,
          updated_at: status === "planned" ? confirmedAt : transitionedAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_status_history")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            action_id: input.actionId,
            from_status: null,
            to_status: "planned",
            changed_by: SYNTHETIC_USER_ID,
            reason: "Workspace fixture action created.",
            changed_at: confirmedAt,
            version_no: 1,
          },
          ...(status === "planned"
            ? []
            : [
                {
                  tenant_id: SYNTHETIC_TENANT_ID,
                  action_id: input.actionId,
                  from_status: "planned" as const,
                  to_status: "in_progress" as const,
                  changed_by: SYNTHETIC_USER_ID,
                  reason: "Workspace fixture action transitioned.",
                  changed_at:
                    status === "completed"
                      ? "2026-08-31T19:00:00.000Z"
                      : transitionedAt,
                  version_no: 2,
                },
              ]),
          ...(status === "completed"
            ? [
                {
                  tenant_id: SYNTHETIC_TENANT_ID,
                  action_id: input.actionId,
                  from_status: "in_progress" as const,
                  to_status: "completed" as const,
                  changed_by: SYNTHETIC_USER_ID,
                  reason: "Workspace fixture action completed.",
                  changed_at: transitionedAt,
                  version_no: 3,
                },
              ]
            : []),
        ])
        .execute();
    },
  );
}

async function seedNotifications(
  database: DatabaseHandle<BattlefieldDatabase>,
  actionId: string,
): Promise<void> {
  const notifications = [
    { suffix: "1", recipient: SYNTHETIC_USER_ID, readAt: null },
    { suffix: "2", recipient: SYNTHETIC_USER_ID, readAt: null },
    {
      suffix: "3",
      recipient: SYNTHETIC_USER_ID,
      readAt: "2026-08-31T22:00:00.000Z",
    },
    { suffix: "4", recipient: COLLEAGUE_ID, readAt: null },
  ];
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      for (const notification of notifications) {
        const reminderId = `72000000-0000-4000-8000-00000000000${notification.suffix}`;
        const notificationId = `73000000-0000-4000-8000-00000000000${notification.suffix}`;
        await transaction
          .insertInto("app.reminder_instances")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: reminderId,
            action_id: actionId,
            recipient_user_id: notification.recipient,
            policy_version_id: "71000000-0000-4000-8000-000000000071",
            action_version_no: 1,
            kind: "due",
            remind_at: "2026-08-31T21:00:00.000Z",
            channels: JSON.stringify(["in_app"]),
            status: "scheduled",
            available_at: "2026-08-31T21:00:00.000Z",
            dedupe_key: `workspace-reminder-${notification.suffix}`,
            created_at: "2026-08-31T21:00:00.000Z",
            updated_at: "2026-08-31T21:00:00.000Z",
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.notification_events")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: notificationId,
            recipient_user_id: notification.recipient,
            reminder_id: reminderId,
            event_type: "action_due",
            title: "经营动作已到计划时间",
            body: "请及时推进。",
            deep_link: `/actions?actionId=${actionId}`,
            priority: "high",
            read_at: notification.readAt,
            dedupe_key: `workspace-notification-${notification.suffix}`,
            created_at: "2026-08-31T21:00:00.000Z",
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("app.reminder_instances")
          .set({
            status: "notified",
            notification_event_id: notificationId,
            updated_at: "2026-08-31T21:00:00.000Z",
          })
          .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
          .where("id", "=", reminderId)
          .executeTakeFirstOrThrow();
      }
    },
  );
}

async function seedAdditionalOwnedActions(
  database: DatabaseHandle<BattlefieldDatabase>,
  count: number,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const suffix = String(index).padStart(12, "0");
    await seedAction(database, {
      actionId: `d2000000-0000-4000-8000-${suffix}`,
      proposalId: `c2000000-0000-4000-8000-${suffix}`,
      entityId: SYNTHETIC_ENTITY_ID,
      sourceStateId: OWNED_CURRENT_STATE_ID,
      ownerUserId: SYNTHETIC_USER_ID,
      title: `有界动作 ${index}`,
      priority: index % 2 === 0 ? "high" : "medium",
      plannedAt: `2026-08-31T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
    });
  }
}
