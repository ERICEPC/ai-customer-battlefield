import { describe, expect, it } from "vitest";

import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import {
  type NotificationChannel,
  NotificationDelivery,
  type NotificationStore,
} from "./notification-delivery.js";

const actor: ActorScope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const deliveryId = "73000000-0000-4000-8000-000000000001";
const notificationId = "f0000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-01T01:00:00.000Z");

describe("external notification delivery", () => {
  it("claims persisted notification content before sending and records metadata", async () => {
    const events: string[] = [];
    const store: NotificationStore = {
      async claimDelivery() {
        events.push("claimed");
        return {
          deliveryId,
          notificationId,
          channel: "feishu",
          recipientAddress: "ou_synthetic",
          title: "经营动作已到计划时间",
          body: "确认下一步客户经营动作",
          deepLink: "/actions?actionId=d0000000-0000-4000-8000-000000000001",
          priority: "high",
          createdAt: "2026-09-01T00:59:00.000Z",
          dedupeKey: "delivery:synthetic",
          attemptCount: 1,
          claimToken: "delivery-claim",
        };
      },
      async markDelivered(input) {
        events.push(`delivered:${input.providerMessageId}`);
      },
      async reschedule() {
        events.push("rescheduled");
      },
      async deadLetter() {
        events.push("dead_lettered");
      },
    };
    const channel: NotificationChannel = {
      channel: "feishu",
      async send() {
        events.push("sent");
        return {
          providerMessageId: "om_synthetic",
          providerRequestId: "log_synthetic",
        };
      },
    };
    const delivery = new NotificationDelivery({
      store,
      channels: [channel],
      clock: { now: () => now },
    });

    expect(
      await delivery.deliver({ actor, deliveryId, leaseMs: 60_000 }),
    ).toEqual({ status: "delivered" });
    expect(events).toEqual(["claimed", "sent", "delivered:om_synthetic"]);
  });

  it("dead-letters a persisted delivery whose channel is not registered", async () => {
    const events: Array<Record<string, unknown>> = [];
    const store: NotificationStore = {
      async claimDelivery() {
        return {
          deliveryId,
          notificationId,
          channel: "email",
          recipientAddress: "synthetic@example.invalid",
          title: "经营动作已到计划时间",
          body: "确认下一步客户经营动作",
          deepLink: "/actions",
          priority: "high",
          createdAt: "2026-09-01T00:59:00.000Z",
          dedupeKey: "delivery:synthetic",
          attemptCount: 1,
          claimToken: "delivery-claim",
        };
      },
      async markDelivered() {},
      async reschedule() {},
      async deadLetter(input) {
        events.push(input);
      },
    };
    const delivery = new NotificationDelivery({
      store,
      channels: [],
      clock: { now: () => now },
    });

    expect(
      await delivery.deliver({ actor, deliveryId, leaseMs: 60_000 }),
    ).toEqual({ status: "dead_lettered" });
    expect(events).toEqual([
      {
        actor,
        deliveryId,
        claimToken: "delivery-claim",
        attemptCount: 1,
        errorCode: "NOTIFICATION_CHANNEL_UNAVAILABLE",
        errorMessage: "The configured notification channel is unavailable.",
      },
    ]);
  });
});
