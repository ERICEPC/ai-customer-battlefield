import type { OutboxMessage } from "@battlefield/core";
import { describe, expect, test } from "vitest";

import { loadWorkerConfig } from "../src/config.js";
import {
  createOutboxHandlers,
  ReminderWorker,
  runWorkerLoop,
} from "../src/worker.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const actionId = "d0000000-0000-4000-8000-000000000001";

function message(
  topic: string,
  payload: Record<string, unknown>,
): OutboxMessage {
  return {
    messageId: "70000000-0000-4000-8000-000000000001",
    topic,
    aggregateType: "business_action",
    aggregateId: actionId,
    payload,
    occurredAt: "2026-09-01T00:00:00.000Z",
    attemptCount: 1,
    claimToken: "71000000-0000-4000-8000-000000000001",
  };
}

describe("reminder worker", () => {
  test("validates tenant-scoped bounded configuration", () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL: "postgresql://synthetic.invalid/battlefield",
        WORKER_TENANT_ID: actor.tenantId,
        WORKER_USER_ID: actor.userId,
        WORKER_BATCH_SIZE: "50",
        WORKER_IDLE_POLL_MS: "5000",
        WORKER_BUSY_POLL_MS: "50",
        WORKER_LEASE_MS: "60000",
      }),
    ).toMatchObject({
      actor,
      batchSize: 50,
      idlePollMs: 5_000,
      busyPollMs: 50,
      leaseMs: 60_000,
    });
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: "postgresql://synthetic.invalid/battlefield",
        WORKER_TENANT_ID: "all-tenants",
        WORKER_USER_ID: actor.userId,
      }),
    ).toThrow();
  });

  test("maps accepted and terminal action events without treating in-progress as terminal", async () => {
    const events: unknown[] = [];
    const handlers = createOutboxHandlers({
      scheduler: {
        async onActionAccepted(input) {
          events.push({ type: "scheduled", ...input });
          return { scheduled: 1 };
        },
      },
      canceller: {
        async execute(input) {
          events.push({ type: "cancelled", ...input });
          return { cancelled: 1 };
        },
      },
    });

    await handlers["action_proposal.accepted.v1"]?.handle(
      message("action_proposal.accepted.v1", { actionId }),
      actor,
    );
    await handlers["business_action.status_changed.v1"]?.handle(
      message("business_action.status_changed.v1", {
        actionId,
        status: "in_progress",
        changedAt: "2026-09-01T00:30:00.000Z",
      }),
      actor,
    );
    await handlers["business_action.status_changed.v1"]?.handle(
      message("business_action.status_changed.v1", {
        actionId,
        status: "completed",
        changedAt: "2026-09-01T00:40:00.000Z",
      }),
      actor,
    );

    expect(events).toEqual([
      {
        type: "scheduled",
        actor,
        actionId,
        occurredAt: "2026-09-01T00:00:00.000Z",
      },
      {
        type: "cancelled",
        actor,
        actionId,
        changedAt: "2026-09-01T00:40:00.000Z",
      },
    ]);
  });

  test("runs recovery, Outbox, due reminders, and external deliveries in one bounded tick", async () => {
    const events: string[] = [];
    const worker = new ReminderWorker({
      actor,
      batchSize: 50,
      leaseMs: 60_000,
      clock: { now: () => new Date("2026-09-01T01:00:00.000Z") },
      outboxRecovery: {
        async recoverExpiredClaims() {
          events.push("recover-outbox");
          return { recovered: 1 };
        },
      },
      reminderRecovery: {
        async recoverExpiredClaims() {
          events.push("recover-reminders");
          return { recovered: 1 };
        },
      },
      deliveryRecovery: {
        async recoverExpiredClaims() {
          events.push("recover-deliveries");
          return { recovered: 1 };
        },
      },
      outboxProcessor: {
        async runOnce() {
          events.push("outbox");
          return { claimed: 1, published: 1, rescheduled: 0, deadLettered: 0 };
        },
      },
      reminderDispatcher: {
        async runOnce() {
          events.push("reminders");
          return {
            claimed: 1,
            notified: 1,
            cancelled: 0,
            rescheduled: 0,
            deadLettered: 0,
          };
        },
      },
      deliveryQueue: {
        async listAvailableDeliveryIds() {
          events.push("list-deliveries");
          return [
            "73000000-0000-4000-8000-000000000001",
            "73000000-0000-4000-8000-000000000002",
          ];
        },
      },
      notificationDelivery: {
        async deliver(input) {
          events.push(`deliver:${input.deliveryId}`);
          return { status: "delivered" };
        },
      },
    });

    expect(await worker.tick()).toMatchObject({
      recovered: 3,
      claimed: 4,
      completed: 4,
    });
    expect(events).toEqual([
      "recover-outbox",
      "recover-reminders",
      "recover-deliveries",
      "outbox",
      "reminders",
      "list-deliveries",
      "deliver:73000000-0000-4000-8000-000000000001",
      "deliver:73000000-0000-4000-8000-000000000002",
    ]);
  });

  test("polling loop never overlaps ticks and stops on abort", async () => {
    const controller = new AbortController();
    let active = 0;
    let maximumActive = 0;
    let ticks = 0;
    const worker = {
      async tick() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        ticks += 1;
        active -= 1;
        if (ticks === 2) {
          controller.abort();
        }
        return { recovered: 0, claimed: 0, completed: 0, failed: 0 };
      },
    };

    await runWorkerLoop(worker, {
      signal: controller.signal,
      idlePollMs: 1,
      busyPollMs: 1,
    });
    expect({ ticks, maximumActive }).toEqual({ ticks: 2, maximumActive: 1 });
  });
});
