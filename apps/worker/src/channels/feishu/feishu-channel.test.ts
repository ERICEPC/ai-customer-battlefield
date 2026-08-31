import type { ChannelNotification } from "@battlefield/core";
import { describe, expect, test, vi } from "vitest";

import { createNotificationChannels } from "../channel-registry.js";
import {
  FeishuChannel,
  type FeishuCredentialProvider,
  type FeishuMessenger,
} from "./feishu-channel.js";
import { FeishuProviderError } from "./feishu-errors.js";
import { LarkSdkMessenger } from "./lark-sdk-messenger.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const credentials = {
  appId: "cli_synthetic",
  appSecret: "synthetic-secret",
};
const notification: ChannelNotification = {
  deliveryId: "73000000-0000-4000-8000-000000000001",
  notificationId: "f0000000-0000-4000-8000-000000000001",
  recipientAddress: "ou_synthetic_owner",
  title: "经营动作已到计划时间",
  body: "推进正式方案已到计划时间，请及时推进。",
  deepLink: "/actions?actionId=d0000000-0000-4000-8000-000000000001",
  priority: "high",
  createdAt: "2026-09-01T01:00:00.000Z",
  dedupeKey: "feishu:f0000000-0000-4000-8000-000000000001",
};

function credentialProvider(
  value: Awaited<ReturnType<FeishuCredentialProvider["get"]>> = credentials,
): FeishuCredentialProvider {
  return { get: vi.fn(async () => value) };
}

function channelWith(messenger: FeishuMessenger): FeishuChannel {
  return new FeishuChannel({
    tenantId,
    publicWebBaseUrl: "https://battlefield.example.com",
    credentialProvider: credentialProvider(),
    messenger,
  });
}

describe("Feishu notification channel", () => {
  test("sends one summary card with a safe Web deep link and provider trace", async () => {
    const sendCard = vi.fn<FeishuMessenger["sendCard"]>(async () => ({
      providerMessageId: "om_synthetic",
      providerRequestId: "log_synthetic",
    }));
    const channel = channelWith({ sendCard });

    await expect(channel.send(notification)).resolves.toEqual({
      providerMessageId: "om_synthetic",
      providerRequestId: "log_synthetic",
    });
    expect(sendCard).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials,
        recipientOpenId: "ou_synthetic_owner",
        uuid: notification.dedupeKey,
      }),
    );
    const request = sendCard.mock.calls[0]?.[0];
    const serializedCard = JSON.stringify(request?.card);
    expect(serializedCard).toContain(notification.title);
    expect(serializedCard).toContain(notification.body);
    expect(serializedCard).toContain("高");
    expect(serializedCard).toContain("2026");
    expect(serializedCard).toContain(
      `https://battlefield.example.com${notification.deepLink}`,
    );
    expect(serializedCard).not.toMatch(/callback|action_id|business_action/i);
  });

  test("classifies rate limits and provider outages as retryable", async () => {
    const rateLimited = channelWith({
      async sendCard() {
        throw new FeishuProviderError({
          message: "rate limited",
          httpStatus: 429,
          retryAfterMs: 2_000,
          requestId: "log_rate_limited",
        });
      },
    });
    await expect(rateLimited.send(notification)).rejects.toMatchObject({
      code: "FEISHU_RATE_LIMITED",
      retryable: true,
      retryAfterMs: 2_000,
    });

    for (const failure of [
      new FeishuProviderError({ message: "gateway", httpStatus: 503 }),
      Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    ]) {
      const unavailable = channelWith({
        async sendCard() {
          throw failure;
        },
      });
      await expect(unavailable.send(notification)).rejects.toMatchObject({
        code: "FEISHU_PROVIDER_UNAVAILABLE",
        retryable: true,
      });
    }
  });

  test.each([230038, 230053])(
    "treats recipient code %s as a permanent unavailable address",
    async (providerCode) => {
      const channel = channelWith({
        async sendCard() {
          throw new FeishuProviderError({
            message: "recipient cannot receive",
            providerCode,
          });
        },
      });
      await expect(channel.send(notification)).rejects.toMatchObject({
        code: "FEISHU_RECIPIENT_UNAVAILABLE",
        retryable: false,
      });
    },
  );

  test("treats missing app scope as a permanent configuration failure", async () => {
    const channel = channelWith({
      async sendCard() {
        throw new FeishuProviderError({
          message: "scope missing",
          providerCode: 99991672,
        });
      },
    });
    await expect(channel.send(notification)).rejects.toMatchObject({
      code: "FEISHU_PERMISSION_DENIED",
      retryable: false,
    });
  });

  test("rejects unsafe local input without calling the provider", async () => {
    const sendCard = vi.fn<FeishuMessenger["sendCard"]>();
    const channel = channelWith({ sendCard });

    await expect(
      channel.send({
        ...notification,
        deepLink: "https://attacker.example/action",
      }),
    ).rejects.toMatchObject({
      code: "FEISHU_INVALID_NOTIFICATION",
      retryable: false,
    });
    await expect(
      channel.send({ ...notification, dedupeKey: "x".repeat(51) }),
    ).rejects.toMatchObject({
      code: "FEISHU_INVALID_NOTIFICATION",
      retryable: false,
    });
    expect(sendCard).not.toHaveBeenCalled();
  });

  test("registers Feishu only when the tenant has complete configuration", () => {
    expect(
      createNotificationChannels({
        tenantId,
        feishu: null,
      }),
    ).toEqual([]);
    expect(
      createNotificationChannels({
        tenantId,
        feishu: {
          ...credentials,
          publicWebBaseUrl: "https://battlefield.example.com",
          receiveIdType: "open_id",
        },
      }).map((channel) => channel.channel),
    ).toEqual(["feishu"]);
  });

  test("maps the channel request to the official SDK message contract", async () => {
    const sendMessage = vi.fn(async () => ({
      code: 0,
      data: { message_id: "om_synthetic" },
    }));
    const createSender = vi.fn(() => sendMessage);
    const messenger = new LarkSdkMessenger(createSender);
    const card = { elements: [{ tag: "div" }] };

    await expect(
      messenger.sendCard({
        credentials,
        recipientOpenId: notification.recipientAddress,
        uuid: notification.dedupeKey,
        card,
      }),
    ).resolves.toEqual({
      providerMessageId: "om_synthetic",
      providerRequestId: null,
    });
    expect(createSender).toHaveBeenCalledWith(credentials);
    expect(sendMessage).toHaveBeenCalledWith({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: notification.recipientAddress,
        msg_type: "interactive",
        content: JSON.stringify(card),
        uuid: notification.dedupeKey,
      },
    });
  });
});
