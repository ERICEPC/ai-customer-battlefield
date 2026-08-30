import { retryDelayMs } from "../async-work/outbox-processor.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export type ReminderKind = "advance" | "due" | "overdue" | "escalation";
export type ReminderChannel = "in_app" | "feishu" | "email";

export interface ReminderPolicyNode {
  kind: ReminderKind;
  offsetMinutes: number;
  recipient: "owner";
  channels: ReminderChannel[];
}

export interface ReminderSchedulingContext {
  action: {
    actionId: string;
    ownerUserId: string;
    plannedAt: string;
    status: "planned" | "in_progress" | "completed" | "cancelled";
    versionNo: string;
  };
  policy: {
    policyVersionId: string;
    versionNo: string;
    nodes: ReminderPolicyNode[];
  };
}

export interface ClaimedReminder {
  reminderId: string;
  attemptCount: number;
  claimToken: string;
}

export interface ReminderStore {
  loadSchedulingContext(input: {
    actor: ActorScope;
    actionId: string;
    occurredAt: string;
  }): Promise<ReminderSchedulingContext | null>;
  schedule(input: {
    actor: ActorScope;
    actionId: string;
    actionVersionNo: string;
    policyVersionId: string;
    policyVersionNo: string;
    recipientUserId: string;
    kind: ReminderKind;
    remindAt: string;
    channels: ReminderChannel[];
    dedupeKey: string;
  }): Promise<void>;
  cancelOpenForAction(input: {
    actor: ActorScope;
    actionId: string;
    cancelledAt: string;
  }): Promise<number>;
  claimDueBatch(input: {
    actor: ActorScope;
    now: string;
    limit: number;
    leaseMs: number;
  }): Promise<ClaimedReminder[]>;
  materializeDueReminder(input: {
    actor: ActorScope;
    reminderId: string;
    claimToken: string;
    notifiedAt: string;
  }): Promise<void>;
  reschedule(input: {
    actor: ActorScope;
    reminderId: string;
    claimToken: string;
    attemptCount: number;
    availableAt: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
  deadLetter(input: {
    actor: ActorScope;
    reminderId: string;
    claimToken: string;
    attemptCount: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
}

export class InvalidReminderPolicyError extends Error {
  constructor() {
    super("The published reminder policy is invalid.");
    this.name = "InvalidReminderPolicyError";
  }
}

export class ScheduleActionReminders {
  constructor(private readonly dependencies: { store: ReminderStore }) {}

  async onActionAccepted(input: {
    actor: ActorScope;
    actionId: string;
    occurredAt: string;
  }): Promise<{ scheduled: number }> {
    const context = await this.dependencies.store.loadSchedulingContext(input);
    if (
      !context ||
      context.action.actionId !== input.actionId ||
      !["planned", "in_progress"].includes(context.action.status)
    ) {
      return { scheduled: 0 };
    }

    const plannedAt = Date.parse(context.action.plannedAt);
    if (!Number.isFinite(plannedAt)) {
      throw new InvalidReminderPolicyError();
    }

    let scheduled = 0;
    for (const node of context.policy.nodes) {
      if (
        node.recipient !== "owner" ||
        !Number.isInteger(node.offsetMinutes) ||
        node.channels.length === 0
      ) {
        throw new InvalidReminderPolicyError();
      }
      await this.dependencies.store.schedule({
        actor: input.actor,
        actionId: context.action.actionId,
        actionVersionNo: context.action.versionNo,
        policyVersionId: context.policy.policyVersionId,
        policyVersionNo: context.policy.versionNo,
        recipientUserId: context.action.ownerUserId,
        kind: node.kind,
        remindAt: new Date(
          plannedAt + node.offsetMinutes * 60_000,
        ).toISOString(),
        channels: [...new Set(node.channels)],
        dedupeKey: `action:${context.action.actionId}:policy:${context.policy.versionNo}:${node.kind}:owner:${context.action.ownerUserId}`,
      });
      scheduled += 1;
    }
    return { scheduled };
  }
}

export class CancelActionReminders {
  constructor(private readonly dependencies: { store: ReminderStore }) {}

  async execute(input: {
    actor: ActorScope;
    actionId: string;
    changedAt: string;
  }): Promise<{ cancelled: number }> {
    return {
      cancelled: await this.dependencies.store.cancelOpenForAction({
        actor: input.actor,
        actionId: input.actionId,
        cancelledAt: input.changedAt,
      }),
    };
  }
}

export class DispatchDueReminders {
  constructor(
    private readonly dependencies: {
      store: ReminderStore;
      clock: { now(): Date };
    },
  ) {}

  async runOnce(input: {
    actor: ActorScope;
    limit: number;
    leaseMs: number;
  }): Promise<{
    claimed: number;
    notified: number;
    rescheduled: number;
    deadLettered: number;
  }> {
    const now = this.dependencies.clock.now();
    const reminders = await this.dependencies.store.claimDueBatch({
      actor: input.actor,
      now: now.toISOString(),
      limit: input.limit,
      leaseMs: input.leaseMs,
    });
    const result = {
      claimed: reminders.length,
      notified: 0,
      rescheduled: 0,
      deadLettered: 0,
    };
    for (const reminder of reminders) {
      try {
        await this.dependencies.store.materializeDueReminder({
          actor: input.actor,
          reminderId: reminder.reminderId,
          claimToken: reminder.claimToken,
          notifiedAt: now.toISOString(),
        });
        result.notified += 1;
      } catch {
        if (reminder.attemptCount >= 8) {
          await this.dependencies.store.deadLetter({
            actor: input.actor,
            reminderId: reminder.reminderId,
            claimToken: reminder.claimToken,
            attemptCount: reminder.attemptCount,
            errorCode: "REMINDER_ATTEMPTS_EXHAUSTED",
            errorMessage: "Reminder automatic retry attempts are exhausted.",
          });
          result.deadLettered += 1;
        } else {
          await this.dependencies.store.reschedule({
            actor: input.actor,
            reminderId: reminder.reminderId,
            claimToken: reminder.claimToken,
            attemptCount: reminder.attemptCount,
            availableAt: new Date(
              now.getTime() + retryDelayMs(reminder.attemptCount),
            ).toISOString(),
            errorCode: "REMINDER_MATERIALIZATION_FAILED",
            errorMessage: "Reminder materialization failed.",
          });
          result.rescheduled += 1;
        }
      }
    }
    return result;
  }
}
