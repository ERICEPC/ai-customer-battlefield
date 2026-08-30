import { fileURLToPath } from "node:url";
import type { BattleAnalysisCandidate } from "@battlefield/core";
import { BattleAnalysisNotFoundError } from "@battlefield/core";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  KyselyBattleAnalysisStore,
  KyselyConfirmedFactSnapshotReader,
} from "../src/battle-analysis/kysely-battle-analysis-store.js";
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
const REQUEST_ID = "90000000-0000-4000-8000-000000000011";
const RUN_ID = "a0000000-0000-4000-8000-000000000001";
const SECOND_RUN_ID = "a0000000-0000-4000-8000-000000000002";
const actor = { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID };
const otherActor = {
  tenantId: SYNTHETIC_OTHER_TENANT_ID,
  userId: SYNTHETIC_OTHER_USER_ID,
};

describe("Kysely battle analysis persistence", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let reader: KyselyConfirmedFactSnapshotReader;
  let store: KyselyBattleAnalysisStore;
  let opportunityId: string;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    opportunityId = await readOpportunityId(database);
    reader = new KyselyConfirmedFactSnapshotReader(database.db);
    store = new KyselyBattleAnalysisStore(database.db, {
      proposalLifetimeMs: 7 * 24 * 60 * 60 * 1_000,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("hashes only confirmed valid facts into a deterministic tenant-scoped snapshot", async () => {
    await createDraft(database, {
      draftId: "70000000-0000-4000-8000-000000000021",
      rawInput: "尚未确认的预算信息",
      facts: [{ factType: "budget_status", factValue: "待确认" }],
    });
    const empty = await reader.read({ actor, entityId: SYNTHETIC_ENTITY_ID });
    expect(empty.facts).toEqual([]);
    expect(empty.inputVersion).toMatch(/^[a-f0-9]{64}$/);

    await createConfirmedFact(database, {
      draftId: "70000000-0000-4000-8000-000000000022",
      idempotencyKey: "confirm-analysis-fact-001",
      rawInput: "客户确认预算",
      facts: [{ factType: "budget_status", factValue: "预算已确认" }],
    });
    const first = await reader.read({ actor, entityId: SYNTHETIC_ENTITY_ID });
    const repeated = await reader.read({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });

    expect(first).toEqual(repeated);
    expect(first.facts).toHaveLength(1);
    expect(first.facts[0]).toMatchObject({
      factType: "budget_status",
      factValue: "预算已确认",
      opportunityId,
    });
    expect(first.inputVersion).not.toBe(empty.inputVersion);
    await expect(
      reader.read({ actor: otherActor, entityId: SYNTHETIC_ENTITY_ID }),
    ).rejects.toBeInstanceOf(BattleAnalysisNotFoundError);
  });

  test("appends an explainable state, evidence, current projection, and pending proposals", async () => {
    await createConfirmedFact(database, {
      draftId: "70000000-0000-4000-8000-000000000023",
      idempotencyKey: "confirm-analysis-fact-002",
      rawInput: "客户确认预算",
      facts: [{ factType: "budget_status", factValue: "预算已确认" }],
    });
    const snapshot = await reader.read({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });
    await startRun(store, RUN_ID, snapshot.inputVersion);

    const completed = await store.complete({
      actor,
      analysisRunId: RUN_ID,
      inputVersion: snapshot.inputVersion,
      candidate: sufficientCandidate(snapshot.facts[0]?.factId ?? "", {
        primaryOpportunityId: opportunityId,
      }),
      finishedAt: "2026-08-31T03:01:00.000Z",
    });

    expect(completed).toMatchObject({
      analysisRunId: RUN_ID,
      entityId: SYNTHETIC_ENTITY_ID,
      status: "completed",
      inputVersion: snapshot.inputVersion,
      battleStateVersionNo: "1",
    });
    expect(completed.proposalIds).toHaveLength(1);
    const persisted = await readAnalysisPersistence(database);
    expect(persisted).toMatchObject({
      analysis_status: "completed",
      state_count: 1,
      signal_count: 1,
      evidence_count: 2,
      proposal_count: 1,
      current_version: "1",
      current_input_version: snapshot.inputVersion,
    });
  });

  test("supports explicit insufficient-data states without invented coordinates", async () => {
    const snapshot = await reader.read({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });
    await startRun(store, RUN_ID, snapshot.inputVersion);

    const completed = await store.complete({
      actor,
      analysisRunId: RUN_ID,
      inputVersion: snapshot.inputVersion,
      candidate: insufficientCandidate(),
      finishedAt: "2026-08-31T03:01:00.000Z",
    });

    expect(completed.status).toBe("completed");
    expect(completed.proposalIds).toEqual([]);
    const state = await withTenantTransaction(
      database.db,
      { ...actor, requestId: REQUEST_ID },
      (transaction) =>
        transaction
          .selectFrom("app.battle_state_versions")
          .select([
            "relationship_score",
            "potential_score",
            "quadrant_code",
            "data_sufficiency",
            "data_gaps",
          ])
          .where("tenant_id", "=", actor.tenantId)
          .where("analysis_run_id", "=", RUN_ID)
          .executeTakeFirstOrThrow(),
    );
    expect(state).toMatchObject({
      relationship_score: null,
      potential_score: null,
      quadrant_code: null,
      data_sufficiency: "insufficient",
    });
    expect(decodeStringArray(state.data_gaps)).toEqual([
      "缺少有效客户关系事实",
    ]);
  });

  test("supersedes a late run after confirmed facts change without replacing the map", async () => {
    await createConfirmedFact(database, {
      draftId: "70000000-0000-4000-8000-000000000024",
      idempotencyKey: "confirm-analysis-fact-003",
      rawInput: "第一次确认",
      facts: [{ factType: "budget_status", factValue: "预算已确认" }],
    });
    const firstSnapshot = await reader.read({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });
    await startRun(store, RUN_ID, firstSnapshot.inputVersion);

    await createConfirmedFact(database, {
      draftId: "70000000-0000-4000-8000-000000000025",
      idempotencyKey: "confirm-analysis-fact-004",
      rawInput: "第二次确认",
      facts: [{ factType: "decision_timing", factValue: "九月决策" }],
      occurredAt: "2026-08-31T02:40:00.000Z",
      confirmedAt: "2026-08-31T02:45:00.000Z",
    });
    const latestSnapshot = await reader.read({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });
    await startRun(store, SECOND_RUN_ID, latestSnapshot.inputVersion);
    const newest = await store.complete({
      actor,
      analysisRunId: SECOND_RUN_ID,
      inputVersion: latestSnapshot.inputVersion,
      candidate: sufficientCandidate(
        latestSnapshot.facts[latestSnapshot.facts.length - 1]?.factId ?? "",
        { primaryOpportunityId: opportunityId },
      ),
      finishedAt: "2026-08-31T03:02:00.000Z",
    });
    const late = await store.complete({
      actor,
      analysisRunId: RUN_ID,
      inputVersion: firstSnapshot.inputVersion,
      candidate: sufficientCandidate(firstSnapshot.facts[0]?.factId ?? "", {
        primaryOpportunityId: opportunityId,
      }),
      finishedAt: "2026-08-31T03:03:00.000Z",
    });

    expect(newest.status).toBe("completed");
    expect(late).toMatchObject({
      status: "superseded",
      battleStateVersionId: null,
      proposalIds: [],
    });
    const persisted = await readAnalysisPersistence(database);
    expect(persisted).toMatchObject({
      state_count: 1,
      proposal_count: 1,
      current_input_version: latestSnapshot.inputVersion,
    });
  });

  test("increments immutable versions and replaces only the rebuildable projection", async () => {
    await createConfirmedFact(database, {
      draftId: "70000000-0000-4000-8000-000000000026",
      idempotencyKey: "confirm-analysis-fact-005",
      rawInput: "客户确认预算",
      facts: [{ factType: "budget_status", factValue: "预算已确认" }],
    });
    const snapshot = await reader.read({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });
    await startRun(store, RUN_ID, snapshot.inputVersion);
    const first = await store.complete({
      actor,
      analysisRunId: RUN_ID,
      inputVersion: snapshot.inputVersion,
      candidate: sufficientCandidate(snapshot.facts[0]?.factId ?? "", {
        primaryOpportunityId: opportunityId,
      }),
      finishedAt: "2026-08-31T03:01:00.000Z",
    });
    await startRun(store, SECOND_RUN_ID, snapshot.inputVersion, {
      startedAt: "2026-08-31T03:02:00.000Z",
    });
    const second = await store.complete({
      actor,
      analysisRunId: SECOND_RUN_ID,
      inputVersion: snapshot.inputVersion,
      candidate: sufficientCandidate(snapshot.facts[0]?.factId ?? "", {
        primaryOpportunityId: opportunityId,
        relationshipScore: "80.00",
      }),
      finishedAt: "2026-08-31T03:03:00.000Z",
    });

    expect(first.battleStateVersionNo).toBe("1");
    expect(second.battleStateVersionNo).toBe("2");
    const persisted = await readAnalysisPersistence(database);
    expect(persisted).toMatchObject({ state_count: 2, current_version: "2" });
  });

  test("records a safe failed terminal run without creating state", async () => {
    const snapshot = await reader.read({
      actor,
      entityId: SYNTHETIC_ENTITY_ID,
    });
    await startRun(store, RUN_ID, snapshot.inputVersion);
    await store.fail({
      actor,
      analysisRunId: RUN_ID,
      errorCode: "ANALYZER_FAILED",
      finishedAt: "2026-08-31T03:01:00.000Z",
    });

    const persisted = await readAnalysisPersistence(database);
    expect(persisted).toMatchObject({
      analysis_status: "failed",
      analysis_error_code: "ANALYZER_FAILED",
      state_count: 0,
      proposal_count: 0,
    });
    await expect(
      store.fail({
        actor,
        analysisRunId: SECOND_RUN_ID,
        errorCode: "ANALYZER_FAILED",
        finishedAt: "2026-08-31T03:01:00.000Z",
      }),
    ).rejects.toBeInstanceOf(BattleAnalysisNotFoundError);
  });
});

function sufficientCandidate(
  factId: string,
  overrides: Partial<BattleAnalysisCandidate> = {},
): BattleAnalysisCandidate {
  return {
    relationshipScore: "72.50",
    potentialScore: "81.00",
    quadrantCode: "high_relationship_high_potential",
    primaryOpportunityId: null,
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
    ...overrides,
  };
}

function insufficientCandidate(): BattleAnalysisCandidate {
  return {
    relationshipScore: null,
    potentialScore: null,
    quadrantCode: null,
    primaryOpportunityId: null,
    riskLevel: "medium",
    dataSufficiency: "insufficient",
    dataGaps: ["缺少有效客户关系事实"],
    summary: "当前正式事实不足，暂不生成精确坐标。",
    signals: [],
    evidenceFactIds: [],
    actionProposals: [],
  };
}

async function startRun(
  store: KyselyBattleAnalysisStore,
  analysisRunId: string,
  inputVersion: string,
  overrides: { startedAt?: string } = {},
): Promise<void> {
  await store.start({
    actor,
    analysisRunId,
    entityId: SYNTHETIC_ENTITY_ID,
    inputVersion,
    ruleVersion: "battle-rules-v1",
    analyzerConfigVersion: "deterministic-v1",
    startedAt: overrides.startedAt ?? "2026-08-31T03:00:00.000Z",
  });
}

async function createConfirmedFact(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    draftId: string;
    idempotencyKey: string;
    rawInput: string;
    facts: Array<{ factType: string; factValue: string }>;
    occurredAt?: string;
    confirmedAt?: string;
  },
): Promise<void> {
  await createDraft(database, input);
  const followup = new KyselyFollowupConfirmationStore(database.db);
  await followup.confirm({
    actor,
    draftId: input.draftId,
    versionNo: "1",
    idempotencyKey: input.idempotencyKey,
    confirmedAt: input.confirmedAt ?? "2026-08-31T02:35:00.000Z",
  });
}

