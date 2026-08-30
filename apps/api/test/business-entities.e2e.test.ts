import { fileURLToPath } from "node:url";
import { businessEntityPageSchema } from "@battlefield/contracts";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  migrateDatabase,
} from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_OTHER_ENTITY_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "@battlefield/database/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
describe("business entity directory API", () => {
  let app: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(database)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("rejects requests without the development actor", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/business-entities")
      .expect(401);
  });

  it("rejects malformed list filters", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/business-entities?limit=101")
      .set("x-tenant-id", SYNTHETIC_TENANT_ID)
      .set("x-user-id", SYNTHETIC_USER_ID)
      .expect(400);
    await request(app.getHttpServer())
      .get("/api/v1/business-entities?cursor=not*a*cursor")
      .set("x-tenant-id", SYNTHETIC_TENANT_ID)
      .set("x-user-id", SYNTHETIC_USER_ID)
      .expect(400);
  });

  it("returns a contract-conforming tenant-scoped directory", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/business-entities?search=aurora&limit=20")
      .set("x-tenant-id", SYNTHETIC_TENANT_ID)
      .set("x-user-id", SYNTHETIC_USER_ID)
      .expect(200);
    const page = businessEntityPageSchema.parse(response.body);

    expect(page.items.map((item) => item.id)).toEqual([SYNTHETIC_ENTITY_ID]);
    expect(page.items[0]).toMatchObject({
      name: "Aurora Systems",
      primaryOwnerName: "alpha-owner",
      primaryOpportunity: {
        name: "alpha-primary-opportunity",
        stageCode: "proposal",
        stageProgress: "30.00",
      },
    });
    expect(
      page.items.some((item) => item.id === SYNTHETIC_OTHER_ENTITY_ID),
    ).toBe(false);
  });

  it("keeps the development actor adapter disabled in production", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await request(app.getHttpServer())
        .get("/api/v1/business-entities")
        .set("x-tenant-id", SYNTHETIC_TENANT_ID)
        .set("x-user-id", SYNTHETIC_USER_ID)
        .expect(401);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
