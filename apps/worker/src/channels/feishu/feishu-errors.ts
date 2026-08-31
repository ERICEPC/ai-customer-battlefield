import { NotificationChannelError } from "@battlefield/core";

const RECIPIENT_UNAVAILABLE_CODES = new Set([230038, 230053]);
const PERMISSION_CODES = new Set([99991663, 99991672]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

export class FeishuProviderError extends Error {
  readonly providerCode: number | null;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;

  constructor(input: {
    message: string;
    providerCode?: number | null;
    httpStatus?: number | null;
    retryAfterMs?: number | null;
    requestId?: string | null;
  }) {
    super(input.message);
    this.name = "FeishuProviderError";
    this.providerCode = input.providerCode ?? null;
    this.httpStatus = input.httpStatus ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.requestId = input.requestId ?? null;
  }
}

export function classifyFeishuError(error: unknown): NotificationChannelError {
  if (error instanceof NotificationChannelError) {
    return error;
  }
  if (
    error instanceof FeishuProviderError &&
    error.providerCode !== null &&
    RECIPIENT_UNAVAILABLE_CODES.has(error.providerCode)
  ) {
    return permanent(
      "FEISHU_RECIPIENT_UNAVAILABLE",
      "The Feishu recipient cannot receive app-bot messages.",
    );
  }
  if (
    error instanceof FeishuProviderError &&
    error.providerCode !== null &&
    PERMISSION_CODES.has(error.providerCode)
  ) {
    return permanent(
      "FEISHU_PERMISSION_DENIED",
      "The Feishu app is not permitted to send this message.",
    );
  }
  const httpStatus = readHttpStatus(error);
  if (httpStatus === 429) {
    return new NotificationChannelError(
      "FEISHU_RATE_LIMITED",
      "Feishu rate-limited the notification request.",
      true,
      readRetryAfterMs(error),
    );
  }
  if (
    httpStatus !== null &&
    (httpStatus === 408 || httpStatus === 425 || httpStatus >= 500)
  ) {
    return retryableUnavailable();
  }
  if (RETRYABLE_NETWORK_CODES.has(readNetworkCode(error) ?? "")) {
    return retryableUnavailable();
  }
  if (error instanceof FeishuProviderError || isClientHttpStatus(httpStatus)) {
    return permanent(
      "FEISHU_PROVIDER_REJECTED",
      "Feishu rejected the notification request.",
    );
  }
  return retryableUnavailable();
}

function retryableUnavailable(): NotificationChannelError {
  return new NotificationChannelError(
    "FEISHU_PROVIDER_UNAVAILABLE",
    "Feishu notification delivery is temporarily unavailable.",
    true,
  );
}

function permanent(
  code: string,
  safeMessage: string,
): NotificationChannelError {
  return new NotificationChannelError(code, safeMessage, false);
}

function readHttpStatus(error: unknown): number | null {
  if (error instanceof FeishuProviderError) {
    return error.httpStatus;
  }
  if (!isRecord(error)) {
    return null;
  }
  const direct = numeric(error.status);
  const response = isRecord(error.response) ? error.response : null;
  return direct ?? numeric(response?.status);
}

function readRetryAfterMs(error: unknown): number | null {
  if (error instanceof FeishuProviderError) {
    return error.retryAfterMs;
  }
  return null;
}

function readNetworkCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function isClientHttpStatus(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
