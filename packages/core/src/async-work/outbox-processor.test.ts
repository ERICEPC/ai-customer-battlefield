import { describe, expect, it } from "vitest";

import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import {
  type OutboxMessage,
  type OutboxStore,
  ProcessOutboxBatch,
} from "./outbox-processor.js";

const actor: ActorScope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const now = new Date("2026-09-01T01:00:00.000Z");

function message(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    messageId: "70000000-0000-4000-8000-000000000001",
    topic: "action_proposal.accepted.v1",
    aggregateType: "business_action",
    aggregateId: "d0000000-0000-4000-8000-000000000001",
    payload: { actionId: "d0000000-0000-4000-8000-000000000001" },
    occurredAt: "2026-09-01T00:59:00.000Z",
    attemptCount: 1,
    claimToken: "claim-1",
    ...overrides,
  };
}

function memoryStore(messages: OutboxMessage[]) {
  const events: Array<Record<string, unknown>> = [];
  const store: OutboxStore = {
    async claimBatch(input) {
      events.push({ type: "claimed", ...input });
      return messages;
    },
    async markPublished(input) {
      events.push({ type: "published", ...input });
    },
    async reschedule(input) {
      events.push({ type: "rescheduled", ...input });
    },
    async deadLetter(input) {
      events.push({ type: "dead_lettered", ...input });
    },
  };
  return { events, store };
}

describe("outbox processor", () => {
  it("reschedules a transient failure and never acknowledges it", async () => {
    const { events, store } = memoryStore([message()]);
    const processor = new ProcessOutboxBatch({
      store,
      clock: { now: () => now },
      handlers: {
        "action_proposal.accepted.v1": {
          handle: async () => {
            throw new Error("provider leaked detail");
          },
        },
      },
    });

    expect(
      await processor.runOnce({ actor, limit: 50, leaseMs: 60_000 }),
    ).toEqual({ claimed: 1, published: 0, rescheduled: 1, deadLettered: 0 });
    expect(events).toContainEqual({
      type: "rescheduled",
      actor,
      messageId: "70000000-0000-4000-8000-000000000001",
      claimToken: "claim-1",
      attemptCount: 1,
      availableAt: "2026-09-01T01:01:00.000Z",
      errorCode: "OUTBOX_HANDLER_FAILED",
      errorMessage: "Outbox handler failed.",
    });
    expect(events.some((event) => event.type === "published")).toBe(false);
  });

  it("dead-letters an unknown topic and continues with later rows", async () => {
    const { events, store } = memoryStore([
      message({
        messageId: "70000000-0000-4000-8000-000000000002",
        topic: "unknown.v1",
      }),
      message({
        messageId: "70000000-0000-4000-8000-000000000003",
        claimToken: "claim-3",
      }),
    ]);
    const handled: string[] = [];
    const processor = new ProcessOutboxBatch({
      store,
      clock: { now: () => now },
      handlers: {
        "action_proposal.accepted.v1": {
          handle: async (item) => {
            handled.push(item.messageId);
          },
        },
      },
    });

    expect(
      await processor.runOnce({ actor, limit: 50, leaseMs: 60_000 }),
    ).toEqual({ claimed: 2, published: 1, rescheduled: 0, deadLettered: 1 });
    expect(handled).toEqual(["70000000-0000-4000-8000-000000000003"]);
    expect(events).toContainEqual({
      type: "dead_lettered",
      actor,
      messageId: "70000000-0000-4000-8000-000000000002",
      claimToken: "claim-1",
      attemptCount: 1,
      errorCode: "UNKNOWN_OUTBOX_TOPIC",
      errorMessage: "No handler is registered for this Outbox topic.",
    });
  });
});
