import { fileURLToPath } from "node:url";
import type { BattleAnalysisCandidate } from "@battlefield/core";
import {
  ActionIdempotencyConflictError,
  ActionOwnerNotFoundError,
  ActionProposalExpiredError,
  ActionProposalNotFoundError,
  type ActionProposalNotPendingError,
  type ActionProposalVersionConflictError,
  BusinessActionNotFoundError,
  type BusinessActionVersionConflictError,
  InvalidBusinessActionTransitionError,
} from "@battlefield/core";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { KyselyActionDecisionStore } from "../src/action-decisions/kysely-action-decision-store.js";
import { KyselyActionQueryReader } from "../src/action-decisions/kysely-action-query-reader.js";
import {
  KyselyBattleAnalysisStore,
  KyselyConfirmedFactSnapshotReader,
} from "../src/battle-analysis/kysely-battle-analysis-store.js";
import { KyselyBattleQueryReader } from "../src/battle-analysis/kysely-battle-query-reader.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { KyselyFollowupConfirmationStore } from "../src/followup-confirmation/kysely-followup-confirmation-store.js";
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

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const REQUEST_ID = "90000000-0000-4000-8000-000000000031";
const RUN_ID = "a0000000-0000-4000-8000-000000000031";
const ACTION_ID = "d0000000-0000-4000-8000-000000000031";
const UNASSIGNED_USER_ID = "30000000-0000-4000-8000-000000000032";
const OBSERVER_USER_ID = "30000000-0000-4000-8000-000000000033";
const actor = { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID };
const unassignedActor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: UNASSIGNED_USER_ID,
};
const observerActor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: OBSERVER_USER_ID,
};
const otherActor = {
  tenantId: SYNTHETIC_OTHER_TENANT_ID,
  userId: SYNTHETIC_OTHER_USER_ID,
};

