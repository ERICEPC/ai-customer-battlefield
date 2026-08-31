import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  weeklyReportApiErrorSchema,
  weeklyReportDetailSchema,
  weeklyReportPageSchema,
} from "@battlefield/contracts";
import {
  type Clock,
  type WeeklyReportRepository,
  WeeklyReportResultLimitExceededError,
} from "@battlefield/core";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  migrateDatabase,
  withTenantTransaction,
} from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_OTHER_TENANT_ID,
  SYNTHETIC_OTHER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticAcceptedAction,
  seedSyntheticBusinessEntityDirectory,
} from "@battlefield/database/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";
import {
  WEEKLY_REPORT_CLOCK,
  WEEKLY_REPORT_REPOSITORY,
} from "../src/weekly-reports/weekly-reports.providers.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const MANAGER_ID = "30000000-0000-4000-8000-000000000096";
const FIXED_NOW = "2026-08-31T08:00:00.000Z";
const PERIOD = {
  periodStart: "2026-08-24T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
} as const;

describe("weekly report API", () => {
  let app: INestApplication;
  let unavailableApp: INestApplication;
  let limitExceededApp: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticAcceptedAction(database);
    await seedManager(database);
    app = await createApp(database);
    unavailableApp = await createApp(null);
    limitExceededApp = await createApp(database, limitExceededRepository());
  });

  afterAll(async () => {
    await unavailableApp?.close();
    await limitExceededApp?.close();
    await app?.close();
    await database?.close();
  });

  test("requires actor identity and rejects client-controlled scope", async () => {
    await request(app.getHttpServer()).get("/api/v1/reports").expect(401);
    await request(app.getHttpServer())
      .post("/api/v1/reports")
      .send({ ...PERIOD, reportType: "personal" })
      .expect(401);

    const queryOverride = await sellerRequest(app)
      .get(`/api/v1/reports?tenantId=${SYNTHETIC_OTHER_TENANT_ID}`)
      .expect(400);
    expect(weeklyReportApiErrorSchema.parse(queryOverride.body).code).toBe(
      "INVALID_WEEKLY_REPORT_REQUEST",
    );

    const bodyOverride = await sellerRequest(app)
      .post("/api/v1/reports")
      .send({
        ...PERIOD,
        reportType: "personal",
        tenantId: SYNTHETIC_OTHER_TENANT_ID,
        userId: SYNTHETIC_OTHER_USER_ID,
        scope: "tenant",
      })
      .expect(400);
    expect(weeklyReportApiErrorSchema.parse(bodyOverride.body).code).toBe(
      "INVALID_WEEKLY_REPORT_REQUEST",
    );
  });

  test("runs the personal review, publish and revision lifecycle", async () => {
    const generateKey = "weekly-personal-lifecycle";
    const generatedResponse = await sellerRequest(app)
      .post("/api/v1/reports", generateKey)
      .send({ ...PERIOD, reportType: "personal" })
      .expect(201);
    const generated = weeklyReportDetailSchema.parse(generatedResponse.body);
    expect(generated).toMatchObject({
      reportType: "personal",
      revisionNo: 1,
      lockVersion: 2,
      status: "in_review",
      dataCutoffAt: FIXED_NOW,
      scope: { label: "本人责任范围", entityCount: 1 },
      generator: {
        kind: "deterministic",
        version: "weekly-progress-v1",
        ruleVersion: "weekly-progress-v1",
        promptVersion: null,
      },
      delivery: { status: "not_started", channels: [] },
    });
    expect(generated.sections.map((section) => section.kind)).toEqual([
      "progress",
      "risk",
      "next_action",
      "data_gap",
    ]);
    expect(
      generated.sections
        .flatMap((section) => section.items)
        .every((item) => item.entityId === SYNTHETIC_ENTITY_ID),
    ).toBe(true);

    const replay = await sellerRequest(app)
      .post("/api/v1/reports", generateKey)
      .send({ ...PERIOD, reportType: "personal" })
      .expect(201);
    expect(weeklyReportDetailSchema.parse(replay.body)).toEqual(generated);

    const list = await sellerRequest(app)
      .get("/api/v1/reports?reportType=personal&status=in_review&limit=20")
      .expect(200);
    expect(weeklyReportPageSchema.parse(list.body).items).toEqual([
      expect.objectContaining({ versionId: generated.versionId }),
    ]);

    const detail = await sellerRequest(app)
      .get(`/api/v1/reports/${generated.versionId}`)
      .expect(200);
    expect(weeklyReportDetailSchema.parse(detail.body)).toEqual(generated);

    const firstItem = generated.sections.flatMap((section) => section.items)[0];
    expect(firstItem).toBeDefined();
    const reviewedResponse = await sellerRequest(app)
      .patch(`/api/v1/reports/${generated.versionId}/review`)
      .send({
        lockVersion: generated.lockVersion,
        note: "本周重点已人工核对。",
        items: firstItem ? [{ itemId: firstItem.itemId, included: false }] : [],
      })
      .expect(200);
    const reviewed = weeklyReportDetailSchema.parse(reviewedResponse.body);
    expect(reviewed).toMatchObject({
      lockVersion: generated.lockVersion + 1,
      note: "本周重点已人工核对。",
      status: "in_review",
    });
    if (firstItem) {
      expect(
        reviewed.sections
          .flatMap((section) => section.items)
          .find((item) => item.itemId === firstItem.itemId)?.included,
      ).toBe(false);
    }

    const staleReview = await sellerRequest(app)
      .patch(`/api/v1/reports/${generated.versionId}/review`)
      .send({ lockVersion: generated.lockVersion, note: "stale", items: [] })
      .expect(409);
    expect(weeklyReportApiErrorSchema.parse(staleReview.body).code).toBe(
      "WEEKLY_REPORT_VERSION_CONFLICT",
    );

    const publishKey = "weekly-personal-publish";
    const publishedResponse = await sellerRequest(app)
      .post(`/api/v1/reports/${generated.versionId}/publish`, publishKey)
      .send({ lockVersion: reviewed.lockVersion })
      .expect(201);
    const published = weeklyReportDetailSchema.parse(publishedResponse.body);
    expect(published).toMatchObject({
      status: "published",
      lockVersion: reviewed.lockVersion + 1,
      delivery: { status: "pending", channels: [] },
      capabilities: { canReview: false, canPublish: false, canRevise: true },
    });
    expect(published.publishedAt).not.toBeNull();

    const publishReplay = await sellerRequest(app)
      .post(`/api/v1/reports/${generated.versionId}/publish`, publishKey)
      .send({ lockVersion: reviewed.lockVersion })
      .expect(201);
    expect(weeklyReportDetailSchema.parse(publishReplay.body)).toEqual(
      published,
    );
    expect(
      await publicationArtifactCounts(
        database,
        generated.reportId,
        generated.versionId,
      ),
    ).toEqual({
      auditCount: 1,
      eventCount: 1,
      outboxCount: 1,
    });

    const revisedResponse = await sellerRequest(app)
      .post(`/api/v1/reports/${generated.versionId}/revise`, "weekly-revise")
      .send({ lockVersion: published.lockVersion })
      .expect(201);
    const revised = weeklyReportDetailSchema.parse(revisedResponse.body);
    expect(revised).toMatchObject({
      reportId: generated.reportId,
      revisionNo: 2,
      status: "in_review",
      previousVersionId: generated.versionId,
    });
    expect(revised.versionId).not.toBe(generated.versionId);
  });

  test("uses current observer scope and never widens roles or tenants", async () => {
    const managedResponse = await managerRequest(app)
      .post("/api/v1/reports")
      .send({ ...PERIOD, reportType: "managed_portfolio" })
      .expect(201);
    const managed = weeklyReportDetailSchema.parse(managedResponse.body);
    expect(managed).toMatchObject({
      reportType: "managed_portfolio",
      scope: { label: "当前管理关注范围", entityCount: 1 },
    });

    const sellerManaged = await sellerRequest(app)
      .post("/api/v1/reports")
      .send({ ...PERIOD, reportType: "managed_portfolio" })
      .expect(404);
    expect(weeklyReportApiErrorSchema.parse(sellerManaged.body).code).toBe(
      "WEEKLY_REPORT_NOT_FOUND",
    );

    const managerPersonal = await managerRequest(app)
      .post("/api/v1/reports")
      .send({ ...PERIOD, reportType: "personal" })
      .expect(404);
    expect(weeklyReportApiErrorSchema.parse(managerPersonal.body).code).toBe(
      "WEEKLY_REPORT_NOT_FOUND",
    );

    const foreignRead = await actorRequest(app, {
      tenantId: SYNTHETIC_OTHER_TENANT_ID,
      userId: SYNTHETIC_OTHER_USER_ID,
    })
      .get(`/api/v1/reports/${managed.versionId}`)
      .expect(404);
    expect(weeklyReportApiErrorSchema.parse(foreignRead.body).code).toBe(
      "WEEKLY_REPORT_NOT_FOUND",
    );
  });

  test("maps invalid, unavailable and bounded failures explicitly", async () => {
    const missingKey = await request(app.getHttpServer())
      .post("/api/v1/reports")
      .set("x-tenant-id", SYNTHETIC_TENANT_ID)
      .set("x-user-id", SYNTHETIC_USER_ID)
      .send({ ...PERIOD, reportType: "personal" })
      .expect(400);
    expect(weeklyReportApiErrorSchema.parse(missingKey.body).code).toBe(
      "INVALID_WEEKLY_REPORT_REQUEST",
    );

    const invalidCursor = await sellerRequest(app)
      .get("/api/v1/reports?cursor=not-a-cursor")
      .expect(400);
    expect(weeklyReportApiErrorSchema.parse(invalidCursor.body).code).toBe(
      "INVALID_WEEKLY_REPORT_REQUEST",
    );

    const unavailable = await sellerRequest(unavailableApp)
      .get("/api/v1/reports")
      .expect(503);
    expect(weeklyReportApiErrorSchema.parse(unavailable.body).code).toBe(
      "WEEKLY_REPORT_UNAVAILABLE",
    );

    const limited = await sellerRequest(limitExceededApp)
      .post("/api/v1/reports")
      .send({ ...PERIOD, reportType: "personal" })
      .expect(422);
    expect(weeklyReportApiErrorSchema.parse(limited.body).code).toBe(
      "WEEKLY_REPORT_RESULT_LIMIT_EXCEEDED",
    );
  });
});

