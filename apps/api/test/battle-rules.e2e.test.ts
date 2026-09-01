import "reflect-metadata";

import { fileURLToPath } from "node:url";
import {
  battleRuleApiErrorSchema,
  battleRuleVersionPageSchema,
  battleRuleVersionSchema,
  releasedBattleRuleSchema,
} from "@battlefield/contracts";
import { defaultBattleRuleSet } from "@battlefield/core";
import type { BattlefieldDatabase } from "@battlefield/database";
import { migrateDatabase } from "@battlefield/database";
import {
  createPgliteDatabase,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticManagementObserver,
  seedSyntheticTwoLevelIdentity,
} from "@battlefield/database/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);

describe("battle rule management API", () => {
  let app: INestApplication;
  let database: Awaited<
    ReturnType<typeof createPgliteDatabase<BattlefieldDatabase>>
  >;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    await seedSyntheticTwoLevelIdentity(database);
    const moduleReference = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(database)
      .compile();
    app = moduleReference.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await database.close();
  });

  test("uses the dedicated capability and exposes the current immutable release", async () => {
    const sales = request.agent(app.getHttpServer());
    await login(sales, "sales1@demo.local");
    const denied = await sales.get("/api/v1/battle-rules/versions").expect(403);
    expect(battleRuleApiErrorSchema.parse(denied.body).code).toBe(
      "CAPABILITY_FORBIDDEN",
    );

    const leader = request.agent(app.getHttpServer());
    await login(leader, "leader.a@demo.local");
    const response = await leader
      .get("/api/v1/battle-rules/versions?limit=20")
      .expect(200);
    expect(battleRuleVersionPageSchema.parse(response.body)).toMatchObject({
      currentReleaseNo: "1",
      items: [{ versionNo: "1", rules: defaultBattleRuleSet }],
    });
  });

  test("creates a draft version and publishes it with an explicit reason", async () => {
    const leader = request.agent(app.getHttpServer());
    await login(leader, "leader.a@demo.local");
    const created = await leader
      .post("/api/v1/battle-rules/versions")
      .send({
        name: "重点客户加速规则",
        rules: {
          ...defaultBattleRuleSet,
          potentialScore: { base: 75, perFact: 6, maximum: 98 },
        },
      })
      .expect(201);
    const version = battleRuleVersionSchema.parse(created.body);
    expect(version.versionNo).toBe("2");

    const released = await leader
      .post("/api/v1/battle-rules/releases")
      .send({ versionId: version.versionId, reason: "演示加速规则已验收" })
      .expect(201);
    expect(releasedBattleRuleSchema.parse(released.body)).toMatchObject({
      versionNo: "2",
      releaseNo: "2",
      ruleVersion: "battle-rules-v2-r2",
    });

    await leader
      .post("/api/v1/battle-rules/versions")
      .send({
        name: "非法规则",
        rules: { ...defaultBattleRuleSet, script: "x" },
      })
      .expect(400);
  });
});

async function login(agent: ReturnType<typeof request.agent>, email: string) {
  await agent
    .post("/api/v1/auth/login")
    .send({ tenantSlug: "alpha", email, password: "Demo@2026" })
    .expect(201);
}
