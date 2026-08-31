import {
  type GenerateWeeklyReportRequest,
  generateWeeklyReportRequestSchema,
  idempotencyKeySchema,
  type ReviewWeeklyReportRequest,
  reviewWeeklyReportRequestSchema,
  type WeeklyReportDetail,
  type WeeklyReportListQuery,
  type WeeklyReportPage,
  type WeeklyReportTransitionRequest,
  weeklyReportApiErrorSchema,
  weeklyReportDetailSchema,
  weeklyReportListQuerySchema,
  weeklyReportPageSchema,
  weeklyReportTransitionRequestSchema,
} from "@battlefield/contracts";

export class WeeklyReportApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "WeeklyReportApiError";
  }
}

function configuration(): {
  baseUrl: string;
  headers: Record<string, string>;
} {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (process.env.NODE_ENV === "production") {
    if (!configuredBaseUrl) {
      throw new Error("The production API endpoint is not configured.");
    }
    throw new Error("Production authentication is not configured.");
  }
  return {
    baseUrl: configuredBaseUrl ?? "http://localhost:3001",
    headers: {
      "x-tenant-id":
        process.env.NEXT_PUBLIC_DEV_TENANT_ID ??
        "10000000-0000-4000-8000-000000000001",
      "x-user-id":
        process.env.NEXT_PUBLIC_DEV_USER_ID ??
        "30000000-0000-4000-8000-000000000001",
    },
  };
}

async function apiRequest<T>(
  path: string,
  schema: { parse(input: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  const { baseUrl, headers } = configuration();
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = weeklyReportApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new WeeklyReportApiError(
        response.status,
        parsed.data.code,
        parsed.data.message,
        parsed.data.requestId,
      );
    }
    throw new WeeklyReportApiError(
      response.status,
      "UNEXPECTED_RESPONSE",
      `周报请求失败（${response.status}），请稍后重试。`,
    );
  }
  return schema.parse(payload);
}

export async function listWeeklyReports(
  input: WeeklyReportListQuery = {},
): Promise<WeeklyReportPage> {
  const query = weeklyReportListQuerySchema.parse(input);
  const parameters = new URLSearchParams();
  if (query.reportType) parameters.set("reportType", query.reportType);
  if (query.status) parameters.set("status", query.status);
  if (query.cursor) parameters.set("cursor", query.cursor);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
  return apiRequest(`/reports${suffix}`, weeklyReportPageSchema);
}

export async function generateWeeklyReport(
  input: GenerateWeeklyReportRequest,
  idempotencyKey: string,
): Promise<WeeklyReportDetail> {
  return writeReport(
    "/reports",
    "POST",
    generateWeeklyReportRequestSchema.parse(input),
    idempotencyKey,
  );
}

export async function getWeeklyReport(
  versionId: string,
): Promise<WeeklyReportDetail> {
  return apiRequest(
    `/reports/${encodeURIComponent(assertUuid(versionId))}`,
    weeklyReportDetailSchema,
  );
}

export async function reviewWeeklyReport(
  versionId: string,
  input: ReviewWeeklyReportRequest,
): Promise<WeeklyReportDetail> {
  return apiRequest(
    `/reports/${encodeURIComponent(assertUuid(versionId))}/review`,
    weeklyReportDetailSchema,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reviewWeeklyReportRequestSchema.parse(input)),
    },
  );
}

export async function publishWeeklyReport(
  versionId: string,
  input: WeeklyReportTransitionRequest,
  idempotencyKey: string,
): Promise<WeeklyReportDetail> {
  return writeReport(
    `/reports/${encodeURIComponent(assertUuid(versionId))}/publish`,
    "POST",
    weeklyReportTransitionRequestSchema.parse(input),
    idempotencyKey,
  );
}

export async function reviseWeeklyReport(
  versionId: string,
  input: WeeklyReportTransitionRequest,
  idempotencyKey: string,
): Promise<WeeklyReportDetail> {
  return writeReport(
    `/reports/${encodeURIComponent(assertUuid(versionId))}/revise`,
    "POST",
    weeklyReportTransitionRequestSchema.parse(input),
    idempotencyKey,
  );
}

function writeReport(
  path: string,
  method: "POST",
  body: object,
  idempotencyKey: string,
): Promise<WeeklyReportDetail> {
  const key = idempotencyKeySchema.parse(idempotencyKey);
  return apiRequest(path, weeklyReportDetailSchema, {
    method,
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}

function assertUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError("周报版本标识无效。");
  }
  return value;
}
