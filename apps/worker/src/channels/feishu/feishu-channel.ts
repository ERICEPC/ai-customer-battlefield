import {
  type ChannelNotification,
  type NotificationChannel,
  NotificationChannelError,
} from "@battlefield/core";

import { classifyFeishuError } from "./feishu-errors.js";

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export interface FeishuCredentialProvider {
  get(tenantId: string): Promise<FeishuCredentials | null>;
}

export interface FeishuMessenger {
  sendCard(input: {
    credentials: FeishuCredentials;
    recipientOpenId: string;
    uuid: string;
    card: Record<string, unknown>;
  }): Promise<{
    providerMessageId: string;
    providerRequestId: string | null;
  }>;
}

export class FeishuChannel implements NotificationChannel {
  readonly channel = "feishu" as const;

  constructor(
    private readonly dependencies: {
      tenantId: string;
      publicWebBaseUrl: string;
      credentialProvider: FeishuCredentialProvider;
      messenger: FeishuMessenger;
    },
  ) {}

  async send(input: ChannelNotification): Promise<{
    providerMessageId: string;
    providerRequestId: string | null;
  }> {
    let card: Record<string, unknown>;
    try {
      card = buildFeishuNotificationCard(
        input,
        this.dependencies.publicWebBaseUrl,
      );
    } catch {
      throw new NotificationChannelError(
        "FEISHU_INVALID_NOTIFICATION",
        "The notification cannot be represented as a safe Feishu card.",
        false,
      );
    }
    const credentials = await this.dependencies.credentialProvider.get(
      this.dependencies.tenantId,
    );
    if (!credentials) {
      throw new NotificationChannelError(
        "FEISHU_CONFIGURATION_UNAVAILABLE",
        "Feishu notification credentials are unavailable for this tenant.",
        false,
      );
    }
    try {
      return await this.dependencies.messenger.sendCard({
        credentials,
        recipientOpenId: input.recipientAddress,
        uuid: input.dedupeKey,
        card,
      });
    } catch (error) {
      throw classifyFeishuError(error);
    }
  }
}

export function buildFeishuNotificationCard(
  input: ChannelNotification,
  publicWebBaseUrl: string,
): Record<string, unknown> {
  validateNotification(input);
  const deepLink = absoluteDeepLink(publicWebBaseUrl, input.deepLink);
  const createdAt = new Date(input.createdAt);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("Invalid notification timestamp.");
  }
  const createdLabel = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(createdAt);
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: priorityTemplate(input.priority),
      title: { tag: "plain_text", content: input.title },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: input.body },
      },
      {
        tag: "div",
        fields: [
          {
            is_short: true,
            text: {
              tag: "lark_md",
              content: `**优先级**\n${priorityLabel(input.priority)}`,
            },
          },
          {
            is_short: true,
            text: {
              tag: "lark_md",
              content: `**提醒时间**\n${createdLabel}`,
            },
          },
        ],
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "打开经营动作" },
            url: deepLink,
          },
        ],
      },
    ],
  };
}

function validateNotification(input: ChannelNotification): void {
  if (
    !/^ou_[A-Za-z0-9_-]{1,125}$/.test(input.recipientAddress) ||
    input.title.length === 0 ||
    input.title.length > 200 ||
    input.body.length === 0 ||
    input.body.length > 2_000 ||
    !/^\/(?!\/)[^\r\n]*$/.test(input.deepLink) ||
    input.dedupeKey.length === 0 ||
    input.dedupeKey.length > 50
  ) {
    throw new Error("Invalid notification input.");
  }
}

function absoluteDeepLink(baseValue: string, deepLink: string): string {
  const base = new URL(baseValue);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("Invalid public Web base URL.");
  }
  const absolute = new URL(
    `${base.pathname.replace(/\/$/, "")}${deepLink}`,
    base.origin,
  );
  if (absolute.origin !== base.origin) {
    throw new Error("Unsafe notification deep link.");
  }
  return absolute.toString();
}

function priorityLabel(priority: ChannelNotification["priority"]): string {
  return { low: "低", medium: "中", high: "高", urgent: "紧急" }[priority];
}

function priorityTemplate(
  priority: ChannelNotification["priority"],
): "blue" | "orange" | "red" {
  if (priority === "urgent") {
    return "red";
  }
  return priority === "high" ? "orange" : "blue";
}
