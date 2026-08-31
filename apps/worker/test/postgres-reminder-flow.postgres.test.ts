import { fileURLToPath } from "node:url";
import {
  type BattlefieldDatabase,
  createPostgresDatabase,
  type DatabaseHandle,
  KyselyActionDecisionStore,
  KyselyNotificationStore,
  KyselyReminderStore,
  migrateDatabase,
  withTenantTransaction,
} from "@battlefield/database";
import {
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticReminderConfiguration,
} from "@battlefield/database/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createReminderWorker } from "../src/worker.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const DATABASE_URL = process.env.DATABASE_URL;
const actor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_USER_ID,
};
const proposalId = "c0000000-0000-4000-8000-000000000081";
const actionId = "d0000000-0000-4000-8000-000000000081";
const plannedAt = "2026-09-01T01:00:00.000Z";

describe("PostgreSQL action reminder flow", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is required for PostgreSQL integration tests.",
      );
    }
    database = createPostgresDatabase<BattlefieldDatabase>(DATABASE_URL, {
      applicationName: "battlefield-worker-postgres-integration-test",
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
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticReminderConfiguration(database);
    await seedPendingProposal(database);
  }, 30_000);

  afterAll(async () => {
    if (!database) {
      return;
    }
    await resetApplicationSchemas(database);
    await database.close();
  });

  test("accepts once and materializes one durable inbox notification with Feishu disabled", async () => {
    const clock = new MutableClock("2026-08-31T00:02:00.000Z");
    const actionStore = new KyselyActionDecisionStore(database.db);
    const acceptance = {
      actor,
      proposalId,
      actionId,
      versionNo: "1",
      idempotencyKey: "postgres-reminder-accept-001",
      title: "推进正式方案",
      description: "在计划时间推进",
      ownerUserId: SYNTHETIC_USER_ID,
      priority: "high" as const,
      plannedAt,
      decidedAt: clock.now().toISOString(),
    };
    const firstAcceptance = await actionStore.accept(acceptance);
    await expect(actionStore.accept(acceptance)).resolves.toEqual(
      firstAcceptance,
    );

    const worker = createReminderWorker({
      database: database.db,
      actor,
      batchSize: 50,
      leaseMs: 60_000,
      clock,
      channels: [],
    });
    expect(await worker.tick()).toMatchObject({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    expect(await worker.tick()).toMatchObject({ claimed: 0, failed: 0 });
    expect(await readFlowCounts(database)).toMatchObject({
      action_count: 1,
      reminder_count: 1,
      scheduled_count: 1,
      notification_count: 0,
      in_app_count: 0,
      feishu_count: 0,
    });

    clock.set(plannedAt);
    expect(await worker.tick()).toMatchObject({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    expect(await worker.tick()).toMatchObject({ claimed: 0, failed: 0 });
    const notificationStore = new KyselyNotificationStore(database.db);
    const inbox = await notificationStore.listInbox({
      actor,
      unreadOnly: true,
      limit: 20,
    });
    expect(inbox.items).toEqual([
      expect.objectContaining({
        title: "经营动作已到计划时间",
        deepLink: `/actions?actionId=${actionId}`,
        readAt: null,
      }),
    ]);
    const readAt = "2026-09-01T01:00:10.000Z";
    const readReceipt = await notificationStore.markRead({
      actor,
      notificationId: inbox.items[0]?.notificationId ?? "",
      readAt,
    });
    await expect(
      notificationStore.markRead({
        actor,
        notificationId: inbox.items[0]?.notificationId ?? "",
        readAt: "2026-09-01T01:00:20.000Z",
      }),
    ).resolves.toEqual(readReceipt);

    await actionStore.transition({
      actor,
      actionId,
      versionNo: "1",
      toStatus: "in_progress",
      changedAt: "2026-09-01T01:01:00.000Z",
    });
    clock.set("2026-09-01T01:01:00.000Z");
    await worker.tick();
    await actionStore.transition({
      actor,
      actionId,
      versionNo: "2",
      toStatus: "completed",
      changedAt: "2026-09-01T01:02:00.000Z",
    });
    clock.set("2026-09-01T01:02:00.000Z");
    await worker.tick();
    clock.set("2026-09-08T01:00:00.000Z");
    expect(await worker.tick()).toMatchObject({ claimed: 0, failed: 0 });
    await expect(
      new KyselyReminderStore(database.db, {
        enabledExternalChannels: [],
      }).claimDueBatch({
        actor,
        now: clock.now().toISOString(),
        limit: 50,
        leaseMs: 60_000,
      }),
    ).resolves.toEqual([]);
    expect(await readFlowCounts(database)).toEqual({
      action_count: 1,
      completed_action_count: 1,
      reminder_count: 1,
      scheduled_count: 0,
      notified_count: 1,
      notification_count: 1,
      unread_count: 0,
      in_app_count: 1,
      feishu_count: 0,
      published_outbox_count: 3,
    });
  });
});

class MutableClock {
  private current: Date;

  constructor(value: string) {
    this.current = new Date(value);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(value: string): void {
    this.current = new Date(value);
  }
}

async function seedPendingProposal(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      ...actor,
      requestId: "90000000-0000-4000-8000-000000000081",
    },
    async (transaction) => {
      const analysisRunId = "a0000000-0000-4000-8000-000000000081";
      const stateVersionId = "b0000000-0000-4000-8000-000000000081";
      await transaction
        .insertInto("app.analysis_runs")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: analysisRunId,
          entity_id: SYNTHETIC_ENTITY_ID,
          trigger_event_id: null,
          rule_version: "rules-v1",
          analyzer_config_version: "deterministic-v1",
          input_version: "b".repeat(64),
          status: "completed",
          error_code: null,
          error_message: null,
          started_at: "2026-08-31T00:00:00.000Z",
          finished_at: "2026-08-31T00:00:30.000Z",
          created_by: SYNTHETIC_USER_ID,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.battle_state_versions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: stateVersionId,
          entity_id: SYNTHETIC_ENTITY_ID,
          version_no: 1,
          input_version: "b".repeat(64),
          relationship_score: 60,
          potential_score: 70,
          quadrant_code: "develop",
          primary_opportunity_id: null,
          risk_level: "medium",
          data_sufficiency: "partial",
          data_gaps: JSON.stringify([]),
          summary: "Synthetic reminder acceptance state",
          analysis_run_id: analysisRunId,
          effective_at: "2026-08-31T00:00:30.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_proposals")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: proposalId,
          entity_id: SYNTHETIC_ENTITY_ID,
          opportunity_id: null,
          title: "推进正式方案",
          description: "在计划时间推进",
          suggested_owner_id: SYNTHETIC_USER_ID,
          suggested_priority: "high",
          suggested_planned_at: plannedAt,
          source_battle_state_version_id: stateVersionId,
          status: "pending_confirmation",
          version_no: 1,
          proposed_at: "2026-08-31T00:01:00.000Z",
          expires_at: "2026-09-07T00:01:00.000Z",
          decided_at: null,
          decided_by: null,
          decision_reason: null,
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function readFlowCounts(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<Record<string, number>> {
  return withTenantTransaction(
    database.db,
    {
      ...actor,
      requestId: "90000000-0000-4000-8000-000000000082",
    },
    async (transaction) => {
      const result = await sql<Record<string, number>>`
        select
          (select count(*)::int from app.business_actions) as action_count,
          (select count(*)::int from app.business_actions where status = 'completed') as completed_action_count,
          (select count(*)::int from app.reminder_instances) as reminder_count,
          (select count(*)::int from app.reminder_instances where status = 'scheduled') as scheduled_count,
          (select count(*)::int from app.reminder_instances where status = 'notified') as notified_count,
          (select count(*)::int from app.notification_events) as notification_count,
          (select count(*)::int from app.notification_events where read_at is null) as unread_count,
          (select count(*)::int from app.notification_deliveries where channel = 'in_app') as in_app_count,
          (select count(*)::int from app.notification_deliveries where channel = 'feishu') as feishu_count,
          (select count(*)::int from app.outbox_messages where status = 'published') as published_outbox_count
      `.execute(transaction);
      return result.rows[0] ?? {};
    },
  );
}

async function resetApplicationSchemas(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`drop schema if exists app cascade`.execute(database.db);
  await sql`drop schema if exists app_meta cascade`.execute(database.db);
}
