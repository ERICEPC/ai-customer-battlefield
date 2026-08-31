import {
  type TestUserAiConnectionResponse,
  testUserAiConnectionResponseSchema,
  type UpdateUserAiSettingsRequest,
  type UserAiSettingsResponse,
  userAiSettingsApiErrorSchema,
  userAiSettingsResponseSchema,
} from "@battlefield/contracts";

import { apiBaseUrl, withSessionCredentials } from "../api/api-configuration";

export class UserAiSettingsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UserAiSettingsApiError";
  }
}

export async function getUserAiSettings(): Promise<UserAiSettingsResponse> {
  const response = await fetch(
    `${apiBaseUrl()}/api/v1/me/ai-settings`,
    withSessionCredentials(),
  );
  return decode(response, userAiSettingsResponseSchema);
}

export async function updateUserAiSettings(
  input: UpdateUserAiSettingsRequest,
): Promise<UserAiSettingsResponse> {
  const response = await fetch(`${apiBaseUrl()}/api/v1/me/ai-settings`, {
    ...withSessionCredentials(),
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return decode(response, userAiSettingsResponseSchema);
}

export async function testUserAiConnection(): Promise<TestUserAiConnectionResponse> {
  const response = await fetch(`${apiBaseUrl()}/api/v1/me/ai-settings/test`, {
    ...withSessionCredentials(),
    method: "POST",
  });
  return decode(response, testUserAiConnectionResponseSchema);
}

async function decode<Output>(
  response: Response,
  schema: { parse(value: unknown): Output },
): Promise<Output> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = userAiSettingsApiErrorSchema.safeParse(payload);
    if (error.success) {
      throw new UserAiSettingsApiError(
        response.status,
        error.data.code,
        error.data.message,
      );
    }
    throw new UserAiSettingsApiError(
      response.status,
      "UNEXPECTED_RESPONSE",
      `个人 AI 设置请求失败（${response.status}）。`,
    );
  }
  return schema.parse(payload);
}
