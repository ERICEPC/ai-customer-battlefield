import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type {
  ActionPriority,
  BusinessActionStatus,
} from "./action-decision-store.js";

export type ActionProposalStatus =
  | "pending_confirmation"
  | "accepted"
  | "rejected"
  | "expired";

export interface ActionProposalRecord {
  proposalId: string;
  entityId: string;
  entityName: string;
  opportunityId: string | null;
  title: string;
  description: string;
  suggestedOwnerId: string | null;
  suggestedOwnerName: string | null;
  suggestedPriority: ActionPriority;
  suggestedPlannedAt: string | null;
  sourceBattleStateVersionId: string;
  canDecide: boolean;
  status: ActionProposalStatus;
  versionNo: string;
  proposedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  actionId: string | null;
}

export interface BusinessActionRecord {
  actionId: string;
  entityId: string;
  entityName: string;
  opportunityId: string | null;
  title: string;
  description: string;
  ownerUserId: string;
  ownerName: string;
  priority: ActionPriority;
  status: BusinessActionStatus;
  plannedAt: string;
  completedAt: string | null;
  sourceProposalId: string;
  confirmedBy: string;
  confirmedAt: string;
  versionNo: string;
  canTransition: boolean;
}

export interface ActionProposalPage {
  items: ActionProposalRecord[];
  nextCursor: string | null;
}

export interface ActionOwnerOption {
  userId: string;
  displayName: string;
}

export interface BusinessActionPage {
  items: BusinessActionRecord[];
  nextCursor: string | null;
}

export interface ActionQueryReader {
  listOwners(input: {
    actor: ActorScope;
    entityId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    items: ActionOwnerOption[];
    nextCursor: string | null;
  }>;
  getProposal(input: {
    actor: ActorScope;
    proposalId: string;
  }): Promise<ActionProposalRecord>;
  listProposals(input: {
    actor: ActorScope;
    status?: ActionProposalStatus;
    priority?: ActionPriority;
    entityId?: string;
    cursor?: string;
    limit: number;
  }): Promise<ActionProposalPage>;
  getAction(input: {
    actor: ActorScope;
    actionId: string;
  }): Promise<BusinessActionRecord>;
  listActions(input: {
    actor: ActorScope;
    status?: BusinessActionStatus;
    priority?: ActionPriority;
    entityId?: string;
    ownerUserId?: string;
    cursor?: string;
    limit: number;
  }): Promise<BusinessActionPage>;
}

export class InvalidActionQueryCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super("The action query cursor is invalid.", options);
    this.name = "InvalidActionQueryCursorError";
  }
}
