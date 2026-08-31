import { randomUUID } from "node:crypto";
import {
  type AsyncWorkFailurePage,
  type AsyncWorkReplayResponse,
  asyncWorkFailureListQuerySchema,
  asyncWorkFailurePageSchema,
  asyncWorkKindSchema,
  asyncWorkReplayResponseSchema,
  replayAsyncWorkItemRequestSchema,
  type WorkerOperationsHealth,
  workerOperationsHealthSchema,
  workerOperationsIdempotencyKeySchema,
} from "@battlefield/contracts";
import {
  AsyncWorkItemNotFoundError,
  AsyncWorkItemNotReplayableError,
  AsyncWorkReplayConflictError,
  type GetWorkerOperationsHealth,
  InvalidAsyncWorkCursorError,
  InvalidAsyncWorkListInputError,
  InvalidAsyncWorkReplayInputError,
  type ListAsyncWorkFailures,
  type ReplayAsyncWorkItem,
  WorkerOperationsAccessDeniedError,
} from "@battlefield/core";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";

import { RequireRoles } from "../auth/auth.constants.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  GET_WORKER_OPERATIONS_HEALTH,
  LIST_ASYNC_WORK_FAILURES,
  REPLAY_ASYNC_WORK_ITEM,
  WorkerOperationsUnavailableError,
} from "./worker-operations.providers.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@RequireRoles("department_leader")
@Controller("worker-operations")
export class WorkerOperationsController {
  constructor(
    @Inject(GET_WORKER_OPERATIONS_HEALTH)
    private readonly getHealth: GetWorkerOperationsHealth,
    @Inject(LIST_ASYNC_WORK_FAILURES)
    private readonly listFailures: ListAsyncWorkFailures,
    @Inject(REPLAY_ASYNC_WORK_ITEM)
    private readonly replayItem: ReplayAsyncWorkItem,
  ) {}

  @Get("health")
  async health(
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<WorkerOperationsHealth> {
    try {
      return workerOperationsHealthSchema.parse(
        await this.getHealth.execute({
          actor: developmentActor(tenantId, userId),
        }),
      );
    } catch (error) {
      return mapWorkerOperationsError(error);
    }
  }

  @Get("failures")
  async failures(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<AsyncWorkFailurePage> {
    const parsed = asyncWorkFailureListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidRequest(
        "Worker 失败列表查询参数无效。",
        parsed.error.issues,
      );
    }
    try {
      return asyncWorkFailurePageSchema.parse(
        await this.listFailures.execute({
          actor: developmentActor(tenantId, userId),
          limit: parsed.data.limit ?? 50,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
          ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
        }),
      );
    } catch (error) {
      return mapWorkerOperationsError(error);
    }
  }

  @Post(":kind/:workItemId/replay")
  async replay(
    @Param("kind") rawKind: string,
    @Param("workItemId") workItemId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<AsyncWorkReplayResponse> {
    const parsedKind = asyncWorkKindSchema.safeParse(rawKind);
    const parsedBody = replayAsyncWorkItemRequestSchema.safeParse(body);
    const parsedKey =
      workerOperationsIdempotencyKeySchema.safeParse(rawIdempotencyKey);
    if (
      !parsedKind.success ||
      !parsedBody.success ||
      !parsedKey.success ||
      !UUID_PATTERN.test(workItemId)
    ) {
      throw invalidRequest("Worker 失败任务重放请求无效。");
    }
    try {
      return asyncWorkReplayResponseSchema.parse(
        await this.replayItem.execute({
          actor: developmentActor(tenantId, userId),
          kind: parsedKind.data,
          workItemId,
          reason: parsedBody.data.reason,
          idempotencyKey: parsedKey.data,
        }),
      );
    } catch (error) {
      return mapWorkerOperationsError(error);
    }
  }
}

function mapWorkerOperationsError(error: unknown): never {
  if (
    error instanceof InvalidAsyncWorkListInputError ||
    error instanceof InvalidAsyncWorkCursorError ||
    error instanceof InvalidAsyncWorkReplayInputError
  ) {
    throw invalidRequest(error.message);
  }
  if (error instanceof AsyncWorkItemNotFoundError) {
    throw new NotFoundException(
      payload("ASYNC_WORK_ITEM_NOT_FOUND", error.message),
    );
  }
  if (error instanceof AsyncWorkItemNotReplayableError) {
    throw new ConflictException(
      payload("ASYNC_WORK_ITEM_NOT_REPLAYABLE", error.message),
    );
  }
  if (error instanceof AsyncWorkReplayConflictError) {
    throw new ConflictException(
      payload("ASYNC_WORK_REPLAY_CONFLICT", error.message),
    );
  }
  if (error instanceof WorkerOperationsAccessDeniedError) {
    throw new ForbiddenException(
      payload("WORKER_OPERATIONS_FORBIDDEN", error.message),
    );
  }
  if (error instanceof WorkerOperationsUnavailableError) {
    throw new ServiceUnavailableException(
      payload("WORKER_OPERATIONS_UNAVAILABLE", error.message),
    );
  }
  throw error;
}

function invalidRequest(message: string, issues?: unknown[]) {
  return new BadRequestException(
    payload(
      "INVALID_WORKER_OPERATIONS_REQUEST",
      message,
      issues ? normalizeIssues(issues) : undefined,
    ),
  );
}

function payload(code: string, message: string, issues?: unknown[]) {
  return {
    code,
    message,
    requestId: randomUUID(),
    ...(issues ? { issues } : {}),
  };
}

function normalizeIssues(issues: unknown[]) {
  return issues.map((issue, index) => {
    if (issue && typeof issue === "object") {
      const candidate = issue as { path?: unknown; message?: unknown };
      return {
        path: Array.isArray(candidate.path)
          ? candidate.path.map(String).join(".") || "request"
          : String(candidate.path ?? index),
        reason:
          typeof candidate.message === "string"
            ? candidate.message
            : "Invalid value.",
      };
    }
    return { path: String(index), reason: "Invalid value." };
  });
}
