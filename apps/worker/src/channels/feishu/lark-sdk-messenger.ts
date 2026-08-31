import * as lark from "@larksuiteoapi/node-sdk";

import type { FeishuMessenger } from "./feishu-channel.js";
import { FeishuProviderError } from "./feishu-errors.js";

interface MessagePayload {
  params: { receive_id_type: "open_id" };
  data: {
    receive_id: string;
    msg_type: "interactive";
    content: string;
    uuid: string;
  };
}

interface MessageResponse {
  code?: number | undefined;
  msg?: string | undefined;
  data?: { message_id?: string | undefined } | undefined;
}

type MessageSender = (payload: MessagePayload) => Promise<MessageResponse>;

export class LarkSdkMessenger implements FeishuMessenger {
  constructor(
    private readonly createSender: (
      credentials: Parameters<FeishuMessenger["sendCard"]>[0]["credentials"],
    ) => MessageSender = createSdkSender,
  ) {}

  async sendCard(
    input: Parameters<FeishuMessenger["sendCard"]>[0],
  ): ReturnType<FeishuMessenger["sendCard"]> {
    const sendMessage = this.createSender(input.credentials);
    try {
      const response = await sendMessage({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: input.recipientOpenId,
          msg_type: "interactive",
          content: JSON.stringify(input.card),
          uuid: input.uuid,
        },
      });
      if (response.code && response.code !== 0) {
        throw new FeishuProviderError({
          message: response.msg ?? "Feishu rejected the message.",
          providerCode: response.code,
        });
      }
      const providerMessageId = response.data?.message_id;
      if (!providerMessageId) {
        throw new FeishuProviderError({
          message: "Feishu returned no message identifier.",
        });
      }
      return { providerMessageId, providerRequestId: null };
    } catch (error) {
      throw normalizeSdkError(error);
    }
  }
}

function createSdkSender(
  credentials: Parameters<FeishuMessenger["sendCard"]>[0]["credentials"],
): MessageSender {
  const client = new lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });
  return (payload) => client.im.message.create(payload);
}

function normalizeSdkError(error: unknown): unknown {
  if (error instanceof FeishuProviderError) {
    return error;
  }
  if (!isRecord(error)) {
    return error;
  }
  const response = isRecord(error.response) ? error.response : null;
  const body = isRecord(response?.data) ? response.data : null;
  const headers = isRecord(response?.headers) ? response.headers : null;
  const status = numberValue(response?.status) ?? numberValue(error.status);
  const providerCode = numberValue(body?.code);
  if (status === null && providerCode === null) {
    return error;
  }
  return new FeishuProviderError({
    message: stringValue(body?.msg) ?? "Feishu provider request failed.",
    providerCode,
    httpStatus: status,
    retryAfterMs: retryAfterMs(headers),
    requestId:
      header(headers, "x-tt-logid") ??
      header(headers, "x-request-id") ??
      header(headers, "x-feishu-request-id"),
  });
}

function retryAfterMs(headers: Record<string, unknown> | null): number | null {
  const raw = header(headers, "retry-after");
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function header(
  headers: Record<string, unknown> | null,
  name: string,
): string | null {
  if (!headers) {
    return null;
  }
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  return stringValue(entry?.[1]);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
