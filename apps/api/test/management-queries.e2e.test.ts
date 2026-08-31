import { fileURLToPath } from "node:url";
import {
  managementQueryApiErrorSchema,
  managementQueryResultSchema,
  managementQuerySubjectPageSchema,
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
const MANAGER_ID = "30000000-0000-4000-8000-000000000092";
const FUTURE_USER_ID = "30000000-0000-4000-8000-000000000093";
const ENDED_USER_ID = "30000000-0000-4000-8000-000000000094";
const UNASSIGNED_USER_ID = "30000000-0000-4000-8000-000000000095";
const REQUEST_ID = "90000000-0000-4000-8000-000000000092";
const PERIOD = {
  capability: "sales_weekly_progress",
  subjectUserId: SYNTHETIC_USER_ID,
  periodStart: "2026-08-25T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
} as const;

describe("controlled management-query API", () => {
  let app: INestApplication;
  let unavailableApp: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticAcceptedAction(database);
    await seedQueryActors(database);
    app = await createApp(database);
    unavailableApp = await createApp(null);
  });

  afterAll(async () => {
    await unavailableApp?.close();
    await app?.close();
  });

  test("requires an authenticated actor and rejects actor, scope and SQL overrides", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/management-query-subjects")
      .expect(401);
    await request(app.getHttpServer())
      .post("/api/v1/management-queries")
      .send(PERIOD)
      .expect(401);

    const queryOverride = await managerRequest(app)
      .get(
        `/api/v1/management-query-subjects?tenantId=${SYNTHETIC_OTHER_TENANT_ID}&scope=tenant`,
      )
      .expect(400);
    expect(managementQueryApiErrorSchema.parse(queryOverride.body).code).toBe(
      "INVALID_MANAGEMENT_QUERY",
    );

    const bodyOverride = await managerRequest(app)
      .post("/api/v1/management-queries")
      .send({
        ...PERIOD,
        tenantId: SYNTHETIC_OTHER_TENANT_ID,
        userId: SYNTHETIC_OTHER_USER_ID,
        scope: "tenant",
        sql: "select * from app.users",
      })
      .expect(400);
    expect(managementQueryApiErrorSchema.parse(bodyOverride.body).code).toBe(
      "INVALID_MANAGEMENT_QUERY",
    );
  });

  test("lists only current self or observed-portfolio subjects", async () => {
    const managerResponse = await managerRequest(app)
      .get("/api/v1/management-query-subjects?limit=20")
      .expect(200);
    expect(
      managementQuerySubjectPageSchema.parse(managerResponse.body),
    ).toEqual({
      items: [
        {
          userId: SYNTHETIC_USER_ID,
          displayName: "alpha-owner",
          scopeKind: "observed_portfolio",
        },
      ],
      nextCursor: null,
    });

    const selfResponse = await actorRequest(app, {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
    })
      .get("/api/v1/management-query-subjects")
      .expect(200);
    expect(
      managementQuerySubjectPageSchema.parse(selfResponse.body).items,
    ).toEqual([
      {
        userId: SYNTHETIC_USER_ID,
        displayName: "alpha-owner",
        scopeKind: "self",
      },
    ]);

    const otherResponse = await actorRequest(app, {
      tenantId: SYNTHETIC_OTHER_TENANT_ID,
      userId: SYNTHETIC_OTHER_USER_ID,
    })
      .get("/api/v1/management-query-subjects")
      .expect(200);
    expect(
      managementQuerySubjectPageSchema.parse(otherResponse.body).items,
    ).toEqual([
      {
        userId: SYNTHETIC_OTHER_USER_ID,
        displayName: "beta-owner",
        scopeKind: "self",
      },
    ]);

    const invalidCursor = await managerRequest(app)
      .get("/api/v1/management-query-subjects?cursor=not-a-cursor")
      .expect(400);
    expect(managementQueryApiErrorSchema.parse(invalidCursor.body).code).toBe(
      "INVALID_MANAGEMENT_QUERY",
    );
  });

  test("returns a strict evidence-backed observer result and supports self scope", async () => {
    const managerResponse = await managerRequest(app)
      .post("/api/v1/management-queries")
      .send(PERIOD)
      .expect(201);
    const managerResult = managementQueryResultSchema.parse(
      managerResponse.body,
    );
    expect(managerResult).toMatchObject({
      capability: "sales_weekly_progress",
      subject: { userId: SYNTHETIC_USER_ID, displayName: "alpha-owner" },
      scope: { kind: "observed_portfolio", entityCount: 1 },
      metrics: {
        confirmedFollowupCount: 0,
        validFactCount: 0,
        stageChangeCount: 0,
        completedActionCount: 0,
        openActionCount: 1,
        overdueActionCount: 0,
      },
      dataGaps: [],
    });
    expect(managerResult.highlights).toHaveLength(1);
    expect(
      managerResult.highlights[0]?.evidence.some(
        (evidence) => evidence.kind === "battle_state",
      ),
    ).toBe(true);

    const selfResponse = await actorRequest(app, {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
    })
      .post("/api/v1/management-queries")
      .send(PERIOD)
      .expect(201);
    expect(
      managementQueryResultSchema.parse(selfResponse.body).scope.kind,
    ).toBe("self");
  });

  test("unifies missing and unauthorized subjects without widening tenant scope", async () => {
    for (const subjectUserId of [
      FUTURE_USER_ID,
      ENDED_USER_ID,
      UNASSIGNED_USER_ID,
    ]) {
      const response = await managerRequest(app)
        .post("/api/v1/management-queries")
        .send({ ...PERIOD, subjectUserId })
        .expect(404);
      expect(managementQueryApiErrorSchema.parse(response.body).code).toBe(
        "MANAGEMENT_QUERY_SUBJECT_NOT_FOUND",
      );
    }

    const foreignResponse = await actorRequest(app, {
      tenantId: SYNTHETIC_OTHER_TENANT_ID,
      userId: SYNTHETIC_OTHER_USER_ID,
    })
      .post("/api/v1/management-queries")
      .send(PERIOD)
      .expect(404);
    expect(managementQueryApiErrorSchema.parse(foreignResponse.body).code).toBe(
      "MANAGEMENT_QUERY_SUBJECT_NOT_FOUND",
    );
  });

  test("rejects invalid periods and fails closed without persistence", async () => {
    const invalidPeriod = await managerRequest(app)
      .post("/api/v1/management-queries")
      .send({ ...PERIOD, periodEnd: PERIOD.periodStart })
      .expect(400);
    expect(managementQueryApiErrorSchema.parse(invalidPeriod.body).code).toBe(
      "INVALID_MANAGEMENT_QUERY",
    );

    const unavailableList = await managerRequest(unavailableApp)
      .get("/api/v1/management-query-subjects")
      .expect(503);
    expect(managementQueryApiErrorSchema.parse(unavailableList.body).code).toBe(
      "MANAGEMENT_QUERY_UNAVAILABLE",
    );
    const unavailableQuery = await managerRequest(unavailableApp)
      .post("/api/v1/management-queries")
      .send(PERIOD)
      .expect(503);
    expect(
      managementQueryApiErrorSchema.parse(unavailableQuery.body).code,
    ).toBe("MANAGEMENT_QUERY_UNAVAILABLE");
  });
});

