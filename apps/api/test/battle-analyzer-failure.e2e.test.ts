import { fileURLToPath } from "node:url";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  migrateDatabase,
  withTenantTransaction,
} from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "@battlefield/database/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AppModule } from "../src/app.module.js";
import { BATTLE_ANALYZER } from "../src/battle-analysis/battle-analysis.providers.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);

describe("battle analyzer failure API", () => {
  let app: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(database)
      .overrideProvider(BATTLE_ANALYZER)
      .useValue({
        async analyze() {
          throw new Error("provider detail that must not cross the API");
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  test("returns a stable sanitized error and records the failed run", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/business-entities/${SYNTHETIC_ENTITY_ID}/analysis-runs`)
      .set("x-tenant-id", SYNTHETIC_TENANT_ID)
      .set("x-user-id", SYNTHETIC_USER_ID)
      .send({})
      .expect(422);

    expect(response.body).toMatchObject({
      code: "INVALID_BATTLE_ANALYSIS",
      message: "Battle analyzer failed to produce a result.",
    });
    expect(JSON.stringify(response.body)).not.toContain("provider detail");
    const run = await withTenantTransaction(
      database.db,
      {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_USER_ID,
        requestId: "90000000-0000-4000-8000-000000000041",
      },
      (transaction) =>
        transaction
          .selectFrom("app.analysis_runs")
          .select(["status", "error_code", "error_message"])
          .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
          .executeTakeFirstOrThrow(),
    );
    expect(run).toEqual({
      status: "failed",
      error_code: "ANALYZER_FAILED",
      error_message: "Analyzer execution failed.",
    });
  });
});
