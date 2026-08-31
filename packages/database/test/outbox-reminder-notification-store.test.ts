import { fileURLToPath } from "node:url";
import {
  CancelActionReminders,
  DispatchDueReminders,
  type NotificationChannel,
  NotificationDelivery,
  ScheduleActionReminders,
} from "@battlefield/core";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { KyselyOutboxStore } from "../src/async-work/kysely-outbox-store.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { KyselyNotificationStore } from "../src/notifications/kysely-notification-store.js";
import { KyselyReminderStore } from "../src/reminders/kysely-reminder-store.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";
import {
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "../src/testing/synthetic-directory.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const actor = { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID };
const requestId = "90000000-0000-4000-8000-000000000051";
const actionId = "d0000000-0000-4000-8000-000000000051";
const policyId = "71000000-0000-4000-8000-000000000051";
const plannedAt = "2026-09-01T01:00:00.000Z";

describe("Kysely Outbox, reminder, and notification stores", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedAcceptedActionAndNotificationConfig(database);
  });

  afterEach(async () => {
    await database.close();
  });

  test("claims one Outbox row once and requires its claim token to publish", async () => {
    await seedOutboxMessage(database);
    const store = new KyselyOutboxStore(database.db);
    const [first, second] = await Promise.all([
      store.claimBatch({
        actor,
        now: "2026-09-01T00:00:00.000Z",
        limit: 10,
        leaseMs: 60_000,
      }),
      store.claimBatch({
        actor,
        now: "2026-09-01T00:00:00.000Z",
        limit: 10,
        leaseMs: 60_000,
      }),
    ]);

    expect([...first, ...second]).toHaveLength(1);
    const claim = [...first, ...second][0];
    expect(claim).toMatchObject({
      topic: "action_proposal.accepted.v1",
      aggregateType: "business_action",
      aggregateId: actionId,
      attemptCount: 1,
    });
    await expect(
      store.markPublished({
        actor,
        messageId: claim?.messageId ?? "",
        claimToken: "00000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toThrow();
    await store.markPublished({
      actor,
      messageId: claim?.messageId ?? "",
      claimToken: claim?.claimToken ?? "",
    });
    await expect(
      store.claimBatch({
        actor,
        now: "2026-09-01T00:02:00.000Z",
        limit: 10,
        leaseMs: 60_000,
      }),
    ).resolves.toEqual([]);
  });

  test("recovers an expired Outbox lease without losing its attempt history", async () => {
    await seedOutboxMessage(database);
    const store = new KyselyOutboxStore(database.db);
    await store.claimBatch({
      actor,
      now: "2026-09-01T00:00:00.000Z",
      limit: 10,
      leaseMs: 60_000,
    });

    expect(
      await store.recoverExpiredClaims({
        actor,
        expiredBefore: "2026-09-01T00:01:00.000Z",
        availableAt: "2026-09-01T00:01:00.000Z",
      }),
    ).toEqual({ recovered: 1 });
    const claimedAgain = await store.claimBatch({
      actor,
      now: "2026-09-01T00:01:00.000Z",
      limit: 10,
      leaseMs: 60_000,
    });
    expect(claimedAgain[0]).toMatchObject({ attemptCount: 2 });
  });

  test("recovers expired reminder and delivery leases for the next worker tick", async () => {
    const reminderStore = new KyselyReminderStore(database.db);
    await new ScheduleActionReminders({
      store: reminderStore,
    }).onActionAccepted({
      actor,
      actionId,
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    const [firstReminderClaim] = await reminderStore.claimDueBatch({
      actor,
      now: plannedAt,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(firstReminderClaim).toMatchObject({ attemptCount: 1 });
    expect(
      await reminderStore.recoverExpiredClaims({
        actor,
        expiredBefore: "2026-09-01T01:01:00.000Z",
        availableAt: "2026-09-01T01:01:00.000Z",
      }),
    ).toEqual({ recovered: 1 });
    const [secondReminderClaim] = await reminderStore.claimDueBatch({
      actor,
      now: "2026-09-01T01:01:00.000Z",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(secondReminderClaim).toMatchObject({ attemptCount: 2 });

    await reminderStore.materializeDueReminder({
      actor,
      reminderId: secondReminderClaim?.reminderId ?? "",
      claimToken: secondReminderClaim?.claimToken ?? "",
      notifiedAt: "2026-09-01T01:01:01.000Z",
    });
    const notificationStore = new KyselyNotificationStore(database.db);
    const deliveryId = await readFeishuDeliveryId(database);
    const firstDeliveryClaim = await notificationStore.claimDelivery({
      actor,
      deliveryId,
      now: "2026-09-01T01:01:01.000Z",
      leaseMs: 60_000,
    });
    expect(firstDeliveryClaim).toMatchObject({ attemptCount: 1 });
    expect(
      await notificationStore.recoverExpiredClaims({
        actor,
        expiredBefore: "2026-09-01T01:02:01.000Z",
        availableAt: "2026-09-01T01:02:01.000Z",
      }),
    ).toEqual({ recovered: 1 });
    await expect(
      notificationStore.listAvailableDeliveryIds({
        actor,
        now: "2026-09-01T01:02:01.000Z",
        limit: 1,
      }),
    ).resolves.toEqual([deliveryId]);
    await expect(
      notificationStore.claimDelivery({
        actor,
        deliveryId,
        now: "2026-09-01T01:02:01.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toMatchObject({ attemptCount: 2 });
  });

  test("schedules one stable due reminder and materializes inbox truth atomically", async () => {
    const reminderStore = new KyselyReminderStore(database.db);
    const scheduler = new ScheduleActionReminders({ store: reminderStore });
    expect(
      await scheduler.onActionAccepted({
        actor,
        actionId,
        occurredAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toEqual({ scheduled: 1 });
    await scheduler.onActionAccepted({
      actor,
      actionId,
      occurredAt: "2026-09-01T00:00:00.000Z",
    });

    const dispatcher = new DispatchDueReminders({
      store: reminderStore,
      clock: { now: () => new Date(plannedAt) },
    });
    expect(
      await dispatcher.runOnce({ actor, limit: 50, leaseMs: 60_000 }),
    ).toEqual({
      claimed: 1,
      notified: 1,
      cancelled: 0,
      rescheduled: 0,
      deadLettered: 0,
    });
    expect(
      await dispatcher.runOnce({ actor, limit: 50, leaseMs: 60_000 }),
    ).toEqual({
      claimed: 0,
      notified: 0,
      cancelled: 0,
      rescheduled: 0,
      deadLettered: 0,
    });
    expect(await readNotificationCounts(database)).toEqual({
      reminder_count: 1,
      notified_count: 1,
      event_count: 1,
      in_app_count: 1,
      feishu_count: 1,
    });
  });

  test("does not enqueue an external delivery when its adapter is disabled", async () => {
    const reminderStore = new KyselyReminderStore(database.db, {
      enabledExternalChannels: [],
    });
    await new ScheduleActionReminders({
      store: reminderStore,
    }).onActionAccepted({
      actor,
      actionId,
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    await new DispatchDueReminders({
      store: reminderStore,
      clock: { now: () => new Date(plannedAt) },
    }).runOnce({ actor, limit: 50, leaseMs: 60_000 });

    expect(await readNotificationCounts(database)).toMatchObject({
      event_count: 1,
      in_app_count: 1,
      feishu_count: 0,
    });
  });

  test("does not enqueue an external delivery without an active tenant address", async () => {
    await withTenantTransaction(
      database.db,
      { ...actor, requestId },
      async (transaction) => {
        await transaction
          .updateTable("app.channel_addresses")
          .set({ status: "disabled" })
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .where("channel", "=", "feishu")
          .executeTakeFirstOrThrow();
      },
    );
    const reminderStore = new KyselyReminderStore(database.db);
    await new ScheduleActionReminders({
      store: reminderStore,
    }).onActionAccepted({
      actor,
      actionId,
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    await new DispatchDueReminders({
      store: reminderStore,
      clock: { now: () => new Date(plannedAt) },
    }).runOnce({ actor, limit: 50, leaseMs: 60_000 });

    expect(await readNotificationCounts(database)).toMatchObject({
      event_count: 1,
      in_app_count: 1,
      feishu_count: 0,
    });
  });

  test("keeps the due reminder valid when the action advances to in progress", async () => {
    const reminderStore = new KyselyReminderStore(database.db);
    await new ScheduleActionReminders({
      store: reminderStore,
    }).onActionAccepted({
      actor,
      actionId,
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    await transitionActionToInProgress(database);

    expect(
      await new DispatchDueReminders({
        store: reminderStore,
        clock: { now: () => new Date(plannedAt) },
      }).runOnce({ actor, limit: 50, leaseMs: 60_000 }),
    ).toEqual({
      claimed: 1,
      notified: 1,
      cancelled: 0,
      rescheduled: 0,
      deadLettered: 0,
    });
    expect(await readNotificationCounts(database)).toMatchObject({
      notified_count: 1,
      event_count: 1,
    });
  });

  test("cancels a reminder when a historical terminal event is replayed later", async () => {
    const reminderStore = new KyselyReminderStore(database.db);
    await new ScheduleActionReminders({
      store: reminderStore,
    }).onActionAccepted({
      actor,
      actionId,
      occurredAt: "2026-09-01T00:00:00.000Z",
    });

    expect(
      await new CancelActionReminders({ store: reminderStore }).execute({
        actor,
        actionId,
        changedAt: "2026-08-30T22:00:00.000Z",
      }),
    ).toEqual({ cancelled: 1 });
  });

  test("pages inbox facts by keyset and marks only the recipient row read idempotently", async () => {
    await seedNotificationFact(database, {
      reminderId: "72000000-0000-4000-8000-000000000061",
      notificationId: "f0000000-0000-4000-8000-000000000061",
      createdAt: "2026-09-01T01:01:00.000Z",
    });
    await seedNotificationFact(database, {
      reminderId: "72000000-0000-4000-8000-000000000062",
      notificationId: "f0000000-0000-4000-8000-000000000062",
      createdAt: "2026-09-01T01:02:00.000Z",
    });
    const store = new KyselyNotificationStore(database.db);

    const first = await store.listInbox({ actor, limit: 1 });
    const second = await store.listInbox({
      actor,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(first.items.map((item) => item.notificationId)).toEqual([
      "f0000000-0000-4000-8000-000000000062",
    ]);
    expect(second.items.map((item) => item.notificationId)).toEqual([
      "f0000000-0000-4000-8000-000000000061",
    ]);
    expect(second.items[0]?.notificationId).not.toBe(
      first.items[0]?.notificationId,
    );

    const receipt = await store.markRead({
      actor,
      notificationId: first.items[0]?.notificationId ?? "",
      readAt: "2026-09-01T01:03:00.000Z",
    });
    expect(
      await store.markRead({
        actor,
        notificationId: first.items[0]?.notificationId ?? "",
        readAt: "2026-09-01T01:04:00.000Z",
      }),
    ).toEqual(receipt);
    await expect(
      store.listInbox({ actor, limit: 20, unreadOnly: true }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          notificationId: "f0000000-0000-4000-8000-000000000061",
        }),
      ],
    });
  });

  test("claims and completes external delivery without querying business tables", async () => {
    const reminderStore = new KyselyReminderStore(database.db);
    await new ScheduleActionReminders({
      store: reminderStore,
    }).onActionAccepted({
      actor,
      actionId,
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    await new DispatchDueReminders({
      store: reminderStore,
      clock: { now: () => new Date(plannedAt) },
    }).runOnce({ actor, limit: 50, leaseMs: 60_000 });
    const notificationStore = new KyselyNotificationStore(database.db);
    const deliveryId = await readFeishuDeliveryId(database);
    const sent: unknown[] = [];
    const channel: NotificationChannel = {
      channel: "feishu",
      async send(input) {
        sent.push(input);
        return {
          providerMessageId: "om_synthetic",
          providerRequestId: "log_synthetic",
        };
      },
    };

    expect(
      await new NotificationDelivery({
        store: notificationStore,
        channels: [channel],
        clock: { now: () => new Date("2026-09-01T01:00:01.000Z") },
      }).deliver({ actor, deliveryId, leaseMs: 60_000 }),
    ).toEqual({ status: "delivered" });
    expect(sent).toEqual([
      expect.objectContaining({
        recipientAddress: "ou_synthetic_owner",
        title: "经营动作已到计划时间",
        deepLink: `/actions?actionId=${actionId}`,
      }),
    ]);
  });
});

async function seedAcceptedActionAndNotificationConfig(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId },
    async (transaction) => {
      const runId = "a0000000-0000-4000-8000-000000000051";
      const stateId = "b0000000-0000-4000-8000-000000000051";
      const proposalId = "c0000000-0000-4000-8000-000000000051";
      await transaction
        .insertInto("app.analysis_runs")
        .values({
          tenant_id: actor.tenantId,
          id: runId,
          entity_id: SYNTHETIC_ENTITY_ID,
          trigger_event_id: null,
          rule_version: "rules-v1",
          analyzer_config_version: "deterministic-v1",
          input_version: "a".repeat(64),
          status: "completed",
          error_code: null,
          error_message: null,
          started_at: "2026-08-31T23:00:00.000Z",
          finished_at: "2026-08-31T23:01:00.000Z",
          created_by: actor.userId,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.battle_state_versions")
        .values({
          tenant_id: actor.tenantId,
          id: stateId,
          entity_id: SYNTHETIC_ENTITY_ID,
          version_no: 1,
          input_version: "a".repeat(64),
          relationship_score: 50,
          potential_score: 50,
          quadrant_code: "develop",
          primary_opportunity_id: null,
          risk_level: "medium",
          data_sufficiency: "partial",
          data_gaps: [],
          summary: "Synthetic state",
          analysis_run_id: runId,
          effective_at: "2026-08-31T23:01:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_proposals")
        .values({
          tenant_id: actor.tenantId,
          id: proposalId,
          entity_id: SYNTHETIC_ENTITY_ID,
          opportunity_id: null,
          title: "推进正式方案",
          description: "在计划时间推进",
          suggested_owner_id: actor.userId,
          suggested_priority: "high",
          suggested_planned_at: plannedAt,
          source_battle_state_version_id: stateId,
          status: "accepted",
          version_no: 1,
          proposed_at: "2026-08-31T23:02:00.000Z",
          expires_at: "2026-09-07T23:02:00.000Z",
          decided_at: "2026-08-31T23:03:00.000Z",
          decided_by: actor.userId,
          decision_reason: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.business_actions")
        .values({
          tenant_id: actor.tenantId,
          id: actionId,
          entity_id: SYNTHETIC_ENTITY_ID,
          opportunity_id: null,
          title: "推进正式方案",
          description: "在计划时间推进",
          owner_user_id: actor.userId,
          priority: "high",
          status: "planned",
          planned_at: plannedAt,
          completed_at: null,
          source_proposal_id: proposalId,
          confirmed_by: actor.userId,
          confirmed_at: "2026-08-31T23:03:00.000Z",
          version_no: 1,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_status_history")
        .values({
          tenant_id: actor.tenantId,
          action_id: actionId,
          from_status: null,
          to_status: "planned",
          changed_by: actor.userId,
          reason: "Accepted synthetic action.",
          changed_at: "2026-08-31T23:03:00.000Z",
          version_no: 1,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.reminder_policy_versions")
        .values({
          tenant_id: actor.tenantId,
          id: policyId,
          policy_key: "default_action_due",
          version_no: 1,
          name: "默认动作到期提醒",
          status: "published",
          nodes: [
            {
              kind: "due",
              offsetMinutes: 0,
              recipient: "owner",
              channels: ["in_app", "feishu"],
            },
          ],
          effective_at: "2026-08-31T23:00:00.000Z",
          published_by: actor.userId,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.notification_template_versions")
        .values(
          (["in_app", "feishu"] as const).map((channel) => ({
            tenant_id: actor.tenantId,
            template_key: "action_due",
            channel,
            version_no: 1,
            name: `动作到期${channel}通知`,
            status: "published" as const,
            title_template: "经营动作已到计划时间",
            body_template: "{{action_title}} 已到计划时间，请及时推进。",
            deep_link_template: "/actions?actionId={{action_id}}",
            priority: "high" as const,
            effective_at: "2026-08-31T23:00:00.000Z",
            published_by: actor.userId,
          })),
        )
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.channel_addresses")
        .values({
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          channel: "feishu",
          external_user_id: "ou_synthetic_owner",
          status: "active",
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function seedOutboxMessage(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId },
    async (transaction) => {
      const eventId = "74000000-0000-4000-8000-000000000051";
      await transaction
        .insertInto("app.domain_events")
        .values({
          tenant_id: actor.tenantId,
          id: eventId,
          aggregate_type: "business_action",
          aggregate_id: actionId,
          event_type: "action_proposal.accepted.v1",
          event_version: 1,
          payload: { actionId },
          occurred_at: "2026-09-01T00:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.outbox_messages")
        .values({
          tenant_id: actor.tenantId,
          event_id: eventId,
          topic: "action_proposal.accepted.v1",
          payload: { actionId },
          status: "pending",
          dedupe_key: `action-proposal-accepted:${actionId}`,
          available_at: "2026-09-01T00:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function transitionActionToInProgress(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId },
    async (transaction) => {
      await transaction
        .updateTable("app.business_actions")
        .set({
          status: "in_progress",
          version_no: 2,
          updated_at: "2026-09-01T00:30:00.000Z",
        })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", actionId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_status_history")
        .values({
          tenant_id: actor.tenantId,
          action_id: actionId,
          from_status: "planned",
          to_status: "in_progress",
          changed_by: actor.userId,
          reason: "Started synthetic action.",
          changed_at: "2026-09-01T00:30:00.000Z",
          version_no: 2,
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function seedNotificationFact(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: { reminderId: string; notificationId: string; createdAt: string },
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId },
    async (transaction) => {
      await transaction
        .insertInto("app.reminder_instances")
        .values({
          tenant_id: actor.tenantId,
          id: input.reminderId,
          action_id: actionId,
          recipient_user_id: actor.userId,
          policy_version_id: policyId,
          action_version_no: 1,
          kind: "due",
          remind_at: input.createdAt,
          channels: ["in_app"],
          status: "scheduled",
          available_at: input.createdAt,
          dedupe_key: `test-reminder:${input.reminderId}`,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.notification_events")
        .values({
          tenant_id: actor.tenantId,
          id: input.notificationId,
          recipient_user_id: actor.userId,
          reminder_id: input.reminderId,
          event_type: "action_due",
          title: "经营动作已到计划时间",
          body: "推进正式方案 已到计划时间，请及时推进。",
          deep_link: `/actions?actionId=${actionId}`,
          priority: "high",
          read_at: null,
          dedupe_key: `test-notification:${input.notificationId}`,
          created_at: input.createdAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("app.reminder_instances")
        .set({
          status: "notified",
          notification_event_id: input.notificationId,
          updated_at: input.createdAt,
        })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", input.reminderId)
        .executeTakeFirstOrThrow();
    },
  );
}

async function readNotificationCounts(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<Record<string, number>> {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId },
    async (transaction) => {
      const result = await sql<Record<string, number>>`
        select
          (select count(*)::int from app.reminder_instances) as reminder_count,
          (select count(*)::int from app.reminder_instances where status = 'notified') as notified_count,
          (select count(*)::int from app.notification_events) as event_count,
          (select count(*)::int from app.notification_deliveries where channel = 'in_app') as in_app_count,
          (select count(*)::int from app.notification_deliveries where channel = 'feishu') as feishu_count
      `.execute(transaction);
      return result.rows[0] ?? {};
    },
  );
}

async function readFeishuDeliveryId(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<string> {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId },
    async (transaction) => {
      const row = await transaction
        .selectFrom("app.notification_deliveries")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("channel", "=", "feishu")
        .executeTakeFirstOrThrow();
      return row.id;
    },
  );
}
