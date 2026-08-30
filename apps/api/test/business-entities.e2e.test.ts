import { fileURLToPath } from "node:url";
import { businessEntityPageSchema } from "@battlefield/contracts";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  migrateDatabase,
  withTenantTransaction,
} from "@battlefield/database";
import { createPgliteDatabase } from "@battlefield/database/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const TENANT_ALPHA = "10000000-0000-4000-8000-000000000001";
const TENANT_BETA = "20000000-0000-4000-8000-000000000001";
const USER_ALPHA = "30000000-0000-4000-8000-000000000001";
const USER_BETA = "30000000-0000-4000-8000-000000000002";
const REQUEST_ID = "90000000-0000-4000-8000-000000000001";
const ENTITY_ALPHA = "50000000-0000-4000-8000-000000000001";
const ENTITY_BETA = "50000000-0000-4000-8000-000000000002";

describe("business entity directory API", () => {
  let app: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedTenantEntity(database, {
      tenantId: TENANT_ALPHA,
      userId: USER_ALPHA,
      typeId: "40000000-0000-4000-8000-000000000001",
      entityId: ENTITY_ALPHA,
      slug: "alpha",
      entityName: "Aurora Systems",
    });
    await seedTenantEntity(database, {
      tenantId: TENANT_BETA,
      userId: USER_BETA,
      typeId: "40000000-0000-4000-8000-000000000002",
      entityId: ENTITY_BETA,
      slug: "beta",
      entityName: "Hidden Tenant Entity",
    });

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
      .set("x-tenant-id", TENANT_ALPHA)
      .set("x-user-id", USER_ALPHA)
      .expect(400);
    await request(app.getHttpServer())
      .get("/api/v1/business-entities?cursor=not*a*cursor")
      .set("x-tenant-id", TENANT_ALPHA)
      .set("x-user-id", USER_ALPHA)
      .expect(400);
  });

  it("returns a contract-conforming tenant-scoped directory", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/business-entities?search=aurora&limit=20")
      .set("x-tenant-id", TENANT_ALPHA)
      .set("x-user-id", USER_ALPHA)
      .expect(200);
    const page = businessEntityPageSchema.parse(response.body);

    expect(page.items.map((item) => item.id)).toEqual([ENTITY_ALPHA]);
    expect(page.items[0]).toMatchObject({
      name: "Aurora Systems",
      primaryOwnerName: "alpha-owner",
      primaryOpportunity: {
        name: "alpha-primary-opportunity",
        stageCode: "proposal",
        stageProgress: "30.00",
      },
    });
    expect(page.items.some((item) => item.id === ENTITY_BETA)).toBe(false);
  });

  it("keeps the development actor adapter disabled in production", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await request(app.getHttpServer())
        .get("/api/v1/business-entities")
        .set("x-tenant-id", TENANT_ALPHA)
        .set("x-user-id", USER_ALPHA)
        .expect(401);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

async function seedTenantEntity(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    tenantId: string;
    userId: string;
    typeId: string;
    entityId: string;
    slug: string;
    entityName: string;
  },
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: input.tenantId,
      userId: input.userId,
      requestId: REQUEST_ID,
    },
    async (transaction) => {
      await sql`
        insert into app.tenants (id, slug, name)
        values (${input.tenantId}::uuid, ${input.slug}, ${input.slug})
      `.execute(transaction);
      await sql`
        insert into app.users (tenant_id, id, display_name)
        values (
          ${input.tenantId}::uuid,
          ${input.userId}::uuid,
          ${`${input.slug}-owner`}
        )
      `.execute(transaction);
      await sql`
        insert into app.business_entity_types (tenant_id, id, code, name)
        values (${input.tenantId}::uuid, ${input.typeId}::uuid, 'customer', '客户')
      `.execute(transaction);
      await sql`
        insert into app.business_entities (
          tenant_id,
          id,
          type_id,
          name,
          is_t0,
          updated_at
        ) values (
          ${input.tenantId}::uuid,
          ${input.entityId}::uuid,
          ${input.typeId}::uuid,
          ${input.entityName},
          true,
          '2026-08-31T03:00:00.000Z'::timestamptz
        )
      `.execute(transaction);
      await sql`
        insert into app.entity_assignments (
          tenant_id,
          id,
          entity_id,
          user_id,
          assignment_role,
          is_primary
        ) values (
          ${input.tenantId}::uuid,
          gen_random_uuid(),
          ${input.entityId}::uuid,
          ${input.userId}::uuid,
          'owner',
          true
        )
      `.execute(transaction);
      await sql`
        insert into app.opportunities (
          tenant_id,
          id,
          entity_id,
          name,
          stage_code,
          stage_progress,
          status,
          is_primary
        ) values (
          ${input.tenantId}::uuid,
          gen_random_uuid(),
          ${input.entityId}::uuid,
          ${`${input.slug}-primary-opportunity`},
          'proposal',
          30,
          'open',
          true
        )
      `.execute(transaction);
    },
  );
}
