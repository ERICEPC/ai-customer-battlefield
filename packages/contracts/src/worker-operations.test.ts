import { describe, expect, test } from "vitest";

import {
  asyncWorkFailureListQuerySchema,
  replayAsyncWorkItemRequestSchema,
  workerOperationsHealthSchema,
} from "./worker-operations.js";

describe("worker operations contracts", () => {
  test("accepts a bounded tenant worker-health snapshot", () => {
    expect(
      workerOperationsHealthSchema.parse({
        observedAt: "2026-09-01T06:00:00.000Z",
        worker: {
          workerKey: "reminder_worker",
          state: "healthy",
          instanceId: "d1000000-0000-4000-8000-000000000001",
          startedAt: "2026-09-01T05:00:00.000Z",
          lastTickStartedAt: "2026-09-01T05:59:58.000Z",
          lastTickCompletedAt: "2026-09-01T05:59:59.000Z",
          lastSuccessAt: "2026-09-01T05:59:59.000Z",
          lastFailureAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
        queues: [
          {
            kind: "outbox",
            readyCount: 1,
            processingCount: 0,
            failedCount: 0,
            deadLetteredCount: 0,
            oldestReadyAt: "2026-09-01T05:59:00.000Z",
          },
          {
            kind: "reminder",
            readyCount: 0,
            processingCount: 0,
            failedCount: 0,
            deadLetteredCount: 0,
            oldestReadyAt: null,
          },
          {
            kind: "notification_delivery",
            readyCount: 0,
            processingCount: 0,
            failedCount: 0,
            deadLetteredCount: 0,
            oldestReadyAt: null,
          },
        ],
      }).worker.state,
    ).toBe("healthy");
  });

  test("rejects caller-supplied tenant scope and invalid list filters", () => {
    expect(
      asyncWorkFailureListQuerySchema.safeParse({
        tenantId: "10000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    expect(
      asyncWorkFailureListQuerySchema.safeParse({ limit: 101 }).success,
    ).toBe(false);
  });

  test("requires an idempotency key and explicit reason for manual replay", () => {
    expect(
      replayAsyncWorkItemRequestSchema.safeParse({ reason: "" }).success,
    ).toBe(false);
    expect(
      replayAsyncWorkItemRequestSchema.parse({
        reason: "处理器已修复，重新执行",
      }),
    ).toEqual({ reason: "处理器已修复，重新执行" });
  });
});
