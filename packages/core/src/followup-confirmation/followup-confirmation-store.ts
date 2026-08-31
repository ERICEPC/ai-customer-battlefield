import type {
  ActorScope,
  FollowupAgentExecutionReceipt,
} from "../followup-drafts/followup-draft-agent.js";

export type FollowupDraftStatus =
  | "pending_confirmation"
  | "confirmed"
  | "cancelled"
  | "expired";

export type FollowupType = "meeting" | "call" | "message" | "email" | "other";

export interface FollowupFactCandidate {
  factType: string;
  factValue: string;
}

export interface PersistentFollowupDraftCandidate {
  entityId: string;
  summary: string;
  occurredAt: string;
  followupType: FollowupType;
  relatedOpportunityIds: string[];
  primaryOpportunityId: string | null;
  facts: FollowupFactCandidate[];
}

export interface PersistentFollowupDraft {
  draftId: string;
  status: FollowupDraftStatus;
  rawInput: string;
  candidate: PersistentFollowupDraftCandidate;
  versionNo: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  cancelledAt: string | null;
  followupId: string | null;
  agentExecution?: FollowupAgentExecutionReceipt;
}

export interface FollowupConfirmationResult {
  draftId: string;
  status: "confirmed";
  followupId: string;
  eventId: string;
  versionNo: string;
  confirmedAt: string;
}

export interface FormalFollowupRecord {
  followupId: string;
  sourceDraftId: string;
  entityId: string;
  occurredAt: string;
  followupType: FollowupType;
  summary: string;
  submittedBy: string;
  confirmedBy: string;
  confirmedAt: string;
  relatedOpportunityIds: string[];
  primaryOpportunityId: string | null;
  facts: Array<{
    factType: string;
    factValue: string;
    opportunityId: string | null;
  }>;
}

export interface FollowupConfirmationStore {
  create(input: {
    actor: ActorScope;
    draftId: string;
    rawInput: string;
    candidate: PersistentFollowupDraftCandidate;
    agentExecution?: FollowupAgentExecutionReceipt;
    createdAt: string;
    expiresAt: string;
  }): Promise<PersistentFollowupDraft>;
  get(input: {
    actor: ActorScope;
    draftId: string;
  }): Promise<PersistentFollowupDraft>;
  revise(input: {
    actor: ActorScope;
    draftId: string;
    versionNo: string;
    candidate: PersistentFollowupDraftCandidate;
    changedAt: string;
  }): Promise<PersistentFollowupDraft>;
  cancel(input: {
    actor: ActorScope;
    draftId: string;
    versionNo: string;
    idempotencyKey: string;
    cancelledAt: string;
  }): Promise<PersistentFollowupDraft>;
  confirm(input: {
    actor: ActorScope;
    draftId: string;
    versionNo: string;
    idempotencyKey: string;
    confirmedAt: string;
  }): Promise<FollowupConfirmationResult>;
  getFollowup(input: {
    actor: ActorScope;
    followupId: string;
  }): Promise<FormalFollowupRecord>;
}

export class FollowupDraftNotFoundError extends Error {
  constructor() {
    super("Follow-up draft was not found.");
    this.name = "FollowupDraftNotFoundError";
  }
}

export class FollowupNotFoundError extends Error {
  constructor() {
    super("Formal follow-up was not found.");
    this.name = "FollowupNotFoundError";
  }
}

export class FollowupDraftVersionConflictError extends Error {
  constructor(readonly latestVersionNo: string) {
    super("Follow-up draft version is stale.");
    this.name = "FollowupDraftVersionConflictError";
  }
}

export class FollowupDraftNotPendingError extends Error {
  constructor(readonly status: FollowupDraftStatus) {
    super(`Follow-up draft is ${status}, not pending confirmation.`);
    this.name = "FollowupDraftNotPendingError";
  }
}

export class FollowupDraftExpiredError extends Error {
  constructor() {
    super("Follow-up draft has expired.");
    this.name = "FollowupDraftExpiredError";
  }
}

export class FollowupIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used for a different request.");
    this.name = "FollowupIdempotencyConflictError";
  }
}

export class FollowupRelatedRecordNotFoundError extends Error {
  constructor(readonly recordType: "entity" | "opportunity") {
    super(`Related ${recordType} was not found.`);
    this.name = "FollowupRelatedRecordNotFoundError";
  }
}