async function seedManager(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: randomUUID(),
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
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: MANAGER_ID,
          display_name: "管理观察者",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.entity_assignments")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          entity_id: SYNTHETIC_ENTITY_ID,
          user_id: MANAGER_ID,
          assignment_role: "management_observer",
          valid_from: "2026-08-01T00:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function createApp(
  database: DatabaseHandle<BattlefieldDatabase> | null,
  repository?: WeeklyReportRepository,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE_HANDLE)
    .useValue(database)
    .overrideProvider(WEEKLY_REPORT_CLOCK)
    .useValue({ now: () => new Date(FIXED_NOW) } satisfies Clock);
  if (repository) {
    builder.overrideProvider(WEEKLY_REPORT_REPOSITORY).useValue(repository);
  }
  const moduleReference = await builder.compile();
  const app = moduleReference.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

function limitExceededRepository(): WeeklyReportRepository {
  const unavailable = async (): Promise<never> => {
    throw new WeeklyReportResultLimitExceededError();
  };
  return {
    generate: unavailable,
    list: unavailable,
    get: unavailable,
    review: unavailable,
    publish: unavailable,
    revise: unavailable,
  };
}

function sellerRequest(app: INestApplication) {
  return actorRequest(app, {
    tenantId: SYNTHETIC_TENANT_ID,
    userId: SYNTHETIC_USER_ID,
  });
}

