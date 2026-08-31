import { describe, expect, it } from "vitest";

import {
  inboxPageSchema,
  inboxQuerySchema,
  markNotificationReadResponseSchema,
  notificationEventTypeSchema,
  notificationPrioritySchema,
} from "./notifications.js";

const notificationId = "f0000000-0000-4000-8000-000000000001";
const actionId = "d0000000-0000-4000-8000-000000000001";

function inboxItem() {
  return {
    notificationId,
    eventType: "action_due" as const,
    title: "经营动作已到计划时间",
    body: "确认下一步客户经营动作",
    deepLink: `/actions?actionId=${actionId}`,
    priority: "high" as const,
    createdAt: "2026-09-01T01:00:00.000Z",
    readAt: null,
  };
}

describe("notification contracts", () => {
  it("accepts action, weekly-report, and sales-progress event types", () => {
    expect(notificationEventTypeSchema.parse("action_due")).toBe("action_due");
    expect(notificationEventTypeSchema.parse("weekly_report_published")).toBe(
      "weekly_report_published",
    );
    expect(notificationEventTypeSchema.parse("sales_progress_updated")).toBe(
      "sales_progress_updated",
    );
  });
  it("coerces only explicit boolean query values and bounds pagination", () => {
    expect(inboxQuerySchema.parse({ unreadOnly: "true", limit: "50" })).toEqual(
      { unreadOnly: true, limit: 50 },
    );
    expect(inboxQuerySchema.parse({ unreadOnly: "false" })).toEqual({
      unreadOnly: false,
    });
    expect(inboxQuerySchema.safeParse({ unreadOnly: "1" }).success).toBe(false);
    expect(inboxQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(inboxQuerySchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("accepts plain-text inbox rows with safe application-relative links", () => {
    expect(
      inboxPageSchema.parse({ items: [inboxItem()], nextCursor: null }),
    ).toEqual({ items: [inboxItem()], nextCursor: null });
    expect(
      inboxPageSchema.safeParse({
        items: [{ ...inboxItem(), deepLink: "https://attacker.example/path" }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      inboxPageSchema.safeParse({
        items: [{ ...inboxItem(), title: "x".repeat(201) }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("keeps priority and idempotent mark-read receipts bounded", () => {
    expect(notificationPrioritySchema.parse("urgent")).toBe("urgent");
    expect(
      markNotificationReadResponseSchema.parse({
        notificationId,
        readAt: "2026-09-01T01:02:00.000Z",
      }),
    ).toEqual({
      notificationId,
      readAt: "2026-09-01T01:02:00.000Z",
    });
    expect(
      markNotificationReadResponseSchema.safeParse({
        notificationId,
        readAt: null,
      }).success,
    ).toBe(false);
  });
});
