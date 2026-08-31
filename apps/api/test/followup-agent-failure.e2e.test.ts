import { fileURLToPath } from "node:url";
import { followupApiErrorSchema } from "@battlefield/contracts";
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
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { FOLLOWUP_DRAFT_AGENT } from "../src/followup-drafts/followup-draft.providers.js";
import { SenseAudioFollowupDraftAgentError } from "../src/followup-drafts/senseaudio-followup-draft-agent.js";
import { configureApp } from "../src/main.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);

describe("follow-up Agent failure API", () => {
  let app: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(database)
      .overrideProvider(FOLLOWUP_DRAFT_AGENT)
      .useValue({
        async propose() {
          throw new SenseAudioFollowupDraftAgentError(
            "upstream_error",
            "provider detail that must not cross the API",
          );
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

  test("returns safe retry guidance and writes no draft before human review", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/followup-drafts")
      .set("x-tenant-id", SYNTHETIC_TENANT_ID)
      .set("x-user-id", SYNTHETIC_USER_ID)
      .send({
        entityId: SYNTHETIC_ENTITY_ID,
        rawInput: "客户确认预算，下周提交方案。",
      })
      .expect(503);

    expect(followupApiErrorSchema.parse(response.body)).toMatchObject({
      code: "AGENT_UNAVAILABLE",
      message: "AI 拆解服务暂时不可用，请稍后重试。你的输入尚未入库。",
    });
    expect(JSON.stringify(response.body)).not.toContain("provider detail");

    const draftCount = await withTenantTransaction(
      database.db,
      {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_USER_ID,
        requestId: "90000000-0000-4000-8000-000000000081",
      },
      async (transaction) => {
        const row = await transaction
          .selectFrom("app.followup_drafts")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow();
        return Number(row.count);
      },
    );
    expect(draftCount).toBe(0);
  });
});
