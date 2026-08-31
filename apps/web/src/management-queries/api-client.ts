import {
  idempotencyKeySchema,
  type ManagementQueryRequest,
  type ManagementQueryResult,
  type ManagementQuerySubjectListQuery,
  type ManagementQuerySubjectPage,
  managementQueryApiErrorSchema,
  managementQueryRequestSchema,
  managementQueryResultSchema,
  managementQuerySubjectListQuerySchema,
  managementQuerySubjectPageSchema,
} from "@battlefield/contracts";

import { apiBaseUrl, withSessionCredentials } from "../api/api-configuration";

export class ManagementQueryApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ManagementQueryApiError";
  }
}

async function apiRequest<T>(
  path: string,
  schema: { parse(input: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    `${apiBaseUrl()}/api/v1${path}`,
    withSessionCredentials(init),
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = managementQueryApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ManagementQueryApiError(
        response.status,
        parsed.data.code,
        parsed.data.message,
        parsed.data.requestId,
      );
    }
    throw new ManagementQueryApiError(
      response.status,
      "UNEXPECTED_RESPONSE",
      `管理问数请求失败（${response.status}），请稍后重试。`,
    );
  }
  return schema.parse(payload);
}

export async function listManagementQuerySubjects(
  input: ManagementQuerySubjectListQuery = {},
): Promise<ManagementQuerySubjectPage> {
  const query = managementQuerySubjectListQuerySchema.parse(input);
  const parameters = new URLSearchParams();
  if (query.cursor) parameters.set("cursor", query.cursor);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
  return apiRequest(
    `/management-query-subjects${suffix}`,
    managementQuerySubjectPageSchema,
  );
}

export async function runManagementQuery(
  input: ManagementQueryRequest,
  idempotencyKey: string,
): Promise<ManagementQueryResult> {
  const request = managementQueryRequestSchema.parse(input);
  const key = idempotencyKeySchema.parse(idempotencyKey);
  return apiRequest("/management-queries", managementQueryResultSchema, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(request),
  });
}
