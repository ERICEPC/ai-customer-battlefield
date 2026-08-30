import { retryDelayMs } from "../async-work/outbox-processor.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export type ExternalNotificationChannel = "feishu" | "email";
export type NotificationPriority = "low" | "medium" | "high" | "urgent";

export interface ChannelNotification {
  deliveryId: string;
  notificationId: string;
  recipientAddress: string;
  title: string;
  body: string;
  deepLink: string;
  priority: NotificationPriority;
  createdAt: string;
  dedupeKey: string;
}

export interface NotificationDeliveryClaim extends ChannelNotification {
  channel: ExternalNotificationChannel;
  attemptCount: number;
  claimToken: string;
}

export interface NotificationChannel {
  readonly channel: ExternalNotificationChannel;
  send(input: ChannelNotification): Promise<{
    providerMessageId: string;
    providerRequestId: string | null;
  }>;
}

export interface NotificationStore {
  claimDelivery(input: {
    actor: ActorScope;
    deliveryId: string;
    now: string;
    leaseMs: number;
  }): Promise<NotificationDeliveryClaim | null>;
  markDelivered(input: {
    actor: ActorScope;
    deliveryId: string;
    claimToken: string;
    providerMessageId: string;
    providerRequestId: string | null;
    deliveredAt: string;
  }): Promise<void>;
  reschedule(input: {
    actor: ActorScope;
    deliveryId: string;
    claimToken: string;
    attemptCount: number;
    availableAt: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
  deadLetter(input: {
    actor: ActorScope;
    deliveryId: string;
    claimToken: string;
    attemptCount: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
}

export class NotificationChannelError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(safeMessage);
    this.name = "NotificationChannelError";
  }
}

export class NotificationDelivery {
  private readonly channels: ReadonlyMap<
    ExternalNotificationChannel,
    NotificationChannel
  >;

  constructor(
    private readonly dependencies: {
      store: NotificationStore;
      channels: NotificationChannel[];
      clock: { now(): Date };
    },
  ) {
    this.channels = new Map(
      dependencies.channels.map((channel) => [channel.channel, channel]),
    );
  }

  async deliver(input: {
    actor: ActorScope;
    deliveryId: string;
    leaseMs: number;
  }): Promise<{
    status: "not_found" | "delivered" | "rescheduled" | "dead_lettered";
  }> {
    const now = this.dependencies.clock.now();
    const claim = await this.dependencies.store.claimDelivery({
      actor: input.actor,
      deliveryId: input.deliveryId,
      now: now.toISOString(),
      leaseMs: input.leaseMs,
    });
    if (!claim) {
      return { status: "not_found" };
    }
    const channel = this.channels.get(claim.channel);
    if (!channel) {
      await this.dependencies.store.deadLetter({
        actor: input.actor,
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        attemptCount: claim.attemptCount,
        errorCode: "NOTIFICATION_CHANNEL_UNAVAILABLE",
        errorMessage: "The configured notification channel is unavailable.",
      });
      return { status: "dead_lettered" };
    }

    try {
      const provider = await channel.send(toChannelNotification(claim));
      await this.dependencies.store.markDelivered({
        actor: input.actor,
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        providerMessageId: provider.providerMessageId,
        providerRequestId: provider.providerRequestId,
        deliveredAt: now.toISOString(),
      });
      return { status: "delivered" };
    } catch (error) {
      const classified =
        error instanceof NotificationChannelError
          ? error
          : new NotificationChannelError(
              "NOTIFICATION_PROVIDER_FAILED",
              "Notification provider request failed.",
              true,
            );
      if (!classified.retryable || claim.attemptCount >= 8) {
        await this.dependencies.store.deadLetter({
          actor: input.actor,
          deliveryId: claim.deliveryId,
          claimToken: claim.claimToken,
          attemptCount: claim.attemptCount,
          errorCode:
            claim.attemptCount >= 8
              ? "NOTIFICATION_ATTEMPTS_EXHAUSTED"
              : classified.code,
          errorMessage:
            claim.attemptCount >= 8
              ? "Notification automatic retry attempts are exhausted."
              : classified.safeMessage,
        });
        return { status: "dead_lettered" };
      }
      await this.dependencies.store.reschedule({
        actor: input.actor,
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        attemptCount: claim.attemptCount,
        availableAt: new Date(
          now.getTime() +
            (classified.retryAfterMs ?? retryDelayMs(claim.attemptCount)),
        ).toISOString(),
        errorCode: classified.code,
        errorMessage: classified.safeMessage,
      });
      return { status: "rescheduled" };
    }
  }
}

function toChannelNotification(
  claim: NotificationDeliveryClaim,
): ChannelNotification {
  return {
    deliveryId: claim.deliveryId,
    notificationId: claim.notificationId,
    recipientAddress: claim.recipientAddress,
    title: claim.title,
    body: claim.body,
    deepLink: claim.deepLink,
    priority: claim.priority,
    createdAt: claim.createdAt,
    dedupeKey: claim.dedupeKey,
  };
}
