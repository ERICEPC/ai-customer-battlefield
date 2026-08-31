import {
  CancelActionReminders,
  DispatchDueReminders,
  type NotificationChannel,
  NotificationDelivery,
  type OutboxMessage,
  type OutboxTopicHandler,
  PermanentOutboxError,
  ProcessOutboxBatch,
  ScheduleActionReminders,
} from "@battlefield/core";
import {
  type BattlefieldDatabase,
  KyselyNotificationStore,
  KyselyOutboxStore,
  KyselyReminderStore,
} from "@battlefield/database";
import type { Kysely } from "kysely";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RecoveryPort {
  recoverExpiredClaims(input: {
    actor: { tenantId: string; userId: string };
    expiredBefore: string;
    availableAt: string;
  }): Promise<{ recovered: number }>;
}

interface OutboxProcessorPort {
  runOnce(input: {
    actor: { tenantId: string; userId: string };
    limit: number;
    leaseMs: number;
  }): Promise<{
    claimed: number;
    published: number;
    rescheduled: number;
    deadLettered: number;
  }>;
}

interface ReminderDispatcherPort {
  runOnce(input: {
    actor: { tenantId: string; userId: string };
    limit: number;
    leaseMs: number;
  }): Promise<{
    claimed: number;
    notified: number;
    cancelled: number;
    rescheduled: number;
    deadLettered: number;
  }>;
}

interface DeliveryQueuePort {
  listAvailableDeliveryIds(input: {
    actor: { tenantId: string; userId: string };
    now: string;
    limit: number;
  }): Promise<string[]>;
}

interface NotificationDeliveryPort {
  deliver(input: {
    actor: { tenantId: string; userId: string };
    deliveryId: string;
    leaseMs: number;
  }): Promise<{
    status: "not_found" | "delivered" | "rescheduled" | "dead_lettered";
  }>;
}

export interface WorkerTickResult {
  recovered: number;
  claimed: number;
  completed: number;
  failed: number;
}

export class ReminderWorker {
  constructor(
    private readonly dependencies: {
      actor: { tenantId: string; userId: string };
      batchSize: number;
      leaseMs: number;
      clock: { now(): Date };
      outboxRecovery: RecoveryPort;
      reminderRecovery: RecoveryPort;
      deliveryRecovery: RecoveryPort;
      outboxProcessor: OutboxProcessorPort;
      reminderDispatcher: ReminderDispatcherPort;
      deliveryQueue: DeliveryQueuePort;
      notificationDelivery: NotificationDeliveryPort;
    },
  ) {}

  async tick(): Promise<WorkerTickResult> {
    const now = this.dependencies.clock.now();
    const availableAt = now.toISOString();
    const expiredBefore = new Date(
      now.getTime() - this.dependencies.leaseMs,
    ).toISOString();
    const recoveryInput = {
      actor: this.dependencies.actor,
      expiredBefore,
      availableAt,
    };
    const outboxRecovery =
      await this.dependencies.outboxRecovery.recoverExpiredClaims(
        recoveryInput,
      );
    const reminderRecovery =
      await this.dependencies.reminderRecovery.recoverExpiredClaims(
        recoveryInput,
      );
    const deliveryRecovery =
      await this.dependencies.deliveryRecovery.recoverExpiredClaims(
        recoveryInput,
      );
    const outbox = await this.dependencies.outboxProcessor.runOnce({
      actor: this.dependencies.actor,
      limit: this.dependencies.batchSize,
      leaseMs: this.dependencies.leaseMs,
    });
    const reminders = await this.dependencies.reminderDispatcher.runOnce({
      actor: this.dependencies.actor,
      limit: this.dependencies.batchSize,
      leaseMs: this.dependencies.leaseMs,
    });
    const deliveryIds =
      await this.dependencies.deliveryQueue.listAvailableDeliveryIds({
        actor: this.dependencies.actor,
        now: availableAt,
        limit: this.dependencies.batchSize,
      });
    let delivered = 0;
    let deliveryFailures = 0;
    for (const deliveryId of deliveryIds) {
      const result = await this.dependencies.notificationDelivery.deliver({
        actor: this.dependencies.actor,
        deliveryId,
        leaseMs: this.dependencies.leaseMs,
      });
      if (result.status === "delivered") {
        delivered += 1;
      } else if (result.status !== "not_found") {
        deliveryFailures += 1;
      }
    }
    return {
      recovered:
        outboxRecovery.recovered +
        reminderRecovery.recovered +
        deliveryRecovery.recovered,
      claimed: outbox.claimed + reminders.claimed + deliveryIds.length,
      completed:
        outbox.published + reminders.notified + reminders.cancelled + delivered,
      failed:
        outbox.rescheduled +
        outbox.deadLettered +
        reminders.rescheduled +
        reminders.deadLettered +
        deliveryFailures,
    };
  }
}