function managerRequest(app: INestApplication) {
  return actorRequest(app, {
    tenantId: SYNTHETIC_TENANT_ID,
    userId: MANAGER_ID,
  });
}

function actorRequest(
  app: INestApplication,
  actor: { tenantId: string; userId: string },
) {
  const applyIdentity = (pending: request.Test) =>
    pending.set("x-tenant-id", actor.tenantId).set("x-user-id", actor.userId);
  return {
    get: (path: string) =>
      applyIdentity(request(app.getHttpServer()).get(path)),
    patch: (path: string) =>
      applyIdentity(request(app.getHttpServer()).patch(path)),
    post: (path: string, idempotencyKey: string = randomUUID()) =>
      applyIdentity(request(app.getHttpServer()).post(path)).set(
        "idempotency-key",
        idempotencyKey,
      ),
  };
}

async function publicationArtifactCounts(
  database: DatabaseHandle<BattlefieldDatabase>,
  reportId: string,
  versionId: string,
) {
  return withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: randomUUID(),
    },
    async (transaction) => {
      const [audit, event, outbox] = await Promise.all([
        transaction
          .selectFrom("app.audit_entries")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("aggregate_type", "=", "weekly_report")
          .where("action", "=", "weekly_report.published")
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("app.domain_events")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("event_type", "=", "weekly_report.published.v1")
          .where("aggregate_id", "=", reportId)
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("app.outbox_messages")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("topic", "=", "weekly_report.published.v1")
          .where("dedupe_key", "=", `weekly-report:${versionId}:published`)
          .executeTakeFirstOrThrow(),
      ]);
      return {
        auditCount: Number(audit.count),
        eventCount: Number(event.count),
        outboxCount: Number(outbox.count),
      };
    },
  );
}
