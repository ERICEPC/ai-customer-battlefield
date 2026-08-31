import {
  type InboxPage,
  type InboxQuery,
  inboxPageSchema,
  inboxQuerySchema,
  type MarkNotificationReadResponse,
  markNotificationReadResponseSchema,
  notificationApiErrorSchema,
} from "@battlefield/contracts";

import { apiBaseUrl, withSessionCredentials } from "../api/api-configuration";

export class NotificationApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "NotificationApiError";
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
    const parsed = notificationApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new NotificationApiError(
        response.status,
        parsed.data.code,
        parsed.data.message,
        parsed.data.requestId,
      );
    }
    throw new NotificationApiError(
      response.status,
      "UNEXPECTED_RESPONSE",
      `通知请求失败（${response.status}），请稍后重试。`,
    );
  }
  return schema.parse(payload);
}

export async function listInbox(input: InboxQuery): Promise<InboxPage> {
  const query = inboxQuerySchema.parse(input);
  const parameters = new URLSearchParams();
  if (query.unreadOnly !== undefined) {
    parameters.set("unreadOnly", String(query.unreadOnly));
  }
  if (query.cursor !== undefined) parameters.set("cursor", query.cursor);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
  return apiRequest(`/inbox${suffix}`, inboxPageSchema);
}

export async function markNotificationRead(
  notificationId: string,
): Promise<MarkNotificationReadResponse> {
  return apiRequest(
    `/inbox/${encodeURIComponent(notificationId)}/read`,
    markNotificationReadResponseSchema,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
}
