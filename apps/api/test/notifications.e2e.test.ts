import { fileURLToPath } from "node:url";
import {
  inboxPageSchema,
  markNotificationReadResponseSchema,
  notificationApiErrorSchema,
} from "@battlefield/contracts";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  migrateDatabase,
  withTenantTransaction,
} from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_OTHER_TENANT_ID,
  SYNTHETIC_OTHER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticAcceptedAction,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticInboxNotification,
  seedSyntheticReminderConfiguration,
} from "@battlefield/database/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const SECONDARY_USER_ID = "30000000-0000-4000-8000-000000000003";
const LATEST_NOTIFICATION_ID = "f0000000-0000-4000-8000-000000000073";
const OLDER_NOTIFICATION_ID = "f0000000-0000-4000-8000-000000000072";
const READ_NOTIFICATION_ID = "f0000000-0000-4000-8000-000000000071";
const OTHER_RECIPIENT_NOTIFICATION_ID = "f0000000-0000-4000-8000-000000000074";

describe("inbox notification API", () => {
  let app: INestApplication;
  let unavailableApp: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticReminderConfiguration(database);
    await seedSyntheticAcceptedAction(database);
    await withTenantTransaction(
      database.db,
      {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_USER_ID,
        requestId: "90000000-0000-4000-8000-000000000079",
      },
      async (transaction) => {
        await transaction
          .insertInto("app.users")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: SECONDARY_USER_ID,
            display_name: "secondary-owner",
          })
          .executeTakeFirstOrThrow();
      },
    );
    await seedSyntheticInboxNotification(database, {
      reminderId: "72000000-0000-4000-8000-000000000071",
      notificationId: READ_NOTIFICATION_ID,
      recipientUserId: SYNTHETIC_USER_ID,
      createdAt: "2026-08-31T00:05:00.000Z",
      readAt: "2026-08-31T00:06:00.000Z",
    });
    await seedSyntheticInboxNotification(database, {
      reminderId: "72000000-0000-4000-8000-000000000072",
      notificationId: OLDER_NOTIFICATION_ID,
      recipientUserId: SYNTHETIC_USER_ID,
      createdAt: "2026-08-31T00:07:00.000Z",
    });
    await seedSyntheticInboxNotification(database, {
      reminderId: "72000000-0000-4000-8000-000000000073",
      notificationId: LATEST_NOTIFICATION_ID,
      recipientUserId: SYNTHETIC_USER_ID,
      createdAt: "2026-08-31T00:08:00.000Z",
    });
    await seedSyntheticInboxNotification(database, {
      reminderId: "72000000-0000-4000-8000-000000000074",
      notificationId: OTHER_RECIPIENT_NOTIFICATION_ID,
      recipientUserId: SECONDARY_USER_ID,
      createdAt: "2026-08-31T00:09:00.000Z",
    });

    app = await createApp(database);
    unavailableApp = await createApp(null);
  });

  afterAll(async () => {
    await unavailableApp?.close();
    await app?.close();
    await database?.close();
  });

  test("requires the development actor and validates query and identifiers", async () => {
    await request(app.getHttpServer()).get("/api/v1/inbox").expect(401);
    const invalidLimit = await actorRequest(app)
      .get("/api/v1/inbox?limit=101")
      .expect(400);
    expect(notificationApiErrorSchema.parse(invalidLimit.body).code).toBe(
      "INVALID_INBOX_QUERY",
    );
    const invalidCursor = await actorRequest(app)
      .get("/api/v1/inbox?cursor=not-a-cursor")
      .expect(400);
    expect(notificationApiErrorSchema.parse(invalidCursor.body).code).toBe(
      "INVALID_INBOX_QUERY",
    );
    const invalidId = await actorRequest(app)
      .post("/api/v1/inbox/not-a-uuid/read")
      .send({})
      .expect(400);
    expect(notificationApiErrorSchema.parse(invalidId.body).code).toBe(
      "INVALID_NOTIFICATION_ID",
    );
  });

  test("filters unread notifications and pages by a stable keyset cursor", async () => {
    const firstResponse = await actorRequest(app)
      .get("/api/v1/inbox?unreadOnly=true&limit=1")
      .expect(200);
    const first = inboxPageSchema.parse(firstResponse.body);
    expect(first.items.map((item) => item.notificationId)).toEqual([
      LATEST_NOTIFICATION_ID,
    ]);
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await actorRequest(app)
      .get(
        `/api/v1/inbox?unreadOnly=true&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      )
      .expect(200);
    const second = inboxPageSchema.parse(secondResponse.body);
    expect(second.items.map((item) => item.notificationId)).toEqual([
      OLDER_NOTIFICATION_ID,
    ]);
    expect(second.nextCursor).toBeNull();
    expect(second.items[0]).toMatchObject({
      title: "经营动作已到计划时间",
      body: "推进正式方案 已到计划时间，请及时推进。",
      deepLink: "/actions?actionId=d0000000-0000-4000-8000-000000000071",
      priority: "high",
      readAt: null,
    });
  });

  test("marks a notification read idempotently and removes it from unread results", async () => {
    const firstResponse = await actorRequest(app)
      .post(`/api/v1/inbox/${LATEST_NOTIFICATION_ID}/read`)
      .send({})
      .expect(201);
    const first = markNotificationReadResponseSchema.parse(firstResponse.body);
    const repeatedResponse = await actorRequest(app)
      .post(`/api/v1/inbox/${LATEST_NOTIFICATION_ID}/read`)
      .send({})
      .expect(201);
    expect(
      markNotificationReadResponseSchema.parse(repeatedResponse.body),
    ).toEqual(first);

    const unreadResponse = await actorRequest(app)
      .get("/api/v1/inbox?unreadOnly=true&limit=20")
      .expect(200);
    expect(
      inboxPageSchema
        .parse(unreadResponse.body)
        .items.map((item) => item.notificationId),
    ).toEqual([OLDER_NOTIFICATION_ID]);
  });

  test("hides notifications owned by another recipient or tenant", async () => {
    const recipientResponse = await actorRequest(app)
      .post(`/api/v1/inbox/${OTHER_RECIPIENT_NOTIFICATION_ID}/read`)
      .send({})
      .expect(404);
    expect(notificationApiErrorSchema.parse(recipientResponse.body).code).toBe(
      "NOTIFICATION_NOT_FOUND",
    );

    const otherTenantPage = await request(app.getHttpServer())
      .get("/api/v1/inbox")
      .set("x-tenant-id", SYNTHETIC_OTHER_TENANT_ID)
      .set("x-user-id", SYNTHETIC_OTHER_USER_ID)
      .expect(200);
    expect(inboxPageSchema.parse(otherTenantPage.body).items).toEqual([]);
    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${OLDER_NOTIFICATION_ID}/read`)
      .set("x-tenant-id", SYNTHETIC_OTHER_TENANT_ID)
      .set("x-user-id", SYNTHETIC_OTHER_USER_ID)
      .send({})
      .expect(404);
  });

  test("fails closed when notification persistence is unavailable", async () => {
    const response = await actorRequest(unavailableApp)
      .get("/api/v1/inbox")
      .expect(503);
    expect(notificationApiErrorSchema.parse(response.body).code).toBe(
      "NOTIFICATION_STORE_UNAVAILABLE",
    );
  });
});

async function createApp(
  database: DatabaseHandle<BattlefieldDatabase> | null,
): Promise<INestApplication> {
  const moduleReference = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DATABASE_HANDLE)
    .useValue(database)
    .compile();
  const app = moduleReference.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

function actorRequest(app: INestApplication) {
  return {
    get: (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set("x-tenant-id", SYNTHETIC_TENANT_ID)
        .set("x-user-id", SYNTHETIC_USER_ID),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set("x-tenant-id", SYNTHETIC_TENANT_ID)
        .set("x-user-id", SYNTHETIC_USER_ID),
  };
}
