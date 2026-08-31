import {
  type AuthApiError as AuthApiErrorPayload,
  authApiErrorSchema,
  type LoginRequest,
  loginRequestSchema,
  loginResponseSchema,
  type SessionProfile,
  sessionProfileSchema,
} from "@battlefield/contracts";

import { apiBaseUrl, withSessionCredentials } from "../api/api-configuration";

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: AuthApiErrorPayload["code"] | "UNEXPECTED_RESPONSE",
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

export async function login(input: LoginRequest): Promise<SessionProfile> {
  const payload = loginRequestSchema.parse(input);
  const response = await fetch(
    `${apiBaseUrl()}/api/v1/auth/login`,
    withSessionCredentials({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw authError(response.status, body);
  return loginResponseSchema.parse(body).session;
}

export async function getSession(): Promise<SessionProfile> {
  const response = await fetch(
    `${apiBaseUrl()}/api/v1/auth/session`,
    withSessionCredentials(),
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw authError(response.status, body);
  return sessionProfileSchema.parse(body);
}

export async function logout(): Promise<void> {
  const response = await fetch(
    `${apiBaseUrl()}/api/v1/auth/logout`,
    withSessionCredentials({ method: "POST" }),
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw authError(response.status, body);
  }
}

function authError(status: number, body: unknown): AuthApiError {
  const parsed = authApiErrorSchema.safeParse(body);
  if (parsed.success) {
    return new AuthApiError(
      status,
      parsed.data.code,
      parsed.data.message,
      parsed.data.requestId,
    );
  }
  return new AuthApiError(
    status,
    "UNEXPECTED_RESPONSE",
    `登录请求失败（${status}），请稍后重试。`,
  );
}
