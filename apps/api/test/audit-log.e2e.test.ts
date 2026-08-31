import {
  auditEntryPageSchema,
  auditLogApiErrorSchema,
} from "@battlefield/contracts";
import type { AuditLogReader } from "@battlefield/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { AUDIT_LOG_READER } from "../src/audit-log/audit-log.providers.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const MANAGER_ID = "30000000-0000-4000-8000-000000000072";
const ENTRY_ID = "80000000-0000-4000-8000-000000000001";
const FOLLOWUP_ID = "70000000-0000-4000-8000-000000000001";

describe("audit-log API", () => {
  let app: INestApplication;
  let unavailableApp: INestApplication;
  const list = vi.fn<AuditLogReader["list"]>().mockResolvedValue({
    items: [
      {
        entryId: ENTRY_ID,
        aggregateType: "followup",
        aggregateId: FOLLOWUP_ID,
        action: "confirmed",
        actor: { userId: MANAGER_ID, displayName: "领导A" },
        requestId: "request-1",
        reason: null,
        occurredAt: "2026-09-01T02:00:00.000Z",
      },
    ],
    nextCursor: null,
  });

  beforeAll(async () => {
    app = await createApp({ list });
    unavailableApp = await createApp();
  });

  afterAll(async () => {
    await unavailableApp.close();
    await app.close();
  });

  test("requires authentication and accepts only strict server-scoped filters", async () => {
    await request(app.getHttpServer()).get("/api/v1/audit-entries").expect(401);

    const invalid = await managerRequest(app)
      .get(`/api/v1/audit-entries?tenantId=${TENANT_ID}&scope=tenant`)
      .expect(400);
    expect(auditLogApiErrorSchema.parse(invalid.body).code).toBe(
      "INVALID_AUDIT_LOG_QUERY",
    );
    expect(list).not.toHaveBeenCalled();
  });

  test("returns a metadata-only audit page and preserves actor scope", async () => {
    const response = await managerRequest(app)
      .get(
        `/api/v1/audit-entries?limit=25&aggregateType=followup&aggregateId=${FOLLOWUP_ID}&action=confirmed`,
      )
      .expect(200);
    const page = auditEntryPageSchema.parse(response.body);
    expect(page.items[0]).not.toHaveProperty("afterPayload");
    expect(list).toHaveBeenCalledWith({
      actor: { tenantId: TENANT_ID, userId: MANAGER_ID },
      limit: 25,
      aggregateType: "followup",
      aggregateId: FOLLOWUP_ID,
      action: "confirmed",
    });
  });

  test("fails closed when persistence is unavailable", async () => {
    const response = await managerRequest(unavailableApp)
      .get("/api/v1/audit-entries")
      .expect(503);
    expect(auditLogApiErrorSchema.parse(response.body).code).toBe(
      "AUDIT_LOG_UNAVAILABLE",
    );
  });
});

async function createApp(reader?: AuditLogReader): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE_HANDLE)
    .useValue(null);
  if (reader) builder.overrideProvider(AUDIT_LOG_READER).useValue(reader);
  const moduleReference = await builder.compile();
  const application = moduleReference.createNestApplication();
  configureApp(application);
  await application.init();
  return application;
}

function managerRequest(application: INestApplication) {
  return {
    get: (path: string) =>
      request(application.getHttpServer())
        .get(path)
        .set("x-tenant-id", TENANT_ID)
        .set("x-user-id", MANAGER_ID),
  };
}
