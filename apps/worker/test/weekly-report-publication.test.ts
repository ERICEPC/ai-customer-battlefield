import { fileURLToPath } from "node:url";
import type { NotificationChannel } from "@battlefield/core";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  KyselyNotificationStore,
  KyselyWeeklyReportRepository,
  migrateDatabase,
  withTenantTransaction,
} from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticReminderConfiguration,
} from "@battlefield/database/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createReminderWorker } from "../src/worker.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const PERIOD_START = "2026-08-24T00:00:00.000Z";
const PERIOD_END = "2026-08-31T00:00:00.000Z";

describe("weekly-report publication notification", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticReminderConfiguration(database);
  });

  afterEach(async () => {
    await database.close();
  });

  test("turns one publication Outbox message into in-app truth and optional Feishu delivery", async () => {
    await seedReportNotificationTemplate(database);
    const actor = {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
    };
    const repository = new KyselyWeeklyReportRepository(database.db);
    const generated = await repository.generate({
      actor,
      idempotencyKey: "worker-weekly-report-generate",
      reportType: "personal",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: PERIOD_END,
      dataCutoffAt: PERIOD_END,
    });
    const published = await repository.publish({
      actor,
      versionId: generated.versionId,
      lockVersion: generated.lockVersion,
      idempotencyKey: "worker-weekly-report-publish",
    });
    const send = vi.fn().mockResolvedValue({
      providerMessageId: "om_weekly_report",
      providerRequestId: "req_weekly_report",
    });
    const feishu: NotificationChannel = { channel: "feishu", send };
    const worker = createReminderWorker({
      database: database.db,
      actor,
      batchSize: 20,
      leaseMs: 60_000,
      clock: { now: () => new Date("2026-09-01T00:00:00.000Z") },
      channels: [feishu],
    });

    const first = await worker.tick();
    const second = await worker.tick();

    expect(first).toMatchObject({ claimed: 2, completed: 2, failed: 0 });
    expect(second).toMatchObject({ claimed: 0, completed: 0, failed: 0 });
    const inbox = await new KyselyNotificationStore(database.db).listInbox({
      actor,
      limit: 20,
    });
    expect(inbox.items).toEqual([
      expect.objectContaining({
        eventType: "weekly_report_published",
        title: "本周战报已发布",
        body: "《个人周报》已完成审阅并发布。",
        deepLink: `/reports?reportId=${published.reportId}&versionId=${published.versionId}`,
        priority: "medium",
        readAt: null,
      }),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientAddress: "ou_synthetic_demo_owner",
        deepLink: `/reports?reportId=${published.reportId}&versionId=${published.versionId}`,
      }),
    );
    const counts = await deliveryCounts(database, published.versionId);
    expect(counts).toEqual({ eventCount: 1, inAppCount: 1, feishuCount: 1 });
    const deliveredReport = await repository.get({
      actor,
      versionId: published.versionId,
    });
    expect(deliveredReport.delivery).toEqual({
      status: "delivered",
      channels: [
        { channel: "feishu", status: "delivered" },
        { channel: "in_app", status: "delivered" },
      ],
    });
  });

  test("rejects a published template that drops the exact report identifiers", async () => {
    await seedReportNotificationTemplate(database, "/reports");
    const actor = {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
    };
    const repository = new KyselyWeeklyReportRepository(database.db);
    const generated = await repository.generate({
      actor,
      idempotencyKey: "worker-invalid-link-generate",
      reportType: "personal",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      generatedAt: PERIOD_END,
      dataCutoffAt: PERIOD_END,
    });
    const published = await repository.publish({
      actor,
      versionId: generated.versionId,
      lockVersion: generated.lockVersion,
      idempotencyKey: "worker-invalid-link-publish",
    });

    await expect(
      new KyselyNotificationStore(database.db).materialize({
        actor,
        reportId: published.reportId,
        reportVersionId: published.versionId,
        recipientUserId: SYNTHETIC_USER_ID,
        reportType: "personal",
        publishedAt: published.publishedAt ?? PERIOD_END,
      }),
    ).rejects.toThrow(/notification template is invalid/i);
  });
});

async function seedReportNotificationTemplate(
  database: DatabaseHandle<BattlefieldDatabase>,
  deepLinkTemplate = "/reports?reportId={{report_id}}&versionId={{report_version_id}}",
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: "90000000-0000-4000-8000-000000000081",
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
        .insertInto("app.notification_template_versions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          template_key: "weekly_report_published",
          channel: "in_app",
          version_no: 1,
          name: "周报发布站内通知",
          status: "published",
          title_template: "本周战报已发布",
          body_template: "《{{report_title}}》已完成审阅并发布。",
          deep_link_template: deepLinkTemplate,
          priority: "medium",
          effective_at: "2026-08-01T00:00:00.000Z",
          published_by: SYNTHETIC_USER_ID,
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function deliveryCounts(
  database: DatabaseHandle<BattlefieldDatabase>,
  versionId: string,
) {
  return withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: "90000000-0000-4000-8000-000000000082",
    },
    async (transaction) => {
      const event = await transaction
        .selectFrom("app.notification_events")
        .select("id")
        .where("report_version_id", "=", versionId)
        .executeTakeFirstOrThrow();
      const rows = await transaction
        .selectFrom("app.notification_deliveries")
        .select(["channel", "status"])
        .where("notification_event_id", "=", event.id)
        .execute();
      return {
        eventCount: 1,
        inAppCount: rows.filter(
          (row) => row.channel === "in_app" && row.status === "delivered",
        ).length,
        feishuCount: rows.filter(
          (row) => row.channel === "feishu" && row.status === "delivered",
        ).length,
      };
    },
  );
}