describe("Kysely action decision persistence", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let store: KyselyActionDecisionStore;
  let proposalId: string;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    proposalId = await seedPendingProposal(database);
    store = new KyselyActionDecisionStore(database.db);
  });

  afterEach(async () => {
    await database.close();
  });

  test("accepts idempotently into one action, initial history, audit, event, and Outbox", async () => {
    const input = acceptanceInput(proposalId);
    const accepted = await store.accept(input);
    const repeated = await store.accept({
      ...input,
      actionId: "d0000000-0000-4000-8000-000000000099",
      decidedAt: "2026-08-31T03:06:00.000Z",
    });

    expect(accepted).toEqual({
      proposalId,
      status: "accepted",
      actionId: ACTION_ID,
      versionNo: "2",
      decidedAt: "2026-08-31T03:05:00.000Z",
    });
    expect(repeated).toEqual(accepted);
    expect(await readDecisionPersistence(database, proposalId)).toMatchObject({
      proposal_status: "accepted",
      proposal_version: "2",
      action_count: 1,
      history_count: 1,
      audit_count: 1,
      event_count: 1,
      outbox_count: 1,
      idempotency_count: 1,
    });
  });

  test("rejects reuse of an acceptance key with changed business input", async () => {
    const input = acceptanceInput(proposalId);
    await store.accept(input);

    await expect(
      store.accept({
        ...input,
        actionId: "d0000000-0000-4000-8000-000000000099",
        title: "篡改后的动作",
      }),
    ).rejects.toBeInstanceOf(ActionIdempotencyConflictError);
  });

  test("allows observers to read proposals but denies observer and unassigned decisions", async () => {
    await seedUnauthorizedDecisionActors(database);
    const reader = new KyselyActionQueryReader(database.db);
    await expect(
      reader.getProposal({ actor: observerActor, proposalId }),
    ).resolves.toMatchObject({ proposalId, canDecide: false });
    await expect(
      reader.listOwners({
        actor: observerActor,
        entityId: SYNTHETIC_ENTITY_ID,
        limit: 20,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });

    for (const deniedActor of [observerActor, unassignedActor]) {
      await expect(
        store.accept({
          ...acceptanceInput(proposalId),
          actor: deniedActor,
          actionId:
            deniedActor.userId === OBSERVER_USER_ID
              ? "d0000000-0000-4000-8000-000000000032"
              : "d0000000-0000-4000-8000-000000000033",
          idempotencyKey: `denied-accept-${deniedActor.userId}`,
        }),
      ).rejects.toBeInstanceOf(ActionProposalNotFoundError);
      await expect(
        store.reject({
          actor: deniedActor,
          proposalId,
          versionNo: "1",
          idempotencyKey: `denied-reject-${deniedActor.userId}`,
          reason: "无权决策",
          decidedAt: "2026-08-31T03:05:00.000Z",
        }),
      ).rejects.toBeInstanceOf(ActionProposalNotFoundError);
    }
  });

  test("denies proposal decisions after the actor assignment ends", async () => {
    await endActorAssignment(database);

    await expect(
      store.accept({
        ...acceptanceInput(proposalId),
        idempotencyKey: "ended-assignment-accept",
      }),
    ).rejects.toBeInstanceOf(ActionProposalNotFoundError);
    await expect(
      store.reject({
        actor,
        proposalId,
        versionNo: "1",
        idempotencyKey: "ended-assignment-reject",
        reason: "责任已结束",
        decidedAt: "2026-08-31T03:05:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ActionProposalNotFoundError);
  });

  test("allows only the current action owner to transition a formal action", async () => {
    await seedUnauthorizedDecisionActors(database);
    await store.accept(acceptanceInput(proposalId));

    for (const deniedActor of [observerActor, unassignedActor]) {
      await expect(
        store.transition({
          actor: deniedActor,
          actionId: ACTION_ID,
          versionNo: "1",
          toStatus: "in_progress",
          changedAt: "2026-09-01T09:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(BusinessActionNotFoundError);
    }
    await endActorAssignment(database);
    await expect(
      store.transition({
        actor,
        actionId: ACTION_ID,
        versionNo: "1",
        toStatus: "in_progress",
        changedAt: "2026-09-01T09:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BusinessActionNotFoundError);
  });

  test("projects elapsed pending proposals as expired and removes them from the pending queue", async () => {
    const expiredProposalId = "c0000000-0000-4000-8000-000000000098";
    await withTenantTransaction(
      database.db,
      { ...actor, requestId: REQUEST_ID },
      async (transaction) => {
        const source = await transaction
          .selectFrom("app.action_proposals")
          .select([
            "entity_id",
            "opportunity_id",
            "title",
            "description",
            "suggested_owner_id",
            "suggested_priority",
            "source_battle_state_version_id",
          ])
          .where("tenant_id", "=", actor.tenantId)
          .where("id", "=", proposalId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.action_proposals")
          .values({
            tenant_id: actor.tenantId,
            id: expiredProposalId,
            ...source,
            suggested_planned_at: null,
            status: "pending_confirmation",
            version_no: 1,
            proposed_at: "2019-12-31T00:00:00.000Z",
            expires_at: "2020-01-01T00:00:00.000Z",
            decided_at: null,
            decided_by: null,
            decision_reason: null,
            created_at: "2019-12-31T00:00:00.000Z",
            updated_at: "2019-12-31T00:00:00.000Z",
          })
          .executeTakeFirstOrThrow();
      },
    );
    const reader = new KyselyActionQueryReader(database.db);

    await expect(
      reader.getProposal({ actor, proposalId: expiredProposalId }),
    ).resolves.toMatchObject({
      proposalId: expiredProposalId,
      status: "expired",
    });
    const pending = await reader.listProposals({
      actor,
      status: "pending_confirmation",
      limit: 20,
    });
    expect(pending.items).not.toContainEqual(
      expect.objectContaining({ proposalId: expiredProposalId }),
    );
    await expect(
      reader.listProposals({ actor, status: "expired", limit: 20 }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          proposalId: expiredProposalId,
          status: "expired",
        }),
      ],
    });
  });

  test("reads an immutable state version and locates one map entity independently", async () => {
    const battleReader = new KyselyBattleQueryReader(database.db);
    const current = await battleReader.getCurrent({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });
    expect(current.state.analysisReceipt).toEqual({
      trigger: "manual",
      ruleVersion: "battle-rules-v1",
      analyzerConfigVersion: "deterministic-v1",
    });

    await expect(
      battleReader.getVersion({
        actor,
        entityId: SYNTHETIC_ENTITY_ID,
        battleStateVersionId: current.state.battleStateVersionId,
      }),
    ).resolves.toEqual(current);
    await expect(
      battleReader.listMap({
        actor,
        entityId: SYNTHETIC_ENTITY_ID,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      items: [{ entityId: SYNTHETIC_ENTITY_ID }],
      nextCursor: null,
    });
  });

  test("pages the complete active-owner directory without duplicates", async () => {
    await withTenantTransaction(
      database.db,
      { ...actor, requestId: REQUEST_ID },
      async (transaction) => {
        const users = Array.from({ length: 105 }, (_, index) => ({
          tenant_id: actor.tenantId,
          id: `30000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
          display_name: `分页销售 ${String(index + 1).padStart(3, "0")}`,
          email: null,
          mobile: null,
          status: index === 104 ? ("inactive" as const) : ("active" as const),
        }));
        await transaction.insertInto("app.users").values(users).execute();
        await transaction
          .insertInto("app.entity_assignments")
          .values(
            users.slice(0, 104).map((user, index) => ({
              tenant_id: actor.tenantId,
              id: `61000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
              entity_id: SYNTHETIC_ENTITY_ID,
              user_id: user.id,
              assignment_role: "collaborator" as const,
              is_primary: false,
              valid_from: "2026-08-01T00:00:00.000Z",
              valid_to: null,
            })),
          )
          .execute();
      },
    );
    const reader = new KyselyActionQueryReader(database.db);
    const loaded: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader.listOwners({
        actor,
        entityId: SYNTHETIC_ENTITY_ID,
        limit: 40,
        ...(cursor ? { cursor } : {}),
      });
      loaded.push(...page.items.map((owner) => owner.userId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(loaded[0]).toBe(SYNTHETIC_USER_ID);
    expect(loaded).toHaveLength(105);
    expect(new Set(loaded)).toHaveLength(105);
    expect(loaded).not.toContain("30000000-0000-4000-8001-000000000105");
  });

  test("rejects a proposal idempotently without creating a formal action", async () => {
    const input = {
      actor,
      proposalId,
      versionNo: "1",
      idempotencyKey: "reject-proposal-001",
      reason: "当前时机不合适",
      decidedAt: "2026-08-31T03:05:00.000Z",
    };
    const rejected = await store.reject(input);

    expect(await store.reject(input)).toEqual(rejected);
    expect(rejected).toEqual({
      proposalId,
      status: "rejected",
      actionId: null,
      versionNo: "2",
      decidedAt: input.decidedAt,
    });
    expect(await readDecisionPersistence(database, proposalId)).toMatchObject({
      proposal_status: "rejected",
      action_count: 0,
      audit_count: 1,
      event_count: 1,
      outbox_count: 1,
    });
  });

  test("enforces expiry, optimistic versioning, terminal state, and tenant visibility", async () => {
    await expect(
      store.accept({
        ...acceptanceInput(proposalId),
        decidedAt: "2026-09-08T03:05:00.000Z",
        plannedAt: "2026-09-09T03:05:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ActionProposalExpiredError);
    await expect(
      store.reject({
        actor,
        proposalId,
        versionNo: "2",
        idempotencyKey: "reject-stale-proposal",
        reason: "版本过期",
        decidedAt: "2026-08-31T03:05:00.000Z",
      }),
    ).rejects.toMatchObject<Partial<ActionProposalVersionConflictError>>({
      latestVersionNo: "1",
    });
    await store.reject({
      actor,
      proposalId,
      versionNo: "1",
      idempotencyKey: "reject-terminal-proposal",
      reason: "暂不执行",
      decidedAt: "2026-08-31T03:05:00.000Z",
    });
    await expect(
      store.accept({
        ...acceptanceInput(proposalId),
        idempotencyKey: "accept-terminal-proposal",
        versionNo: "2",
      }),
    ).rejects.toMatchObject<Partial<ActionProposalNotPendingError>>({
      status: "rejected",
    });
    await expect(
      store.reject({
        actor: otherActor,
        proposalId,
        versionNo: "1",
        idempotencyKey: "other-tenant-proposal",
        reason: "不可见",
        decidedAt: "2026-08-31T03:05:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ActionProposalNotFoundError);
  });

  test("rejects an owner outside the tenant and a non-future planned time", async () => {
    await expect(
      store.accept({
        ...acceptanceInput(proposalId),
        ownerUserId: SYNTHETIC_OTHER_USER_ID,
      }),
    ).rejects.toBeInstanceOf(ActionOwnerNotFoundError);
    await expect(
      store.accept({
        ...acceptanceInput(proposalId),
        plannedAt: "2026-08-31T03:04:00.000Z",
      }),
    ).rejects.toThrow();
  });

  test("rolls back proposal, action, history, audit, and idempotency when Outbox fails", async () => {
    await reserveAcceptanceOutboxKey(database, proposalId);

    await expect(
      store.accept({
        ...acceptanceInput(proposalId),
        idempotencyKey: "accept-with-outbox-conflict",
      }),
    ).rejects.toThrow();
    expect(await readDecisionPersistence(database, proposalId)).toMatchObject({
      proposal_status: "pending_confirmation",
      proposal_version: "1",
      action_count: 0,
      history_count: 0,
      audit_count: 0,
      event_count: 0,
      idempotency_count: 0,
    });
  });

  test("transitions forward with contiguous history and rejects stale or invalid moves", async () => {
    await seedUnauthorizedDecisionActors(database);
    await store.accept(acceptanceInput(proposalId));
    await expect(
      store.transition({
        actor,
        actionId: ACTION_ID,
        versionNo: "1",
        toStatus: "completed",
        changedAt: "2026-09-01T09:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(InvalidBusinessActionTransitionError);

    const started = await store.transition({
      actor,
      actionId: ACTION_ID,
      versionNo: "1",
      toStatus: "in_progress",
      reason: "开始执行",
      changedAt: "2026-09-01T09:00:00.000Z",
    });
    expect(started).toMatchObject({
      actionId: ACTION_ID,
      status: "in_progress",
      versionNo: "2",
    });
    await expect(
      store.transition({
        actor,
        actionId: ACTION_ID,
        versionNo: "1",
        toStatus: "cancelled",
        changedAt: "2026-09-01T09:01:00.000Z",
      }),
    ).rejects.toMatchObject<Partial<BusinessActionVersionConflictError>>({
      latestVersionNo: "2",
    });
    const completed = await store.transition({
      actor,
      actionId: ACTION_ID,
      versionNo: "2",
      toStatus: "completed",
      changedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(completed).toMatchObject({ status: "completed", versionNo: "3" });

    const action = await readAction(database);
    expect(action).toMatchObject({
      status: "completed",
      version_no: "3",
      completed_at: new Date("2026-09-01T10:00:00.000Z"),
      history_count: 3,
    });
    const reader = new KyselyActionQueryReader(database.db);
    await expect(
      reader.getAction({ actor: observerActor, actionId: ACTION_ID }),
    ).resolves.toMatchObject({
      actionId: ACTION_ID,
      status: "completed",
      canTransition: false,
    });
    await expect(
      reader.listActions({ actor: observerActor, limit: 20 }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      store.transition({
        actor: otherActor,
        actionId: ACTION_ID,
        versionNo: "3",
        toStatus: "cancelled",
        changedAt: "2026-09-01T10:01:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BusinessActionNotFoundError);
  });

  test("keeps cancelled actions private from management observers", async () => {
    await seedUnauthorizedDecisionActors(database);
    await store.accept(acceptanceInput(proposalId));
    await store.transition({
      actor,
      actionId: ACTION_ID,
      versionNo: "1",
      toStatus: "cancelled",
      reason: "不再推进",
      changedAt: "2026-09-01T09:00:00.000Z",
    });

    const reader = new KyselyActionQueryReader(database.db);
    await expect(
      reader.getAction({ actor, actionId: ACTION_ID }),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      reader.getAction({ actor: observerActor, actionId: ACTION_ID }),
    ).rejects.toBeInstanceOf(BusinessActionNotFoundError);
  });
});

async function seedUnauthorizedDecisionActors(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .insertInto("app.users")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: UNASSIGNED_USER_ID,
            display_name: "无责任用户",
            email: null,
            mobile: null,
            status: "active",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: OBSERVER_USER_ID,
            display_name: "只读观察者",
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
          id: "61000000-0000-4000-8000-000000000031",
          entity_id: SYNTHETIC_ENTITY_ID,
          user_id: OBSERVER_USER_ID,
          assignment_role: "management_observer",
          is_primary: false,
          valid_from: "2026-08-01T00:00:00.000Z",
          valid_to: null,
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function endActorAssignment(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .updateTable("app.entity_assignments")
        .set({
          valid_from: "2020-01-01T00:00:00.000Z",
          valid_to: "2021-01-01T00:00:00.000Z",
        })
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("entity_id", "=", SYNTHETIC_ENTITY_ID)
        .where("user_id", "=", SYNTHETIC_USER_ID)
        .executeTakeFirstOrThrow();
    },
  );
}

function acceptanceInput(proposalId: string) {
  return {
    actor,
    proposalId,
    actionId: ACTION_ID,
    versionNo: "1",
    idempotencyKey: "accept-proposal-001",
    title: "提交正式解决方案",
    description: "包含安全方案与实施排期。",
    ownerUserId: SYNTHETIC_USER_ID,
    priority: "urgent" as const,
    plannedAt: "2026-09-03T09:00:00.000Z",
    decidedAt: "2026-08-31T03:05:00.000Z",
  };
}

async function seedPendingProposal(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<string> {
  const opportunityId = await readOpportunityId(database);
  const followup = new KyselyFollowupConfirmationStore(database.db);
  const draftId = "70000000-0000-4000-8000-000000000031";
  await followup.create({
    actor,
    draftId,
    rawInput: "客户确认预算",
    candidate: {
      entityId: SYNTHETIC_ENTITY_ID,
      summary: "客户确认预算",
      occurredAt: "2026-08-31T02:30:00.000Z",
      followupType: "meeting",
      relatedOpportunityIds: [opportunityId],
      primaryOpportunityId: opportunityId,
      facts: [{ factType: "budget_status", factValue: "预算已确认" }],
    },
    createdAt: "2026-08-31T02:30:00.000Z",
    expiresAt: "2026-09-07T02:30:00.000Z",
  });
  await followup.confirm({
    actor,
    draftId,
    versionNo: "1",
    idempotencyKey: "confirm-action-seed-001",
    confirmedAt: "2026-08-31T02:35:00.000Z",
  });
  const reader = new KyselyConfirmedFactSnapshotReader(database.db);
  const snapshot = await reader.read({ actor, entityId: SYNTHETIC_ENTITY_ID });
  const analysis = new KyselyBattleAnalysisStore(database.db, {
    proposalLifetimeMs: 7 * 24 * 60 * 60 * 1_000,
  });
  await analysis.start({
    actor,
    analysisRunId: RUN_ID,
    entityId: SYNTHETIC_ENTITY_ID,
    inputVersion: snapshot.inputVersion,
    ruleVersion: "battle-rules-v1",
    analyzerConfigVersion: "deterministic-v1",
    startedAt: "2026-08-31T03:00:00.000Z",
  });
  const result = await analysis.complete({
    actor,
    analysisRunId: RUN_ID,
    inputVersion: snapshot.inputVersion,
    candidate: analysisCandidate(
      snapshot.facts[0]?.factId ?? "",
      opportunityId,
    ),
    finishedAt: "2026-08-31T03:01:00.000Z",
  });
  if (result.status !== "completed" || !result.proposalIds[0]) {
    throw new Error("Synthetic action proposal was not created.");
  }
  return result.proposalIds[0];
}

function analysisCandidate(
  factId: string,
  opportunityId: string,
): BattleAnalysisCandidate {
  return {
    relationshipScore: "72.50",
    potentialScore: "81.00",
    quadrantCode: "high_relationship_high_potential",
    primaryOpportunityId: opportunityId,
    riskLevel: "medium",
    dataSufficiency: "sufficient",
    dataGaps: [],
    summary: "关系稳定，预算已确认。",
    signals: [
      {
        factId,
        dimension: "potential",
        direction: "positive",
        strength: 80,
        reason: "客户已确认预算。",
      },
    ],
    evidenceFactIds: [factId],
    actionProposals: [
      {
        title: "提交解决方案",
        description: "按客户要求补充实施排期。",
        suggestedOwnerId: SYNTHETIC_USER_ID,
        suggestedPriority: "high",
        suggestedPlannedAt: "2026-09-03T09:00:00.000Z",
      },
    ],
  };
}

async function readOpportunityId(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<string> {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const row = await transaction
        .selectFrom("app.opportunities")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("entity_id", "=", SYNTHETIC_ENTITY_ID)
        .executeTakeFirstOrThrow();
      return row.id;
    },
  );
}

async function readDecisionPersistence(
  database: DatabaseHandle<BattlefieldDatabase>,
  proposalId: string,
) {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const result = await sql<{
        proposal_status: string;
        proposal_version: string;
        action_count: number;
        history_count: number;
        audit_count: number;
        event_count: number;
        outbox_count: number;
        idempotency_count: number;
      }>`
        select
          (select status from app.action_proposals where tenant_id = ${actor.tenantId}::uuid and id = ${proposalId}::uuid) as proposal_status,
          (select version_no::text from app.action_proposals where tenant_id = ${actor.tenantId}::uuid and id = ${proposalId}::uuid) as proposal_version,
          (select count(*)::int from app.business_actions where tenant_id = ${actor.tenantId}::uuid and source_proposal_id = ${proposalId}::uuid) as action_count,
          (select count(*)::int from app.action_status_history as history inner join app.business_actions as action on action.tenant_id = history.tenant_id and action.id = history.action_id where action.tenant_id = ${actor.tenantId}::uuid and action.source_proposal_id = ${proposalId}::uuid) as history_count,
          (select count(*)::int from app.audit_entries where tenant_id = ${actor.tenantId}::uuid and aggregate_type in ('action_proposal', 'business_action') and aggregate_id in (${proposalId}::uuid, ${ACTION_ID}::uuid)) as audit_count,
          (select count(*)::int from app.domain_events where tenant_id = ${actor.tenantId}::uuid and event_type in ('action_proposal.accepted.v1', 'action_proposal.rejected.v1')) as event_count,
          (select count(*)::int from app.outbox_messages where tenant_id = ${actor.tenantId}::uuid and topic in ('action_proposal.accepted.v1', 'action_proposal.rejected.v1')) as outbox_count,
          (select count(*)::int from app.idempotency_records where tenant_id = ${actor.tenantId}::uuid and operation in ('action_proposal.accept', 'action_proposal.reject')) as idempotency_count
      `.execute(transaction);
      return result.rows[0];
    },
  );
}

async function readAction(database: DatabaseHandle<BattlefieldDatabase>) {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const row = await transaction
        .selectFrom("app.business_actions")
        .select(["status", "version_no", "completed_at"])
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", ACTION_ID)
        .executeTakeFirstOrThrow();
      const history = await transaction
        .selectFrom("app.action_status_history")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("tenant_id", "=", actor.tenantId)
        .where("action_id", "=", ACTION_ID)
        .executeTakeFirstOrThrow();
      return {
        ...row,
        version_no: String(row.version_no),
        history_count: history.count,
      };
    },
  );
}

async function reserveAcceptanceOutboxKey(
  database: DatabaseHandle<BattlefieldDatabase>,
  proposalId: string,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const eventId = "e0000000-0000-4000-8000-000000000031";
      await transaction
        .insertInto("app.domain_events")
        .values({
          tenant_id: actor.tenantId,
          id: eventId,
          aggregate_type: "test",
          aggregate_id: proposalId,
          event_type: "test.reserved.v1",
          event_version: 1,
          payload: sql<Record<string, unknown>>`'{}'::jsonb`,
          occurred_at: "2026-08-31T03:04:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.outbox_messages")
        .values({
          tenant_id: actor.tenantId,
          id: "e1000000-0000-4000-8000-000000000031",
          event_id: eventId,
          topic: "test.reserved.v1",
          payload: sql<Record<string, unknown>>`'{}'::jsonb`,
          dedupe_key: `action_proposal.accepted:${proposalId}`,
          available_at: "2026-08-31T03:04:00.000Z",
        })
        .executeTakeFirstOrThrow();
    },
  );
}
