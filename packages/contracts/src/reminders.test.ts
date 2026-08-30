import { describe, expect, it } from "vitest";

import {
  reminderInstanceSchema,
  reminderKindSchema,
  reminderStatusSchema,
} from "./reminders.js";

const reminderId = "e0000000-0000-4000-8000-000000000001";
const actionId = "d0000000-0000-4000-8000-000000000001";
const recipientUserId = "30000000-0000-4000-8000-000000000001";

describe("reminder contracts", () => {
  it("accepts every versioned policy node kind and reminder status", () => {
    expect(
      ["advance", "due", "overdue", "escalation"].map((value) =>
        reminderKindSchema.parse(value),
      ),
    ).toEqual(["advance", "due", "overdue", "escalation"]);
    expect(
      [
        "scheduled",
        "processing",
        "notified",
        "failed",
        "cancelled",
        "dead_lettered",
      ].map((value) => reminderStatusSchema.parse(value)),
    ).toEqual([
      "scheduled",
      "processing",
      "notified",
      "failed",
      "cancelled",
      "dead_lettered",
    ]);
  });

  it("validates a bounded reminder projection and rejects unknown fields", () => {
    const reminder = {
      reminderId,
      actionId,
      recipientUserId,
      kind: "due" as const,
      remindAt: "2026-09-01T01:00:00.000Z",
      status: "scheduled" as const,
      policyVersion: "1",
    };

    expect(reminderInstanceSchema.parse(reminder)).toEqual(reminder);
    expect(
      reminderInstanceSchema.safeParse({ ...reminder, internalLease: "secret" })
        .success,
    ).toBe(false);
    expect(
      reminderInstanceSchema.safeParse({ ...reminder, policyVersion: "0" })
        .success,
    ).toBe(false);
  });
});