export function createOutboxHandlers(input: {
  scheduler: Pick<ScheduleActionReminders, "onActionAccepted">;
  canceller: Pick<CancelActionReminders, "execute">;
}): Readonly<Record<string, OutboxTopicHandler>> {
  return {
    "action_proposal.accepted.v1": {
      async handle(message, actor) {
        const payload = objectPayload(message);
        const actionId = uuidField(payload, "actionId");
        await input.scheduler.onActionAccepted({
          actor,
          actionId,
          occurredAt: message.occurredAt,
        });
      },
    },
    "business_action.status_changed.v1": {
      async handle(message, actor) {
        const payload = objectPayload(message);
        const actionId = uuidField(payload, "actionId");
        const status = payload.status;
        const changedAt = payload.changedAt;
        if (
          !["planned", "in_progress", "completed", "cancelled"].includes(
            String(status),
          ) ||
          typeof changedAt !== "string" ||
          !Number.isFinite(Date.parse(changedAt))
        ) {
          throw invalidPayload();
        }
        if (status === "completed" || status === "cancelled") {
          await input.canceller.execute({ actor, actionId, changedAt });
        }
      },
    },
    "action_proposal.rejected.v1": noOperationHandler(),
    "followup.confirmed.v1": noOperationHandler(),
  };
}

export function createReminderWorker(input: {
  database: Kysely<BattlefieldDatabase>;
  actor: { tenantId: string; userId: string };
  batchSize: number;
  leaseMs: number;
  clock?: { now(): Date };
  channels?: NotificationChannel[];
}): ReminderWorker {
  const clock = input.clock ?? { now: () => new Date() };
  const outboxStore = new KyselyOutboxStore(input.database);
  const channels = input.channels ?? [];
  const reminderStore = new KyselyReminderStore(input.database, {
    enabledExternalChannels: channels.map((channel) => channel.channel),
  });
  const notificationStore = new KyselyNotificationStore(input.database);
  const scheduler = new ScheduleActionReminders({ store: reminderStore });
  const canceller = new CancelActionReminders({ store: reminderStore });
  return new ReminderWorker({
    actor: input.actor,
    batchSize: input.batchSize,
    leaseMs: input.leaseMs,
    clock,
    outboxRecovery: outboxStore,
    reminderRecovery: reminderStore,
    deliveryRecovery: notificationStore,
    outboxProcessor: new ProcessOutboxBatch({
      store: outboxStore,
      handlers: createOutboxHandlers({ scheduler, canceller }),
      clock,
    }),
    reminderDispatcher: new DispatchDueReminders({
      store: reminderStore,
      clock,
    }),
    deliveryQueue: notificationStore,
    notificationDelivery: new NotificationDelivery({
      store: notificationStore,
      channels,
      clock,
    }),
  });
}

export async function runWorkerLoop(
  worker: Pick<ReminderWorker, "tick">,
  input: { signal: AbortSignal; idlePollMs: number; busyPollMs: number },
): Promise<void> {
  while (!input.signal.aborted) {
    const result = await worker.tick();
    if (input.signal.aborted) {
      break;
    }
    await wait(
      result.claimed === 0 ? input.idlePollMs : input.busyPollMs,
      input.signal,
    );
  }
}

function objectPayload(message: OutboxMessage): Record<string, unknown> {
  if (
    !message.payload ||
    typeof message.payload !== "object" ||
    Array.isArray(message.payload)
  ) {
    throw invalidPayload();
  }
  return message.payload as Record<string, unknown>;
}

function uuidField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalidPayload();
  }
  return value;
}

function invalidPayload(): PermanentOutboxError {
  return new PermanentOutboxError(
    "INVALID_OUTBOX_PAYLOAD",
    "The Outbox message payload is invalid.",
  );
}

function noOperationHandler(): OutboxTopicHandler {
  return { handle: async () => {} };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
