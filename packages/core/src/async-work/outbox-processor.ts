import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

const MAX_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1_000;

export interface OutboxMessage {
  messageId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: string;
  attemptCount: number;
  claimToken: string;
}

interface OutboxClaimInput {
  actor: ActorScope;
  now: string;
  limit: number;
  leaseMs: number;
}

interface OutboxCompletionInput {
  actor: ActorScope;
  messageId: string;
  claimToken: string;
}

interface OutboxFailureInput extends OutboxCompletionInput {
  attemptCount: number;
  errorCode: string;
  errorMessage: string;
}

export interface OutboxStore {
  claimBatch(input: OutboxClaimInput): Promise<OutboxMessage[]>;
  markPublished(input: OutboxCompletionInput): Promise<void>;
  reschedule(
    input: OutboxFailureInput & { availableAt: string },
  ): Promise<void>;
  deadLetter(input: OutboxFailureInput): Promise<void>;
}

export interface OutboxTopicHandler {
  handle(message: OutboxMessage, actor: ActorScope): Promise<void>;
}

export class PermanentOutboxError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "PermanentOutboxError";
  }
}

export class ProcessOutboxBatch {
  constructor(
    private readonly dependencies: {
      store: OutboxStore;
      handlers: Readonly<Record<string, OutboxTopicHandler>>;
      clock: { now(): Date };
    },
  ) {}

  async runOnce(input: {
    actor: ActorScope;
    limit: number;
    leaseMs: number;
  }): Promise<{
    claimed: number;
    published: number;
    rescheduled: number;
    deadLettered: number;
  }> {
    const now = this.dependencies.clock.now();
    const messages = await this.dependencies.store.claimBatch({
      actor: input.actor,
      now: now.toISOString(),
      limit: input.limit,
      leaseMs: input.leaseMs,
    });
    const result = {
      claimed: messages.length,
      published: 0,
      rescheduled: 0,
      deadLettered: 0,
    };

    for (const message of messages) {
      const handler = this.dependencies.handlers[message.topic];
      if (!handler) {
        await this.deadLetterUnknownTopic(input.actor, message);
        result.deadLettered += 1;
        continue;
      }

      try {
        await handler.handle(message, input.actor);
        await this.dependencies.store.markPublished({
          actor: input.actor,
          messageId: message.messageId,
          claimToken: message.claimToken,
        });
        result.published += 1;
      } catch (error) {
        if (
          error instanceof PermanentOutboxError ||
          message.attemptCount >= MAX_ATTEMPTS
        ) {
          await this.dependencies.store.deadLetter({
            actor: input.actor,
            messageId: message.messageId,
            claimToken: message.claimToken,
            attemptCount: message.attemptCount,
            errorCode:
              error instanceof PermanentOutboxError
                ? error.code
                : "OUTBOX_ATTEMPTS_EXHAUSTED",
            errorMessage:
              error instanceof PermanentOutboxError
                ? error.safeMessage
                : "Outbox automatic retry attempts are exhausted.",
          });
          result.deadLettered += 1;
          continue;
        }

        await this.dependencies.store.reschedule({
          actor: input.actor,
          messageId: message.messageId,
          claimToken: message.claimToken,
          attemptCount: message.attemptCount,
          availableAt: new Date(
            now.getTime() + retryDelayMs(message.attemptCount),
          ).toISOString(),
          errorCode: "OUTBOX_HANDLER_FAILED",
          errorMessage: "Outbox handler failed.",
        });
        result.rescheduled += 1;
      }
    }

    return result;
  }

  private async deadLetterUnknownTopic(
    actor: ActorScope,
    message: OutboxMessage,
  ): Promise<void> {
    await this.dependencies.store.deadLetter({
      actor,
      messageId: message.messageId,
      claimToken: message.claimToken,
      attemptCount: message.attemptCount,
      errorCode: "UNKNOWN_OUTBOX_TOPIC",
      errorMessage: "No handler is registered for this Outbox topic.",
    });
  }
}

export function retryDelayMs(attemptCount: number): number {
  return Math.min(2 ** attemptCount * 30_000, MAX_RETRY_DELAY_MS);
}
