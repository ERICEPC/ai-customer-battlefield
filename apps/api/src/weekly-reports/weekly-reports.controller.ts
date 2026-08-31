import { randomUUID } from "node:crypto";
import {
  generateWeeklyReportRequestSchema,
  idempotencyKeySchema,
  reviewWeeklyReportRequestSchema,
  type WeeklyReportDetail,
  type WeeklyReportPage,
  weeklyReportDetailSchema,
  weeklyReportListQuerySchema,
  weeklyReportPageSchema,
  weeklyReportTransitionRequestSchema,
} from "@battlefield/contracts";
import {
  type GenerateWeeklyReport,
  type GetWeeklyReport,
  InvalidWeeklyReportClockError,
  InvalidWeeklyReportCursorError,
  InvalidWeeklyReportListLimitError,
  InvalidWeeklyReportPeriodError,
  InvalidWeeklyReportReviewError,
  InvalidWeeklyReportVersionError,
  type ListWeeklyReports,
  type PublishWeeklyReport,
  type ReviewWeeklyReport,
  type ReviseWeeklyReport,
  WeeklyReportIdempotencyConflictError,
  WeeklyReportNotFoundError,
  WeeklyReportResultLimitExceededError,
  WeeklyReportScopeConflictError,
  WeeklyReportVersionConflictError,
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
  Param,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  GENERATE_WEEKLY_REPORT,
  GET_WEEKLY_REPORT,
  LIST_WEEKLY_REPORTS,
  PUBLISH_WEEKLY_REPORT,
  REVIEW_WEEKLY_REPORT,
  REVISE_WEEKLY_REPORT,
  WeeklyReportUnavailableError,
} from "./weekly-reports.providers.js";

