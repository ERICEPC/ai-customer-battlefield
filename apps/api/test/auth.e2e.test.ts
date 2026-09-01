import "reflect-metadata";

import { fileURLToPath } from "node:url";
import { hashPassword } from "@battlefield/core";
import type { BattlefieldDatabase } from "@battlefield/database";
import { migrateDatabase, withTenantTransaction } from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_MANAGER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
} from "@battlefield/database/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const DEPARTMENT_ID = "31000000-0000-4000-8000-000000000001";
const REQUEST_ID = "90000000-0000-4000-8000-000000000082";

describe("authentication API", () => {
  let app: INestApplication;
  let database: Awaited<
    ReturnType<typeof createPgliteDatabase<BattlefieldDatabase>>
  >;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedIdentity();
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
  });

  it("logs Sales 1 in with its direct department relationship", async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post("/api/v1/auth/login")
      .send({
        tenantSlug: "alpha",
        email: "sales1@demo.local",
        password: "Demo@2026",
      })
      .expect(201);

    expect(login.headers["set-cookie"]?.[0]).toContain("battlefield_session=");
    expect(login.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");
    expect(login.body.session).toMatchObject({
      user: { displayName: "销售1", email: "sales1@demo.local" },
      role: "sales",
      capabilities: [],
      department: { name: "商业化一部" },
      directLeader: { displayName: "领导A" },
      teamMembers: [],
    });

    const session = await agent.get("/api/v1/auth/session").expect(200);
    expect(session.body).toEqual(login.body.session);
  });

  it("logs Leader A in with the current department sales roster", async () => {
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({
        tenantSlug: "alpha",
        email: "leader.a@demo.local",
        password: "Demo@2026",
      })
      .expect(201);

    expect(login.body.session).toMatchObject({
      user: { displayName: "领导A" },
      role: "department_leader",
      capabilities: [
        "access_control.manage",
        "ai_runtime_config.manage",
        "audit.read",
        "business_rules.manage",
        "management_query.execute",
        "worker_operations.manage",
      ],
      department: { name: "商业化一部" },
      directLeader: null,
      teamMembers: [{ displayName: "销售1" }],
    });
  });

  it("reserves management and audit endpoints for granted capabilities", async () => {
    const sales = request.agent(app.getHttpServer());
    await sales.post("/api/v1/auth/login").send({
      tenantSlug: "alpha",
      email: "sales1@demo.local",
      password: "Demo@2026",
    });
    await sales
      .get("/api/v1/management-query-subjects")
      .expect(403)
      .expect(({ body }) => {
        expect(body.code).toBe("CAPABILITY_FORBIDDEN");
      });
    await sales.get("/api/v1/audit-entries").expect(403);
    await sales
      .get("/api/v1/ai-runtime-configs/followup_extraction/versions")
      .expect(403);
    await sales.get("/api/v1/worker-operations/health").expect(403);

    const leader = request.agent(app.getHttpServer());
    await leader.post("/api/v1/auth/login").send({
      tenantSlug: "alpha",
      email: "leader.a@demo.local",
      password: "Demo@2026",
    });
    await leader.get("/api/v1/management-query-subjects").expect(200);
    await leader.get("/api/v1/audit-entries").expect(200);
    await leader
      .get("/api/v1/ai-runtime-configs/followup_extraction/versions")
      .expect(200);
    await leader.get("/api/v1/worker-operations/health").expect(200);
  });

  it("revokes one capability for the next request without changing the role", async () => {
    const leader = request.agent(app.getHttpServer());
    await leader.post("/api/v1/auth/login").send({
      tenantSlug: "alpha",
      email: "leader.a@demo.local",
      password: "Demo@2026",
    });
    await leader.get("/api/v1/worker-operations/health").expect(200);

    await withTenantTransaction(
      database.db,
      {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_MANAGER_USER_ID,
        requestId: REQUEST_ID,
      },
      (transaction) =>
        transaction
          .deleteFrom("app.role_capability_grants")
          .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
          .where("role_code", "=", "department_leader")
          .where("capability_code", "=", "worker_operations.manage")
          .executeTakeFirstOrThrow(),
    );

    const session = await leader.get("/api/v1/auth/session").expect(200);
    expect(session.body.role).toBe("department_leader");
    expect(session.body.capabilities).not.toContain("worker_operations.manage");
    await leader
      .get("/api/v1/worker-operations/health")
      .expect(403)
      .expect(({ body }) => {
        expect(body.code).toBe("CAPABILITY_FORBIDDEN");
      });
    await leader
      .get("/api/v1/ai-runtime-configs/followup_extraction/versions")
      .expect(200);
  });

  it("does not let caller-supplied actor headers override the session", async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post("/api/v1/auth/login").send({
      tenantSlug: "alpha",
      email: "sales1@demo.local",
      password: "Demo@2026",
    });

    const session = await agent
      .get("/api/v1/auth/session")
      .set("x-tenant-id", SYNTHETIC_TENANT_ID)
      .set("x-user-id", SYNTHETIC_MANAGER_USER_ID)
      .expect(200);

    expect(session.body.user.id).toBe(SYNTHETIC_USER_ID);
    expect(session.body.role).toBe("sales");
  });

  it("revokes the session on logout and keeps credential errors generic", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({
        tenantSlug: "alpha",
        email: "missing@demo.local",
        password: "Wrong@2026",
      })
      .expect(401)
      .expect(({ body }) => {
        expect(body.code).toBe("INVALID_CREDENTIALS");
      });

    const agent = request.agent(app.getHttpServer());
    await agent.post("/api/v1/auth/login").send({
      tenantSlug: "alpha",
      email: "sales1@demo.local",
      password: "Demo@2026",
    });
    const logout = await agent.post("/api/v1/auth/logout").expect(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain(
      "battlefield_session=;",
    );
    await agent.get("/api/v1/auth/session").expect(401);
  });

  it("rejects protected requests without a browser session", async () => {
    await request(app.getHttpServer()).get("/api/v1/auth/session").expect(401);
    await request(app.getHttpServer()).get("/api/v1/workspace").expect(401);
  });

  async function seedIdentity(): Promise<void> {
    const passwordHash = await hashPassword("Demo@2026", {
      salt: Buffer.alloc(16, 9),
    });
    await withTenantTransaction(
      database.db,
      {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_USER_ID,
        requestId: REQUEST_ID,
      },
      async (transaction) => {
        await transaction
          .insertInto("app.tenants")
          .values({ id: SYNTHETIC_TENANT_ID, slug: "alpha", name: "Alpha" })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.org_units")
          .values({
            tenant_id: SYNTHETIC_TENANT_ID,
            id: DEPARTMENT_ID,
            parent_id: null,
            code: "commercial-one",
            name: "商业化一部",
            unit_type: "department",
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.users")
          .values([
            {
              tenant_id: SYNTHETIC_TENANT_ID,
              id: SYNTHETIC_USER_ID,
              display_name: "销售1",
              email: "sales1@demo.local",
              mobile: null,
            },
            {
              tenant_id: SYNTHETIC_TENANT_ID,
              id: SYNTHETIC_MANAGER_USER_ID,
              display_name: "领导A",
              email: "leader.a@demo.local",
              mobile: null,
            },
          ])
          .execute();
        await transaction
          .insertInto("app.user_memberships")
          .values([
            {
              tenant_id: SYNTHETIC_TENANT_ID,
              id: "32000000-0000-4000-8000-000000000001",
              user_id: SYNTHETIC_USER_ID,
              org_unit_id: DEPARTMENT_ID,
              role_code: "sales",
              valid_from: "2026-01-01T00:00:00.000Z",
              valid_to: null,
            },
            {
              tenant_id: SYNTHETIC_TENANT_ID,
              id: "32000000-0000-4000-8000-000000000002",
              user_id: SYNTHETIC_MANAGER_USER_ID,
              org_unit_id: DEPARTMENT_ID,
              role_code: "department_leader",
              valid_from: "2026-01-01T00:00:00.000Z",
              valid_to: null,
            },
          ])
          .execute();
        await transaction
          .insertInto("app.user_credentials")
          .values([
            {
              tenant_id: SYNTHETIC_TENANT_ID,
              user_id: SYNTHETIC_USER_ID,
              password_hash: passwordHash,
            },
            {
              tenant_id: SYNTHETIC_TENANT_ID,
              user_id: SYNTHETIC_MANAGER_USER_ID,
              password_hash: passwordHash,
            },
          ])
          .execute();
      },
    );
  }
});