async function createDraft(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    draftId: string;
    rawInput: string;
    facts: Array<{ factType: string; factValue: string }>;
    occurredAt?: string;
  },
): Promise<void> {
  const followup = new KyselyFollowupConfirmationStore(database.db);
  await followup.create({
    actor,
    draftId: input.draftId,
    rawInput: input.rawInput,
    candidate: {
      entityId: SYNTHETIC_ENTITY_ID,
      summary: input.rawInput,
      occurredAt: input.occurredAt ?? "2026-08-31T02:30:00.000Z",
      followupType: "meeting",
      relatedOpportunityIds: [await readOpportunityId(database)],
      primaryOpportunityId: await readOpportunityId(database),
      facts: input.facts,
    },
    createdAt: input.occurredAt ?? "2026-08-31T02:30:00.000Z",
    expiresAt: "2026-09-07T02:30:00.000Z",
  });
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

async function readAnalysisPersistence(
  database: DatabaseHandle<BattlefieldDatabase>,
) {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const result = await sql<{
        analysis_status: string | null;
        analysis_error_code: string | null;
        state_count: number;
        signal_count: number;
        evidence_count: number;
        proposal_count: number;
        current_version: string | null;
        current_input_version: string | null;
      }>`
        select
          (select status from app.analysis_runs where tenant_id = ${actor.tenantId}::uuid order by started_at desc, id desc limit 1) as analysis_status,
          (select error_code from app.analysis_runs where tenant_id = ${actor.tenantId}::uuid order by started_at desc, id desc limit 1) as analysis_error_code,
          (select count(*)::int from app.battle_state_versions where tenant_id = ${actor.tenantId}::uuid) as state_count,
          (select count(*)::int from app.business_signals where tenant_id = ${actor.tenantId}::uuid) as signal_count,
          (select count(*)::int from app.battle_state_evidence_links where tenant_id = ${actor.tenantId}::uuid) as evidence_count,
          (select count(*)::int from app.action_proposals where tenant_id = ${actor.tenantId}::uuid) as proposal_count,
          (select version_no::text from app.battle_state_current where tenant_id = ${actor.tenantId}::uuid and entity_id = ${SYNTHETIC_ENTITY_ID}::uuid) as current_version,
          (select input_version from app.battle_state_current where tenant_id = ${actor.tenantId}::uuid and entity_id = ${SYNTHETIC_ENTITY_ID}::uuid) as current_input_version
      `.execute(transaction);
      return result.rows[0];
    },
  );
}

function decodeStringArray(value: unknown): string[] {
  return (typeof value === "string" ? JSON.parse(value) : value) as string[];
}
