import {
  type WorkspaceSnapshot,
  workspaceApiErrorSchema,
  workspaceSnapshotSchema,
} from "@battlefield/contracts";

import { apiBaseUrl, withSessionCredentials } from "../api/api-configuration";

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

export async function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const response = await fetch(
    `${apiBaseUrl()}/api/v1/workspace`,
    withSessionCredentials(),
  );
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
