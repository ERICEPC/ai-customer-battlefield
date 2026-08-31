import { randomUUID } from "node:crypto";
import {
  idempotencyKeySchema,
  type ManagementQueryResult,
  type ManagementQuerySubjectPage,
  managementQueryRequestSchema,
  managementQueryResultSchema,
  managementQuerySubjectListQuerySchema,
  managementQuerySubjectPageSchema,
} from "@battlefield/contracts";
import {
  InvalidManagementQueryClockError,
  InvalidManagementQueryCursorError,
  InvalidManagementQueryPeriodError,
  InvalidManagementQuerySubjectLimitError,
  type ListManagementQuerySubjects,
  ManagementQueryIdempotencyConflictError,
  ManagementQueryResultLimitExceededError,
  ManagementQuerySubjectNotFoundError,
  type RunManagementQuery,
} from "@battlefield/core";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Post,
  Query,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { RequireCapabilities } from "../auth/auth.constants.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  LIST_MANAGEMENT_QUERY_SUBJECTS,
  ManagementQueryUnavailableError,
  RUN_MANAGEMENT_QUERY,
} from "./management-queries.providers.js";

@RequireCapabilities("management_query.execute")
@Controller()
export class ManagementQueriesController {
  constructor(
    @Inject(LIST_MANAGEMENT_QUERY_SUBJECTS)
    private readonly listSubjects: ListManagementQuerySubjects,
    @Inject(RUN_MANAGEMENT_QUERY)
    private readonly runQuery: RunManagementQuery,
  ) {}

  @Get("management-query-subjects")
  async subjects(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ManagementQuerySubjectPage> {
    const actor = developmentActor(tenantId, userId);
    const parsed = managementQuerySubjectListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidManagementQuery(
        "Invalid management-query subject request.",
        parsed.error.issues,
      );
    }
    try {
      return managementQuerySubjectPageSchema.parse(
        await this.listSubjects.execute({
          actor,
          limit: parsed.data.limit ?? 50,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      return mapManagementQueryError(error);
    }
  }

  @Post("management-queries")
  async run(
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
  ): Promise<ManagementQueryResult> {
    const actor = developmentActor(tenantId, userId);
    const parsed = managementQueryRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidManagementQuery(
        "Invalid management query.",
        parsed.error.issues,
      );
    }
    const idempotencyKey = idempotencyKeySchema.safeParse(rawIdempotencyKey);
    if (!idempotencyKey.success) {
      throw invalidManagementQuery(
        "A valid Idempotency-Key header is required.",
        idempotencyKey.error.issues,
      );
    }
    try {
      return managementQueryResultSchema.parse(
        await this.runQuery.execute({
          actor,
          idempotencyKey: idempotencyKey.data,
          ...parsed.data,
        }),
      );
    } catch (error) {
      return mapManagementQueryError(error);
    }
  }
}

function mapManagementQueryError(error: unknown): never {
  if (
    error instanceof InvalidManagementQueryCursorError ||
    error instanceof InvalidManagementQuerySubjectLimitError ||
    error instanceof InvalidManagementQueryPeriodError ||
    error instanceof InvalidManagementQueryClockError
  ) {
    throw invalidManagementQuery(error.message);
  }
  if (error instanceof ManagementQuerySubjectNotFoundError) {
    throw new NotFoundException(
      errorPayload("MANAGEMENT_QUERY_SUBJECT_NOT_FOUND", error.message),
    );
  }
  if (error instanceof ManagementQueryIdempotencyConflictError) {
    throw new ConflictException(
      errorPayload("MANAGEMENT_QUERY_IDEMPOTENCY_CONFLICT", error.message),
    );
  }
  if (error instanceof ManagementQueryResultLimitExceededError) {
    throw new UnprocessableEntityException(
      errorPayload("MANAGEMENT_QUERY_RESULT_LIMIT_EXCEEDED", error.message),
    );
  }
  if (error instanceof ManagementQueryUnavailableError) {
    throw new ServiceUnavailableException(
      errorPayload("MANAGEMENT_QUERY_UNAVAILABLE", error.message),
    );
  }
  throw error;
}

function invalidManagementQuery(message: string, issues?: unknown[]) {
  return new BadRequestException(
    errorPayload("INVALID_MANAGEMENT_QUERY", message, issues),
  );
}

function errorPayload(code: string, message: string, issues?: unknown[]) {
  return {
    code,
    message,
    requestId: randomUUID(),
    ...(issues ? { issues: normalizeIssues(issues) } : {}),
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
