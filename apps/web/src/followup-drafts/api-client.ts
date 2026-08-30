import {
  type CreateFollowupDraftRequest,
  createFollowupDraftRequestSchema,
  type FollowupDraftResponse,
  followupDraftResponseSchema,
} from "@battlefield/contracts";

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
      "x-tenant-id": process.env.NEXT_PUBLIC_DEV_TENANT_ID ?? "tenant-demo",
      "x-user-id": process.env.NEXT_PUBLIC_DEV_USER_ID ?? "user-demo",
    },
  };
}

export async function createFollowupDraft(
  request: CreateFollowupDraftRequest,
): Promise<FollowupDraftResponse> {
  const payload = createFollowupDraftRequestSchema.parse(request);
  const { baseUrl, headers } = getApiConfiguration();
  const response = await fetch(`${baseUrl}/api/v1/followup-drafts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Follow-up draft request failed with status ${response.status}.`,
    );
  }

  return followupDraftResponseSchema.parse(await response.json());
}
