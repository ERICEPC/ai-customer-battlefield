import { fileURLToPath } from "node:url";
import {
  workspaceApiErrorSchema,
  workspaceSnapshotSchema,
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
const UNASSIGNED_ENTITY_ID = "50000000-0000-4000-8000-000000000099";

describe("role-scoped workspace API", () => {
  let app: INestApplication;
  let unavailableApp: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await withTenantTransaction(
      database.db,
      {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_USER_ID,
        requestId: "90000000-0000-4000-8000-000000000099",
      },
      async (transaction) => {
        await transaction
          .insertInto("app.business_entities")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: UNASSIGNED_ENTITY_ID,
            type_id: "40000000-0000-4000-8000-000000000001",
            name: "Same-tenant unassigned entity",
            is_t0: true,
            metadata: JSON.stringify({}),
          })
          .executeTakeFirstOrThrow();
      },
    );

    app = await createApp(database);
    unavailableApp = await createApp(null);
  });

  afterAll(async () => {
    await unavailableApp?.close();
    await app?.close();
  });

  test("requires an authenticated development actor", async () => {
    await request(app.getHttpServer()).get("/api/v1/workspace").expect(401);
  });

  test("rejects every client attempt to override actor or scope", async () => {
    const response = await actorRequest(app)
      .get(
        `/api/v1/workspace?tenantId=${SYNTHETIC_OTHER_TENANT_ID}&userId=${SYNTHETIC_OTHER_USER_ID}&scope=tenant`,
      )
      .expect(400);

    expect(workspaceApiErrorSchema.parse(response.body).code).toBe(
      "INVALID_WORKSPACE_QUERY",
    );
  });

  test("returns a strict snapshot limited to active assignments", async () => {
    const response = await actorRequest(app)
      .get("/api/v1/workspace")
      .expect(200);
    const snapshot = workspaceSnapshotSchema.parse(response.body);

    expect(snapshot).toMatchObject({
      scopeMode: "personal",
      kpis: {
        assignedEntityCount: 1,
        pendingDraftCount: 0,
        pendingProposalCount: 0,
        overdueActionCount: 0,
        unreadNotificationCount: 0,
        highRiskEntityCount: 0,
        dataIncompleteEntityCount: 1,
      },
      priorityActions: [],
      recentBattleChanges: [],
      quadrantDistribution: [{ quadrantCode: null, count: 1 }],
    });
  });

  test("keeps foreign-tenant rows out of counts and production headers disabled", async () => {
    const otherResponse = await request(app.getHttpServer())
      .get("/api/v1/workspace")
      .set("x-tenant-id", SYNTHETIC_OTHER_TENANT_ID)
      .set("x-user-id", SYNTHETIC_OTHER_USER_ID)
      .expect(200);
    expect(
      workspaceSnapshotSchema.parse(otherResponse.body).kpis
        .assignedEntityCount,
    ).toBe(1);

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await actorRequest(app).get("/api/v1/workspace").expect(401);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("fails closed when workspace persistence is unavailable", async () => {
    const response = await actorRequest(unavailableApp)
      .get("/api/v1/workspace")
      .expect(503);
    expect(workspaceApiErrorSchema.parse(response.body).code).toBe(
      "WORKSPACE_UNAVAILABLE",
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
  };
}
