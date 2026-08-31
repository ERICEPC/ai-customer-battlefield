import "reflect-metadata";

import { fileURLToPath } from "node:url";
import {
  accessControlApiErrorSchema,
  accessControlSnapshotSchema,
  roleCapabilityUpdateSchema,
} from "@battlefield/contracts";
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

describe("access-control API", () => {
  let app: INestApplication;
  let unavailableApp: INestApplication;
  let database: Awaited<
    ReturnType<typeof createPgliteDatabase<BattlefieldDatabase>>
  >;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    await seedSyntheticTwoLevelIdentity(database);
    app = await createApp(database);
    unavailableApp = await createApp(null);
  });

  afterEach(async () => {
    await unavailableApp.close();
    await app.close();
    await database.close();
  });

  test("requires access-control capability and returns the current projection", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/access-control/role-capabilities")
      .expect(401);

    const sales = request.agent(app.getHttpServer());
    await login(sales, "sales1@demo.local");
    const denied = await sales
      .get("/api/v1/access-control/role-capabilities")
      .expect(403);
    expect(accessControlApiErrorSchema.parse(denied.body).code).toBe(
      "CAPABILITY_FORBIDDEN",
    );

    const leader = request.agent(app.getHttpServer());
    await login(leader, "leader.a@demo.local");
    const response = await leader
      .get("/api/v1/access-control/role-capabilities")
      .expect(200);
    const snapshot = accessControlSnapshotSchema.parse(response.body);
    expect(snapshot.roles).toEqual([
      expect.objectContaining({
        roleCode: "department_leader",
        activeUserCount: 1,
      }),
      expect.objectContaining({ roleCode: "sales", activeUserCount: 1 }),
    ]);
  });

  test("updates a role and refreshes an existing session on the next request", async () => {
    const sales = request.agent(app.getHttpServer());
    const leader = request.agent(app.getHttpServer());
    await login(sales, "sales1@demo.local");
    await login(leader, "leader.a@demo.local");

    const response = await leader
      .put("/api/v1/access-control/roles/sales/capabilities")
      .set("idempotency-key", "api-grant-sales-audit-1")
      .send({
        capabilities: ["audit.read"],
        reason: "销售骨干负责自查操作日志",
      })
      .expect(200);
    expect(roleCapabilityUpdateSchema.parse(response.body)).toMatchObject({
      roleCode: "sales",
      capabilities: ["audit.read"],
      changed: true,
    });

    const session = await sales.get("/api/v1/auth/session").expect(200);
    expect(session.body.capabilities).toEqual(["audit.read"]);
    await sales.get("/api/v1/audit-entries").expect(200);
    await sales.get("/api/v1/access-control/role-capabilities").expect(403);
  });

  test("rejects invalid requests, idempotency reuse, and tenant lockout", async () => {
    const leader = request.agent(app.getHttpServer());
    await login(leader, "leader.a@demo.local");

    await leader
      .put("/api/v1/access-control/roles/sales/capabilities")
      .send({ capabilities: ["audit.read"], reason: "missing key" })
      .expect(400);
    await leader
      .put("/api/v1/access-control/roles/sales/capabilities")
      .set("idempotency-key", "api-invalid-1")
      .send({
        capabilities: ["audit.read"],
        reason: "invalid scope",
        tenantId: "10000000-0000-4000-8000-000000000001",
      })
      .expect(400);

    await leader
      .put("/api/v1/access-control/roles/sales/capabilities")
      .set("idempotency-key", "api-grant-sales-1")
      .send({ capabilities: ["audit.read"], reason: "first request" })
      .expect(200);
    const conflict = await leader
      .put("/api/v1/access-control/roles/sales/capabilities")
      .set("idempotency-key", "api-grant-sales-1")
      .send({
        capabilities: ["worker_operations.manage"],
        reason: "different request",
      })
      .expect(409);
    expect(accessControlApiErrorSchema.parse(conflict.body).code).toBe(
      "ACCESS_CONTROL_IDEMPOTENCY_CONFLICT",
    );

    const lockout = await leader
      .put("/api/v1/access-control/roles/department_leader/capabilities")
      .set("idempotency-key", "api-lockout-1")
      .send({ capabilities: ["audit.read"], reason: "remove controller" })
      .expect(409);
    expect(accessControlApiErrorSchema.parse(lockout.body).code).toBe(
      "ACCESS_CONTROL_LOCKOUT",
    );
  });

  test("fails closed when persistence is unavailable", async () => {
    const response = await request(unavailableApp.getHttpServer())
      .get("/api/v1/access-control/role-capabilities")
      .set("x-tenant-id", "10000000-0000-4000-8000-000000000001")
      .set("x-user-id", "30000000-0000-4000-8000-000000000072")
      .expect(503);
    expect(accessControlApiErrorSchema.parse(response.body).code).toBe(
      "ACCESS_CONTROL_UNAVAILABLE",
    );
  });
});

async function createApp(
  database: Awaited<
    ReturnType<typeof createPgliteDatabase<BattlefieldDatabase>>
  > | null,
): Promise<INestApplication> {
  const moduleReference = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DATABASE_HANDLE)
    .useValue(database)
    .compile();
  const application = moduleReference.createNestApplication();
  configureApp(application);
  await application.init();
  return application;
}

async function login(
  agent: ReturnType<typeof request.agent>,
  email: string,
): Promise<void> {
  await agent.post("/api/v1/auth/login").send({
    tenantSlug: "alpha",
    email,
    password: "Demo@2026",
  });
}
