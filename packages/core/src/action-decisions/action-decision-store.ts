import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export type ActionPriority = "low" | "medium" | "high" | "urgent";
export type BusinessActionStatus =
  | "planned"
  | "in_progress"
  | "completed"
  | "cancelled";

export type ActionDecisionResult =
  | {
      proposalId: string;
      status: "accepted";
      actionId: string;
      versionNo: string;
      decidedAt: string;
    }
  | {
      proposalId: string;
      status: "rejected";
      actionId: null;
      versionNo: string;
      decidedAt: string;
    };

export interface ActionTransitionResult {
  actionId: string;
  status: BusinessActionStatus;
  versionNo: string;
  changedAt: string;
}

export interface ActionDecisionStore {
  accept(input: {
    actor: ActorScope;
    proposalId: string;
    actionId: string;
    versionNo: string;
    idempotencyKey: string;
    title: string;
    description: string;
    ownerUserId: string;
    priority: ActionPriority;
    plannedAt: string;
    decidedAt: string;
  }): Promise<ActionDecisionResult>;
  reject(input: {
    actor: ActorScope;
    proposalId: string;
    versionNo: string;
    idempotencyKey: string;
    reason: string;
    decidedAt: string;
  }): Promise<ActionDecisionResult>;
  transition(input: {
    actor: ActorScope;
    actionId: string;
    versionNo: string;
    toStatus: BusinessActionStatus;
    reason?: string;
    changedAt: string;
  }): Promise<ActionTransitionResult>;
}

export class ActionProposalNotFoundError extends Error {
  constructor() {
    super("Action proposal was not found.");
    this.name = "ActionProposalNotFoundError";
  }
}

export class ActionProposalVersionConflictError extends Error {
  constructor(readonly latestVersionNo: string) {
    super("Action proposal version is stale.");
    this.name = "ActionProposalVersionConflictError";
  }
}

export class ActionProposalNotPendingError extends Error {
  constructor(readonly status: string) {
    super(`Action proposal is ${status}, not pending confirmation.`);
    this.name = "ActionProposalNotPendingError";
  }
}

export class ActionProposalExpiredError extends Error {
  constructor() {
    super("Action proposal has expired.");
    this.name = "ActionProposalExpiredError";
  }
}

export class ActionIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used for a different action decision.");
    this.name = "ActionIdempotencyConflictError";
  }
}

export class BusinessActionNotFoundError extends Error {
  constructor() {
    super("Business action was not found.");
    this.name = "BusinessActionNotFoundError";
  }
}

export class BusinessActionVersionConflictError extends Error {
  constructor(readonly latestVersionNo: string) {
    super("Business action version is stale.");
    this.name = "BusinessActionVersionConflictError";
  }
}

export class InvalidBusinessActionTransitionError extends Error {
  constructor(
    readonly fromStatus: BusinessActionStatus,
    readonly toStatus: BusinessActionStatus,
  ) {
    super(
      `Business action cannot transition from ${fromStatus} to ${toStatus}.`,
    );
    this.name = "InvalidBusinessActionTransitionError";
  }
}
