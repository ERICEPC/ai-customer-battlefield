import {
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
): Promise<ManagementQueryResult> {
  const request = managementQueryRequestSchema.parse(input);
  return apiRequest("/management-queries", managementQueryResultSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}
