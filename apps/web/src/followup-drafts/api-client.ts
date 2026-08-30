import {
  type ConfirmFollowupDraftRequest,
  type CreateFollowupDraftRequest,
  cancelFollowupDraftRequestSchema,
  confirmFollowupDraftRequestSchema,
  createFollowupDraftRequestSchema,
  type FollowupConfirmationResponse,
  type FollowupDraftResponse,
  type FormalFollowupRecord,
  followupApiErrorSchema,
  followupConfirmationResponseSchema,
  followupDraftResponseSchema,
  formalFollowupRecordSchema,
  idempotencyKeySchema,
  type ReviseFollowupDraftRequest,
  reviseFollowupDraftRequestSchema,
} from "@battlefield/contracts";

export class FollowupApiError extends Error {
  readonly code: string | null;

  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const parsed = followupApiErrorSchema.safeParse(body);
    super(
      parsed.success
        ? parsed.data.message
        : `Follow-up request failed with status ${status}.`,
    );
    this.name = "FollowupApiError";
    this.code = parsed.success ? parsed.data.code : null;
  }
}

function getApiConfiguration(): {
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

async function sendFollowupRequest(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const { baseUrl, headers } = getApiConfiguration();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new FollowupApiError(response.status, body);
  }
  return body;
}

function jsonRequest(
  method: "POST" | "PATCH",
  body: unknown,
  idempotencyKey?: string,
): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  };
}

export async function createFollowupDraft(
  request: CreateFollowupDraftRequest,
): Promise<FollowupDraftResponse> {
  const payload = createFollowupDraftRequestSchema.parse(request);
  return followupDraftResponseSchema.parse(
    await sendFollowupRequest(
      "/api/v1/followup-drafts",
      jsonRequest("POST", payload),
    ),
  );
}

export async function getFollowupDraft(
  draftId: string,
): Promise<FollowupDraftResponse> {
  return followupDraftResponseSchema.parse(
    await sendFollowupRequest(
      `/api/v1/followup-drafts/${encodeURIComponent(draftId)}`,
    ),
  );
}

export async function reviseFollowupDraft(
  draftId: string,
  request: ReviseFollowupDraftRequest,
): Promise<FollowupDraftResponse> {
  const payload = reviseFollowupDraftRequestSchema.parse(request);
  return followupDraftResponseSchema.parse(
    await sendFollowupRequest(
      `/api/v1/followup-drafts/${encodeURIComponent(draftId)}`,
      jsonRequest("PATCH", payload),
    ),
  );
}

export async function cancelFollowupDraft(
  draftId: string,
  request: ConfirmFollowupDraftRequest,
  idempotencyKey: string,
): Promise<FollowupDraftResponse> {
  const payload = cancelFollowupDraftRequestSchema.parse(request);
  const key = idempotencyKeySchema.parse(idempotencyKey);
  return followupDraftResponseSchema.parse(
    await sendFollowupRequest(
      `/api/v1/followup-drafts/${encodeURIComponent(draftId)}/cancel`,
      jsonRequest("POST", payload, key),
    ),
  );
}

export async function confirmFollowupDraft(
  draftId: string,
  request: ConfirmFollowupDraftRequest,
  idempotencyKey: string,
): Promise<FollowupConfirmationResponse> {
  const payload = confirmFollowupDraftRequestSchema.parse(request);
  const key = idempotencyKeySchema.parse(idempotencyKey);
  return followupConfirmationResponseSchema.parse(
    await sendFollowupRequest(
      `/api/v1/followup-drafts/${encodeURIComponent(draftId)}/confirm`,
      jsonRequest("POST", payload, key),
    ),
  );
}

export async function getFormalFollowup(
  followupId: string,
): Promise<FormalFollowupRecord> {
  return formalFollowupRecordSchema.parse(
    await sendFollowupRequest(
      `/api/v1/followups/${encodeURIComponent(followupId)}`,
    ),
  );
}
