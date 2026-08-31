import { z } from "zod";

import { idempotencyKeySchema } from "./followup-draft.js";

export const asyncWorkKindSchema = z.enum([
  "outbox",
  "reminder",
  "notification_delivery",
]);

export const asyncWorkFailureStatusSchema = z.enum(["failed", "dead_lettered"]);

const nullableDateTimeSchema = z.iso.datetime().nullable();

export const workerOperationsHealthSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  worker: z.strictObject({
    workerKey: z.string().trim().min(1).max(100),
    state: z.enum(["healthy", "degraded", "stale", "never_started"]),
    instanceId: z.uuid().nullable(),
    startedAt: nullableDateTimeSchema,
    lastTickStartedAt: nullableDateTimeSchema,
    lastTickCompletedAt: nullableDateTimeSchema,
    lastSuccessAt: nullableDateTimeSchema,
    lastFailureAt: nullableDateTimeSchema,
    lastErrorCode: z.string().trim().min(1).max(100).nullable(),
    lastErrorMessage: z.string().trim().min(1).max(500).nullable(),
  }),
  queues: z
    .array(
      z.strictObject({
        kind: asyncWorkKindSchema,
        readyCount: z.number().int().min(0),
        processingCount: z.number().int().min(0),
        failedCount: z.number().int().min(0),
        deadLetteredCount: z.number().int().min(0),
        oldestReadyAt: nullableDateTimeSchema,
      }),
    )
    .length(3),
});

export const asyncWorkFailureListQuerySchema = z.strictObject({
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  kind: asyncWorkKindSchema.optional(),
  status: asyncWorkFailureStatusSchema.optional(),
});

export const asyncWorkFailureRecordSchema = z.strictObject({
  kind: asyncWorkKindSchema,
  workItemId: z.uuid(),
  category: z.string().trim().min(1).max(200),
  status: asyncWorkFailureStatusSchema,
  attemptCount: z.number().int().min(0),
  lastErrorCode: z.string().trim().min(1).max(100),
  lastErrorMessage: z.string().trim().min(1).max(500),
  availableAt: z.iso.datetime(),
  claimedAt: nullableDateTimeSchema,
  createdAt: z.iso.datetime(),
  relatedResource: z
    .strictObject({
      type: z.string().trim().min(1).max(100),
      id: z.uuid(),
    })
    .nullable(),
});

export const asyncWorkFailurePageSchema = z.strictObject({
  items: z.array(asyncWorkFailureRecordSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const replayAsyncWorkItemRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1_000),
});

export const asyncWorkReplayResponseSchema = z.strictObject({
  replayId: z.uuid(),
  kind: asyncWorkKindSchema,
  workItemId: z.uuid(),
  status: z.literal("queued"),
  replayedAt: z.iso.datetime(),
});

export const workerOperationsApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_WORKER_OPERATIONS_REQUEST",
    "ASYNC_WORK_ITEM_NOT_FOUND",
    "ASYNC_WORK_ITEM_NOT_REPLAYABLE",
    "ASYNC_WORK_REPLAY_CONFLICT",
    "WORKER_OPERATIONS_FORBIDDEN",
    "WORKER_OPERATIONS_UNAVAILABLE",
  ]),
  message: z.string().trim().min(1).max(1_000),
  requestId: z.string().trim().min(1).max(200),
  issues: z
    .array(
      z.strictObject({
        path: z.string().trim().min(1).max(200),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(100)
    .optional(),
});

export type AsyncWorkKind = z.infer<typeof asyncWorkKindSchema>;
export type AsyncWorkFailureStatus = z.infer<
  typeof asyncWorkFailureStatusSchema
>;
export type WorkerOperationsHealth = z.infer<
  typeof workerOperationsHealthSchema
>;
export type AsyncWorkFailureListQuery = z.infer<
  typeof asyncWorkFailureListQuerySchema
>;
export type AsyncWorkFailureRecord = z.infer<
  typeof asyncWorkFailureRecordSchema
>;
export type AsyncWorkFailurePage = z.infer<typeof asyncWorkFailurePageSchema>;
export type ReplayAsyncWorkItemRequest = z.infer<
  typeof replayAsyncWorkItemRequestSchema
>;
export type AsyncWorkReplayResponse = z.infer<
  typeof asyncWorkReplayResponseSchema
>;
export type WorkerOperationsApiError = z.infer<
  typeof workerOperationsApiErrorSchema
>;

export { idempotencyKeySchema as workerOperationsIdempotencyKeySchema };