async function seedQueryActors(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: REQUEST_ID,
    },
    async (transaction) => {
      await transaction
        .insertInto("app.users")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: MANAGER_ID,
            display_name: "管理观察者",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: FUTURE_USER_ID,
            display_name: "未来负责人",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: ENDED_USER_ID,
            display_name: "历史负责人",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: UNASSIGNED_USER_ID,
            display_name: "未分配用户",
          },
        ])
        .execute();
      await transaction
        .insertInto("app.entity_assignments")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            entity_id: "50000000-0000-4000-8000-000000000001",
            user_id: MANAGER_ID,
            assignment_role: "management_observer",
            valid_from: "2026-08-01T00:00:00.000Z",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            entity_id: "50000000-0000-4000-8000-000000000001",
            user_id: FUTURE_USER_ID,
            assignment_role: "collaborator",
            valid_from: "2126-09-02T00:00:00.000Z",
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            entity_id: "50000000-0000-4000-8000-000000000001",
            user_id: ENDED_USER_ID,
            assignment_role: "collaborator",
            valid_from: "2026-08-01T00:00:00.000Z",
            valid_to: "2026-08-30T00:00:00.000Z",
          },
        ])
        .execute();
    },
  );
}

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
  return {
    get: (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set("x-tenant-id", actor.tenantId)
        .set("x-user-id", actor.userId),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set("x-tenant-id", actor.tenantId)
        .set("x-user-id", actor.userId),
  };
}
