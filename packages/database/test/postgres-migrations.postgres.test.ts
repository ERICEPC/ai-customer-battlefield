import { fileURLToPath } from "node:url";
import type { BusinessEntityReader } from "@battlefield/core";
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
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import {
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "../src/testing/synthetic-directory.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const DATABASE_URL = process.env.DATABASE_URL;

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
    const [stateDetail, mapPage, proposalDetail, proposalPage, actionDetail, actionPage] =
      await Promise.all([
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

    expect(firstRun.map((migration) => migration.name)).toEqual([
      "0001_foundation",
      "0002_customer_operations",
      "0003_followup_confirmation",
      "0004_battle_analysis_actions",
    ]);
    expect(secondRun).toEqual([]);
    expect(rlsState.rows[0]).toEqual({ protected_count: 35, total_count: 35 });
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
    expect(confirmationCounts).toEqual({
      action_count: 1,
      followup_count: 1,
      history_count: 1,
      outbox_count: 2,
      state_count: 1,
    });
  });
});

async function resetApplicationSchemas(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`drop schema if exists app cascade`.execute(database.db);
  await sql`drop schema if exists app_meta cascade`.execute(database.db);
}