@Controller("reports")
export class WeeklyReportsController {
  constructor(
    @Inject(GENERATE_WEEKLY_REPORT)
    private readonly generateReport: GenerateWeeklyReport,
    @Inject(LIST_WEEKLY_REPORTS)
    private readonly listReports: ListWeeklyReports,
    @Inject(GET_WEEKLY_REPORT)
    private readonly getReport: GetWeeklyReport,
    @Inject(REVIEW_WEEKLY_REPORT)
    private readonly reviewReport: ReviewWeeklyReport,
    @Inject(PUBLISH_WEEKLY_REPORT)
    private readonly publishReport: PublishWeeklyReport,
    @Inject(REVISE_WEEKLY_REPORT)
    private readonly reviseReport: ReviseWeeklyReport,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<WeeklyReportPage> {
    const actor = developmentActor(tenantId, userId);
    const parsed = weeklyReportListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidWeeklyReport(
        "Invalid weekly-report list request.",
        parsed.error.issues,
      );
    }
    try {
      return weeklyReportPageSchema.parse(
        await this.listReports.execute({
          actor,
          limit: parsed.data.limit ?? 20,
          ...(parsed.data.reportType
            ? { reportType: parsed.data.reportType }
            : {}),
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      return mapWeeklyReportError(error);
    }
  }

  @Post()
  async generate(
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
  ): Promise<WeeklyReportDetail> {
    const actor = developmentActor(tenantId, userId);
    const request = parseBody(generateWeeklyReportRequestSchema, body);
    const idempotencyKey = parseIdempotencyKey(rawIdempotencyKey);
    try {
      return weeklyReportDetailSchema.parse(
        await this.generateReport.execute({
          actor,
          idempotencyKey,
          ...request,
        }),
      );
    } catch (error) {
      return mapWeeklyReportError(error);
    }
  }

  @Get(":versionId")
  async detail(
    @Param("versionId") rawVersionId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<WeeklyReportDetail> {
    const actor = developmentActor(tenantId, userId);
    const versionId = parseVersionId(rawVersionId);
    try {
      return weeklyReportDetailSchema.parse(
        await this.getReport.execute({ actor, versionId }),
      );
    } catch (error) {
      return mapWeeklyReportError(error);
    }
  }

  @Patch(":versionId/review")
  async review(
    @Param("versionId") rawVersionId: string,
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<WeeklyReportDetail> {
    const actor = developmentActor(tenantId, userId);
    const versionId = parseVersionId(rawVersionId);
    const request = parseBody(reviewWeeklyReportRequestSchema, body);
    try {
      return weeklyReportDetailSchema.parse(
        await this.reviewReport.execute({ actor, versionId, ...request }),
      );
    } catch (error) {
      return mapWeeklyReportError(error);
    }
  }

  @Post(":versionId/publish")
  async publish(
    @Param("versionId") rawVersionId: string,
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
  ): Promise<WeeklyReportDetail> {
    return this.transition({
      rawVersionId,
      body,
      tenantId,
      userId,
      rawIdempotencyKey,
      useCase: this.publishReport,
    });
  }

  @Post(":versionId/revise")
  async revise(
    @Param("versionId") rawVersionId: string,
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
  ): Promise<WeeklyReportDetail> {
    return this.transition({
      rawVersionId,
      body,
      tenantId,
      userId,
      rawIdempotencyKey,
      useCase: this.reviseReport,
    });
  }

  private async transition(input: {
    rawVersionId: string;
    body: unknown;
    tenantId: string | undefined;
    userId: string | undefined;
    rawIdempotencyKey: string | undefined;
    useCase: PublishWeeklyReport | ReviseWeeklyReport;
  }): Promise<WeeklyReportDetail> {
    const actor = developmentActor(input.tenantId, input.userId);
    const versionId = parseVersionId(input.rawVersionId);
    const request = parseBody(weeklyReportTransitionRequestSchema, input.body);
    const idempotencyKey = parseIdempotencyKey(input.rawIdempotencyKey);
    try {
      return weeklyReportDetailSchema.parse(
        await input.useCase.execute({
          actor,
          versionId,
          idempotencyKey,
          ...request,
        }),
      );
    } catch (error) {
      return mapWeeklyReportError(error);
    }
  }
}

function parseBody<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: unknown[] } };
  },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw invalidWeeklyReport(
      "Invalid weekly-report request.",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function parseVersionId(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw invalidWeeklyReport("Invalid weekly-report version identifier.");
  }
  return value;
}

function parseIdempotencyKey(value?: string): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw invalidWeeklyReport(
      "A valid Idempotency-Key header is required.",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function mapWeeklyReportError(error: unknown): never {
  if (
    error instanceof InvalidWeeklyReportClockError ||
    error instanceof InvalidWeeklyReportCursorError ||
    error instanceof InvalidWeeklyReportListLimitError ||
    error instanceof InvalidWeeklyReportPeriodError ||
    error instanceof InvalidWeeklyReportReviewError ||
    error instanceof InvalidWeeklyReportVersionError
  ) {
    throw invalidWeeklyReport(error.message);
  }
  if (error instanceof WeeklyReportNotFoundError) {
    throw new NotFoundException(
      errorPayload("WEEKLY_REPORT_NOT_FOUND", error.message),
    );
  }
  if (error instanceof WeeklyReportVersionConflictError) {
    throw new ConflictException(
      errorPayload("WEEKLY_REPORT_VERSION_CONFLICT", error.message),
    );
  }
  if (error instanceof WeeklyReportScopeConflictError) {
    throw new ConflictException(
      errorPayload("WEEKLY_REPORT_SCOPE_CONFLICT", error.message),
    );
  }
  if (error instanceof WeeklyReportIdempotencyConflictError) {
    throw new ConflictException(
      errorPayload("WEEKLY_REPORT_IDEMPOTENCY_CONFLICT", error.message),
    );
  }
  if (error instanceof WeeklyReportResultLimitExceededError) {
    throw new UnprocessableEntityException(
      errorPayload("WEEKLY_REPORT_RESULT_LIMIT_EXCEEDED", error.message),
    );
  }
  if (error instanceof WeeklyReportUnavailableError) {
    throw new ServiceUnavailableException(
      errorPayload("WEEKLY_REPORT_UNAVAILABLE", error.message),
    );
  }
  throw error;
}

function invalidWeeklyReport(message: string, issues?: unknown[]) {
  return new BadRequestException(
    errorPayload("INVALID_WEEKLY_REPORT_REQUEST", message, issues),
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
