import {
  aiRuntimeConfigApiErrorSchema,
  aiRuntimeConfigVersionPageSchema,
  aiRuntimeConfigVersionSchema,
  releasedAiRuntimeConfigSchema,
} from "@battlefield/contracts";
import {
  type AiRuntimeConfigManager,
  AiRuntimeConfigVersionNotFoundError,
} from "@battlefield/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AI_RUNTIME_CONFIG_MANAGER } from "../src/ai-runtime-config/ai-runtime-config.providers.js";
import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const MANAGER_ID = "30000000-0000-4000-8000-000000000072";
const VERSION_ID = "a1000000-0000-4000-8000-000000000001";
const CONFIG_KEY = "followup_extraction";
const VERSION = {
  versionId: VERSION_ID,
  configKey: CONFIG_KEY,
  versionNo: "1",
  name: "销售跟进拆解 V1",
  provider: "senseaudio" as const,
  defaultModelId: "senseaudio-s2-flash",
  systemPrompt: "只提取销售原文明确表达的事实。",
  parameters: { temperature: 0.1, maxTokens: 1200 },
  contentFingerprint: "a".repeat(64),
  createdBy: MANAGER_ID,
  createdAt: "2026-09-01T05:00:00.000Z",
};

describe("AI runtime configuration API", () => {
  let app: INestApplication;
  let unavailableApp: INestApplication;
  const manager: AiRuntimeConfigManager = {
    listVersions: vi.fn().mockResolvedValue({
      items: [VERSION],
      currentVersionId: VERSION_ID,
      nextCursor: null,
    }),
    createVersion: vi.fn().mockResolvedValue(VERSION),
    releaseVersion: vi.fn().mockResolvedValue({
      configId: VERSION_ID,
      configKey: CONFIG_KEY,
      versionNo: "1",
      releaseNo: "1",
      name: VERSION.name,
      provider: VERSION.provider,
      defaultModelId: VERSION.defaultModelId,
      systemPrompt: VERSION.systemPrompt,
      parameters: VERSION.parameters,
      releasedAt: "2026-09-01T05:30:00.000Z",
    }),
  };

  beforeAll(async () => {
    app = await createApp(manager);
    unavailableApp = await createApp();
  });

  afterAll(async () => {
    await unavailableApp.close();
    await app.close();
  });

  test("requires authentication and rejects caller-supplied scope", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/ai-runtime-configs/${CONFIG_KEY}/versions`)
      .expect(401);

    const invalid = await managerRequest(app)
      .get(
        `/api/v1/ai-runtime-configs/${CONFIG_KEY}/versions?tenantId=${TENANT_ID}`,
      )
      .expect(400);
    expect(aiRuntimeConfigApiErrorSchema.parse(invalid.body).code).toBe(
      "INVALID_AI_RUNTIME_CONFIG_REQUEST",
    );
    expect(manager.listVersions).not.toHaveBeenCalled();
  });

  test("lists and creates immutable versions in the authenticated tenant", async () => {
    const pageResponse = await managerRequest(app)
      .get(`/api/v1/ai-runtime-configs/${CONFIG_KEY}/versions?limit=25`)
      .expect(200);
    expect(aiRuntimeConfigVersionPageSchema.parse(pageResponse.body)).toEqual({
      items: [VERSION],
      currentVersionId: VERSION_ID,
      nextCursor: null,
    });
    expect(manager.listVersions).toHaveBeenCalledWith({
      actor: { tenantId: TENANT_ID, userId: MANAGER_ID },
      configKey: CONFIG_KEY,
      limit: 25,
    });

    const createResponse = await managerRequest(app)
      .post(`/api/v1/ai-runtime-configs/${CONFIG_KEY}/versions`)
      .send({
        name: VERSION.name,
        defaultModelId: VERSION.defaultModelId,
        systemPrompt: VERSION.systemPrompt,
        parameters: VERSION.parameters,
      })
      .expect(201);
    expect(aiRuntimeConfigVersionSchema.parse(createResponse.body)).toEqual(
      VERSION,
    );
  });

  test("publishes a selected version with a required audit reason", async () => {
    const response = await managerRequest(app)
      .post(`/api/v1/ai-runtime-configs/${CONFIG_KEY}/releases`)
      .send({ versionId: VERSION_ID, reason: "首次发布" })
      .expect(201);
    expect(releasedAiRuntimeConfigSchema.parse(response.body)).toMatchObject({
      configId: VERSION_ID,
      releaseNo: "1",
    });
    expect(manager.releaseVersion).toHaveBeenCalledWith({
      actor: { tenantId: TENANT_ID, userId: MANAGER_ID },
      configKey: CONFIG_KEY,
      versionId: VERSION_ID,
      reason: "首次发布",
    });

    const invalid = await managerRequest(app)
      .post(`/api/v1/ai-runtime-configs/${CONFIG_KEY}/releases`)
      .send({ versionId: VERSION_ID, reason: "" })
      .expect(400);
    expect(aiRuntimeConfigApiErrorSchema.parse(invalid.body).code).toBe(
      "INVALID_AI_RUNTIME_CONFIG_REQUEST",
    );
  });

  test("maps missing versions and unavailable persistence without leaking details", async () => {
    vi.mocked(manager.releaseVersion).mockRejectedValueOnce(
      new AiRuntimeConfigVersionNotFoundError(),
    );
    const missing = await managerRequest(app)
      .post(`/api/v1/ai-runtime-configs/${CONFIG_KEY}/releases`)
      .send({ versionId: VERSION_ID, reason: "发布" })
      .expect(404);
    expect(aiRuntimeConfigApiErrorSchema.parse(missing.body).code).toBe(
      "AI_RUNTIME_CONFIG_VERSION_NOT_FOUND",
    );

    const unavailable = await managerRequest(unavailableApp)
      .get(`/api/v1/ai-runtime-configs/${CONFIG_KEY}/versions`)
      .expect(503);
    expect(aiRuntimeConfigApiErrorSchema.parse(unavailable.body).code).toBe(
      "AI_RUNTIME_CONFIG_UNAVAILABLE",
    );
  });
});

async function createApp(
  manager?: AiRuntimeConfigManager,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE_HANDLE)
    .useValue(null);
  if (manager) {
    builder.overrideProvider(AI_RUNTIME_CONFIG_MANAGER).useValue(manager);
  }
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
    post: (path: string) =>
      request(application.getHttpServer())
        .post(path)
        .set("x-tenant-id", TENANT_ID)
        .set("x-user-id", MANAGER_ID),
  };
}
