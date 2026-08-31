import {
  type WorkspaceSnapshot,
  workspaceApiErrorSchema,
  workspaceSnapshotSchema,
} from "@battlefield/contracts";

export class WorkspaceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "WorkspaceApiError";
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

export async function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const { baseUrl, headers } = configuration();
  const response = await fetch(`${baseUrl}/api/v1/workspace`, { headers });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = workspaceApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new WorkspaceApiError(
        response.status,
        parsed.data.code,
        parsed.data.message,
        parsed.data.requestId,
      );
    }
    throw new WorkspaceApiError(
      response.status,
      "UNEXPECTED_RESPONSE",
      `工作台请求失败（${response.status}），请稍后重试。`,
    );
  }
  return workspaceSnapshotSchema.parse(payload);
}
