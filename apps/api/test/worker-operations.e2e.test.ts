import {
  asyncWorkFailurePageSchema,
  asyncWorkReplayResponseSchema,
  workerOperationsApiErrorSchema,
  workerOperationsHealthSchema,
} from "@battlefield/contracts";
import {
  AsyncWorkItemNotReplayableError,
  type WorkerOperationsRepository,
} from "@battlefield/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";
import { WORKER_OPERATIONS_REPOSITORY } from "../src/worker-operations/worker-operations.providers.js";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const MANAGER_ID = "30000000-0000-4000-8000-000000000072";
const WORK_ITEM_ID = "d1000000-0000-4000-8000-000000000001";
const REPLAY_ID = "d5000000-0000-4000-8000-000000000001";

describe("worker operations API", () => {
  let app: INestApplication;
  let unavailableApp: INestApplication;
  const repository: WorkerOperationsRepository = {
    getHealth: vi.fn().mockResolvedValue({
      observedAt: "2026-09-01T06:00:00.000Z",
      worker: {
        workerKey: "reminder_worker",
        state: "healthy",
        instanceId: "d3000000-0000-4000-8000-000000000001",
        startedAt: "2026-09-01T05:00:00.000Z",
        lastTickStartedAt: "2026-09-01T05:59:58.000Z",
        lastTickCompletedAt: "2026-09-01T05:59:59.000Z",
        lastSuccessAt: "2026-09-01T05:59:59.000Z",
        lastFailureAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      queues: [
        queue("outbox", 1),
        queue("reminder", 0),
        queue("notification_delivery", 0),
      ],
    }),
    listFailures: vi.fn().mockResolvedValue({
      items: [
        {
          kind: "outbox",
          workItemId: WORK_ITEM_ID,
          category: "synthetic.unknown.v1",
          status: "dead_lettered",
          attemptCount: 8,
          lastErrorCode: "UNKNOWN_OUTBOX_TOPIC",
          lastErrorMessage: "No handler is registered for this topic.",
          availableAt: "2026-09-01T05:00:00.000Z",
          claimedAt: null,
          createdAt: "2026-09-01T05:00:00.000Z",
          relatedResource: {
            type: "business_entity",
            id: "50000000-0000-4000-8000-000000000001",
          },
        },
      ],
      nextCursor: null,
    }),
    replay: vi.fn().mockResolvedValue({
      replayId: REPLAY_ID,
      kind: "outbox",
      workItemId: WORK_ITEM_ID,
      status: "queued",
      replayedAt: "2026-09-01T06:01:00.000Z",
    }),
  };

  beforeAll(async () => {
    app = await createApp(repository);
    unavailableApp = await createApp();
  });

  afterAll(async () => {
    await unavailableApp.close();
    await app.close();
  });

  test("requires authentication and rejects caller-supplied tenant scope", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/worker-operations/health")
      .expect(401);
    const invalid = await managerRequest(app)
      .get(`/api/v1/worker-operations/failures?tenantId=${TENANT_ID}`)
      .expect(400);
    expect(workerOperationsApiErrorSchema.parse(invalid.body).code).toBe(
      "INVALID_WORKER_OPERATIONS_REQUEST",
    );
  });

  test("returns heartbeat health and metadata-only failures", async () => {
    const health = await managerRequest(app)
      .get("/api/v1/worker-operations/health")
      .expect(200);
    expect(workerOperationsHealthSchema.parse(health.body).worker.state).toBe(
      "healthy",
    );

    const failures = await managerRequest(app)
      .get(
        "/api/v1/worker-operations/failures?kind=outbox&status=dead_lettered&limit=20",
      )
      .expect(200);
    const page = asyncWorkFailurePageSchema.parse(failures.body);
    expect(page.items[0]).not.toHaveProperty("payload");
    expect(repository.listFailures).toHaveBeenCalledWith({
      actor: { tenantId: TENANT_ID, userId: MANAGER_ID },
      kind: "outbox",
      status: "dead_lettered",
      limit: 20,
    });
  });

  test("requires idempotency and reason before replaying a failed item", async () => {
    await managerRequest(app)
      .post(`/api/v1/worker-operations/outbox/${WORK_ITEM_ID}/replay`)
      .send({ reason: "处理器已修复" })
      .expect(400);

    const response = await managerRequest(app)
      .post(`/api/v1/worker-operations/outbox/${WORK_ITEM_ID}/replay`)
      .set("idempotency-key", "worker-replay-1")
      .send({ reason: "处理器已修复" })
      .expect(201);
    expect(asyncWorkReplayResponseSchema.parse(response.body)).toMatchObject({
      replayId: REPLAY_ID,
      status: "queued",
    });
  });

  test("maps non-replayable and unavailable states to stable errors", async () => {
    vi.mocked(repository.replay).mockRejectedValueOnce(
      new AsyncWorkItemNotReplayableError(),
    );
    const conflict = await managerRequest(app)
      .post(`/api/v1/worker-operations/outbox/${WORK_ITEM_ID}/replay`)
      .set("idempotency-key", "worker-replay-2")
      .send({ reason: "再次重放" })
      .expect(409);
    expect(workerOperationsApiErrorSchema.parse(conflict.body).code).toBe(
      "ASYNC_WORK_ITEM_NOT_REPLAYABLE",
    );

    const unavailable = await managerRequest(unavailableApp)
      .get("/api/v1/worker-operations/health")
      .expect(503);
    expect(workerOperationsApiErrorSchema.parse(unavailable.body).code).toBe(
      "WORKER_OPERATIONS_UNAVAILABLE",
    );
  });
});

async function createApp(
  repository?: WorkerOperationsRepository,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE_HANDLE)
    .useValue(null);
  if (repository) {
    builder.overrideProvider(WORKER_OPERATIONS_REPOSITORY).useValue(repository);
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

function queue(
  kind: "outbox" | "reminder" | "notification_delivery",
  deadLetteredCount: number,
) {
  return {
    kind,
    readyCount: 0,
    processingCount: 0,
    failedCount: 0,
    deadLetteredCount,
    oldestReadyAt: null,
  };
}
