import { describe, expect, it } from "vitest";

import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import {
  CancelActionReminders,
  DispatchDueReminders,
  type ReminderStore,
  ScheduleActionReminders,
} from "./reminder-scheduler.js";

const actor: ActorScope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const actionId = "d0000000-0000-4000-8000-000000000001";
const ownerUserId = "30000000-0000-4000-8000-000000000002";

function memoryStore(status: "planned" | "completed" = "planned") {
  const scheduled: unknown[] = [];
  const store: ReminderStore = {
    async loadSchedulingContext() {
      return {
        action: {
          actionId,
          ownerUserId,
          plannedAt: "2026-09-03T09:00:00.000Z",
          status,
          versionNo: "1",
        },
        policy: {
          policyVersionId: "71000000-0000-4000-8000-000000000001",
          versionNo: "1",
          nodes: [
            {
              kind: "due",
              offsetMinutes: 0,
              recipient: "owner",
              channels: ["in_app", "feishu"],
            },
          ],
        },
      };
    },
    async schedule(input) {
      scheduled.push(input);
    },
    async cancelOpenForAction() {
      return 0;
    },
    async claimDueBatch() {
      return [];
    },
    async materializeDueReminder() {},
    async reschedule() {},
    async deadLetter() {},
  };
  return { scheduled, store };
}

describe("action reminder scheduler", () => {
  it("schedules a formal action with a stable policy-node dedupe key", async () => {
    const { scheduled, store } = memoryStore();
    const scheduler = new ScheduleActionReminders({ store });

    expect(
      await scheduler.onActionAccepted({
        actor,
        actionId,
        occurredAt: "2026-09-01T01:00:00.000Z",
      }),
    ).toEqual({ scheduled: 1 });
    expect(scheduled).toEqual([
      {
        actor,
        actionId,
        actionVersionNo: "1",
        policyVersionId: "71000000-0000-4000-8000-000000000001",
        policyVersionNo: "1",
        recipientUserId: ownerUserId,
        kind: "due",
        remindAt: "2026-09-03T09:00:00.000Z",
        channels: ["in_app", "feishu"],
        dedupeKey: `action:${actionId}:policy:1:due:owner:${ownerUserId}`,
      },
    ]);
  });

  it("does not schedule a terminal action even if an event is replayed", async () => {
    const { scheduled, store } = memoryStore("completed");
    const scheduler = new ScheduleActionReminders({ store });

    expect(
      await scheduler.onActionAccepted({
        actor,
        actionId,
        occurredAt: "2026-09-01T01:00:00.000Z",
      }),
    ).toEqual({ scheduled: 0 });
    expect(scheduled).toEqual([]);
  });

  it("cancels open reminders when a formal action becomes terminal", async () => {
    const { store } = memoryStore();
    const cancellations: unknown[] = [];
    store.cancelOpenForAction = async (input) => {
      cancellations.push(input);
      return 2;
    };
    const subject = new CancelActionReminders({ store });

    expect(
      await subject.execute({
        actor,
        actionId,
        changedAt: "2026-09-01T01:00:00.000Z",
      }),
    ).toEqual({ cancelled: 2 });
    expect(cancellations).toEqual([
      {
        actor,
        actionId,
        cancelledAt: "2026-09-01T01:00:00.000Z",
      },
    ]);
  });

  it("materializes each claimed due reminder without exposing failure details", async () => {
    const { store } = memoryStore();
    const events: Array<Record<string, unknown>> = [];
    store.claimDueBatch = async () => [
      {
        reminderId: "72000000-0000-4000-8000-000000000001",
        attemptCount: 1,
        claimToken: "first",
      },
      {
        reminderId: "72000000-0000-4000-8000-000000000002",
        attemptCount: 1,
        claimToken: "second",
      },
    ];
    store.materializeDueReminder = async (input) => {
      if (input.claimToken === "first") {
        events.push({ type: "notified", ...input });
        return;
      }
      throw new Error("database detail that must not be persisted");
    };
    store.reschedule = async (input) => {
      events.push({ type: "rescheduled", ...input });
    };
    const subject = new DispatchDueReminders({
      store,
      clock: { now: () => new Date("2026-09-01T01:00:00.000Z") },
    });

    expect(
      await subject.runOnce({ actor, limit: 50, leaseMs: 60_000 }),
    ).toEqual({
      claimed: 2,
      notified: 1,
      rescheduled: 1,
      deadLettered: 0,
    });
    expect(events).toContainEqual({
      type: "rescheduled",
      actor,
      reminderId: "72000000-0000-4000-8000-000000000002",
      claimToken: "second",
      attemptCount: 1,
      availableAt: "2026-09-01T01:01:00.000Z",
      errorCode: "REMINDER_MATERIALIZATION_FAILED",
      errorMessage: "Reminder materialization failed.",
    });
  });
});
