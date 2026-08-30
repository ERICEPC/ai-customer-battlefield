import type {
  Clock,
  DraftIdGenerator,
} from "../followup-drafts/create-followup-draft.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type {
  ActionDecisionResult,
  ActionDecisionStore,
  ActionPriority,
  ActionTransitionResult,
  BusinessActionStatus,
} from "./action-decision-store.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const VERSION_PATTERN = /^[1-9]\d*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_PRIORITIES = new Set<string>(["low", "medium", "high", "urgent"]);
const ACTION_STATUSES = new Set<string>([
  "planned",
  "in_progress",
  "completed",
  "cancelled",
]);

export class InvalidActionIdempotencyKeyError extends Error {
  constructor() {
    super("Action idempotency key must contain 1 to 200 URL-safe characters.");
    this.name = "InvalidActionIdempotencyKeyError";
  }
}

export class InvalidActionDecisionError extends Error {
  constructor() {
    super("Action proposal decision is invalid.");
    this.name = "InvalidActionDecisionError";
  }
}

export class AcceptActionProposal {
  constructor(
    private readonly dependencies: {
      store: ActionDecisionStore;
      idGenerator: DraftIdGenerator;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    actor: ActorScope;
    proposalId: string;
    versionNo: string;
    idempotencyKey: string;
    title: string;
    description: string;
    ownerUserId: string;
    priority: ActionPriority;
    plannedAt: string;
  }): Promise<ActionDecisionResult> {
    assertIdempotencyKey(input.idempotencyKey);
    const decidedAt = this.dependencies.clock.now();
    const title = input.title.trim();
    const description = input.description.trim();
    const plannedAt = Date.parse(input.plannedAt);
    if (
      !VERSION_PATTERN.test(input.versionNo) ||
      !UUID_PATTERN.test(input.ownerUserId) ||
      !ACTION_PRIORITIES.has(input.priority) ||
      title.length === 0 ||
      title.length > 300 ||
      description.length === 0 ||
      description.length > 5_000 ||
      !Number.isFinite(plannedAt) ||
      plannedAt <= decidedAt.getTime()
    ) {
      throw new InvalidActionDecisionError();
    }

    return this.dependencies.store.accept({
      actor: input.actor,
      proposalId: input.proposalId,
      actionId: this.dependencies.idGenerator.next(),
      versionNo: input.versionNo,
      idempotencyKey: input.idempotencyKey,
      title,
      description,
      ownerUserId: input.ownerUserId,
      priority: input.priority,
      plannedAt: input.plannedAt,
      decidedAt: decidedAt.toISOString(),
    });
  }
}

export class RejectActionProposal {
  constructor(
    private readonly dependencies: {
      store: ActionDecisionStore;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    actor: ActorScope;
    proposalId: string;
    versionNo: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<ActionDecisionResult> {
    assertIdempotencyKey(input.idempotencyKey);
    const reason = input.reason.trim();
    if (
      !VERSION_PATTERN.test(input.versionNo) ||
      reason.length === 0 ||
      reason.length > 1_000
    ) {
      throw new InvalidActionDecisionError();
    }
    return this.dependencies.store.reject({
      actor: input.actor,
      proposalId: input.proposalId,
      versionNo: input.versionNo,
      idempotencyKey: input.idempotencyKey,
      reason,
      decidedAt: this.dependencies.clock.now().toISOString(),
    });
  }
}

export class TransitionBusinessAction {
  constructor(
    private readonly dependencies: {
      store: ActionDecisionStore;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    actor: ActorScope;
    actionId: string;
    versionNo: string;
    toStatus: BusinessActionStatus;
    reason?: string;
  }): Promise<ActionTransitionResult> {
    const reason = input.reason?.trim();
    if (
      !VERSION_PATTERN.test(input.versionNo) ||
      !ACTION_STATUSES.has(input.toStatus) ||
      (input.reason !== undefined &&
        (!reason || reason.length === 0 || reason.length > 1_000))
    ) {
      throw new InvalidActionDecisionError();
    }
    return this.dependencies.store.transition({
      actor: input.actor,
      actionId: input.actionId,
      versionNo: input.versionNo,
      toStatus: input.toStatus,
      ...(reason ? { reason } : {}),
      changedAt: this.dependencies.clock.now().toISOString(),
    });
  }
}

export function isAllowedActionTransition(
  fromStatus: BusinessActionStatus,
  toStatus: BusinessActionStatus,
): boolean {
  return (
    (fromStatus === "planned" &&
      (toStatus === "in_progress" || toStatus === "cancelled")) ||
    (fromStatus === "in_progress" &&
      (toStatus === "completed" || toStatus === "cancelled"))
  );
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new InvalidActionIdempotencyKeyError();
  }
}
