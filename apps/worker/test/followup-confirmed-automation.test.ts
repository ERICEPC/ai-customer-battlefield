import { fileURLToPath } from "node:url";
import { FollowupNotFoundError } from "@battlefield/core";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  KyselyBattleQueryReader,
  KyselyFollowupConfirmationStore,
  KyselyNotificationStore,
  migrateDatabase,
  withTenantTransaction,
} from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_MANAGER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticManagementObserver,
  seedSyntheticTwoLevelIdentity,
} from "@battlefield/database/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createReminderWorker } from "../src/worker.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const DRAFT_ID = "70000000-0000-4000-8000-000000000091";
const CONFIRMED_AT = "2026-09-01T02:00:00.000Z";
const UNASSIGNED_USER_ID = "30000000-0000-4000-8000-000000000073";
const actor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_USER_ID,
};

describe("confirmed follow-up automation", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    await seedSyntheticTwoLevelIdentity(database);
  });

  afterEach(async () => {
    await database.close();
  });

  test("updates the battle state and notifies the current department leader once", async () => {
    const followups = new KyselyFollowupConfirmationStore(database.db);
    await followups.create({
      actor,
      draftId: DRAFT_ID,
      rawInput: "客户确认项目预算为 380 万元，并要求下周三提交 POC 排期。",
      candidate: {
        entityId: SYNTHETIC_ENTITY_ID,
        summary: "客户确认 380 万元预算，下周三前需要 POC 排期。",
        occurredAt: CONFIRMED_AT,
        followupType: "meeting",
        relatedOpportunityIds: [],
        primaryOpportunityId: null,
        facts: [
          { factType: "budget_status", factValue: "项目预算已确认：380 万元" },
          { factType: "next_step", factValue: "下周三前提交 POC 排期" },
        ],
      },
      createdAt: CONFIRMED_AT,
      expiresAt: "2026-09-01T03:00:00.000Z",
    });
    const confirmed = await followups.confirm({
      actor,
      draftId: DRAFT_ID,
      versionNo: "1",
      idempotencyKey: "confirmed-followup-automation-001",
      confirmedAt: CONFIRMED_AT,
    });
    const worker = createReminderWorker({
      database: database.db,
      actor,
      batchSize: 20,
      leaseMs: 60_000,
      clock: { now: () => new Date("2026-09-01T02:00:05.000Z") },
      channels: [],
    });

    await worker.tick();
    await worker.tick();

    const state = await withTenantTransaction(
      database.db,
      { ...actor, requestId: "90000000-0000-4000-8000-000000000093" },
      (transaction) =>
        transaction
          .selectFrom("app.battle_state_current as current")
          .innerJoin("app.battle_state_versions as version", (join) =>
            join
              .onRef("version.tenant_id", "=", "current.tenant_id")
              .onRef("version.id", "=", "current.battle_state_version_id"),
          )
          .select([
            "current.battle_state_version_id as stateId",
            "current.version_no as versionNo",
            "version.summary",
          ])
          .where("current.entity_id", "=", SYNTHETIC_ENTITY_ID)
          .executeTakeFirst(),
    );
    expect(state).toMatchObject({
      versionNo: 1,
      summary: "已基于 2 条正式事实生成可回放的确定性分析。",
    });
    const analysisRun = await withTenantTransaction(
      database.db,
      { ...actor, requestId: "90000000-0000-4000-8000-000000000095" },
      (transaction) =>
        transaction
          .selectFrom("app.analysis_runs")
          .select(["rule_version", "analyzer_config_version"])
          .where("entity_id", "=", SYNTHETIC_ENTITY_ID)
          .executeTakeFirstOrThrow(),
    );
    expect(analysisRun).toEqual({
      rule_version: "battle-rules-v1-r1",
      analyzer_config_version: "deterministic-v1",
    });
    const visibleState = await new KyselyBattleQueryReader(
      database.db,
    ).getCurrent({ actor, entityId: SYNTHETIC_ENTITY_ID });
    expect(visibleState.state.analysisReceipt).toEqual({
      trigger: "followup_confirmed",
      ruleVersion: "battle-rules-v1-r1",
      analyzerConfigVersion: "deterministic-v1",
    });

    const leaderInbox = await new KyselyNotificationStore(
      database.db,
    ).listInbox({
      actor: {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_MANAGER_USER_ID,
      },
      limit: 20,
    });
    expect(leaderInbox.items).toEqual([
      expect.objectContaining({
        eventType: "sales_progress_updated",
        title: "销售1更新了 Aurora Systems",
        body: "客户确认 380 万元预算，下周三前需要 POC 排期。",
        deepLink: `/followups/${confirmed.followupId}`,
        readAt: null,
      }),
    ]);
    await expect(
      followups.getAutomationStatus({
        actor,
        followupId: confirmed.followupId,
        eventId: confirmed.eventId,
      }),
    ).resolves.toMatchObject({
      overallStatus: "completed",
      battleMapStatus: "completed",
      leaderNotificationStatus: "completed",
      outboxStatus: "published",
      leaderNotificationCount: 1,
      battleStateVersionId: state?.stateId,
    });
    await withTenantTransaction(
      database.db,
      { ...actor, requestId: "90000000-0000-4000-8000-000000000094" },
      (transaction) =>
        transaction
          .insertInto("app.users")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: UNASSIGNED_USER_ID,
            display_name: "同租户无责任关系用户",
          })
          .executeTakeFirstOrThrow(),
    );
    await expect(
      followups.getAutomationStatus({
        actor: {
          tenantId: SYNTHETIC_TENANT_ID,
          userId: UNASSIGNED_USER_ID,
        },
        followupId: confirmed.followupId,
        eventId: confirmed.eventId,
      }),
    ).rejects.toBeInstanceOf(FollowupNotFoundError);
  });
});
