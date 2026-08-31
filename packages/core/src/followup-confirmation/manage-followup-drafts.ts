import type {
  Clock,
  DraftIdGenerator,
} from "../followup-drafts/create-followup-draft.js";
import { InvalidRawInputError } from "../followup-drafts/errors.js";
import type {
  ActorScope,
  FollowupDraftAgent,
} from "../followup-drafts/followup-draft-agent.js";
import type {
  FollowupConfirmationResult,
  FollowupConfirmationStore,
  FormalFollowupRecord,
  PersistentFollowupDraft,
  PersistentFollowupDraftCandidate,
} from "./followup-confirmation-store.js";

const DRAFT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class InvalidIdempotencyKeyError extends Error {
  constructor() {
    super("Idempotency key must contain 1 to 200 URL-safe characters.");
    this.name = "InvalidIdempotencyKeyError";
  }
}

export class InvalidFollowupDraftCandidateError extends Error {
  constructor() {
    super("Follow-up draft candidate is invalid.");
    this.name = "InvalidFollowupDraftCandidateError";
  }
}

export class CreatePersistentFollowupDraft {
  constructor(
    private readonly dependencies: {
      agent: FollowupDraftAgent;
      store: FollowupConfirmationStore;
      idGenerator: DraftIdGenerator;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    actor: ActorScope;
    entityId: string;
    rawInput: string;
    occurredAt?: string;
  }): Promise<PersistentFollowupDraft> {
    const rawInput = input.rawInput.trim();
    if (rawInput.length === 0 || rawInput.length > 10_000) {
      throw new InvalidRawInputError();
    }

    const now = this.dependencies.clock.now();
    const occurredAt = input.occurredAt ?? now.toISOString();
    if (!Number.isFinite(Date.parse(occurredAt))) {
      throw new InvalidFollowupDraftCandidateError();
    }
    const proposal = await this.dependencies.agent.propose({
      actor: input.actor,
      entityId: input.entityId,
      rawInput,
      occurredAt,
    });
    const candidate = normalizeCandidate({
      entityId: input.entityId,
      occurredAt,
      summary: proposal.summary,
      ...(proposal.followupType ? { followupType: proposal.followupType } : {}),
      relatedOpportunityIds: proposal.relatedOpportunityIds,
      primaryOpportunityId: proposal.primaryOpportunityId ?? null,
      facts: proposal.facts ?? [],
    });
    const createdAt = now.toISOString();

    return this.dependencies.store.create({
      actor: input.actor,
      draftId: this.dependencies.idGenerator.next(),
      rawInput,
      candidate,
      ...(proposal.agentExecution
        ? { agentExecution: proposal.agentExecution }
        : {}),
      createdAt,
      expiresAt: new Date(now.getTime() + DRAFT_LIFETIME_MS).toISOString(),
    });
  }
}

export class GetFollowupDraft {
  constructor(private readonly store: FollowupConfirmationStore) {}

  async execute(input: {
    actor: ActorScope;
    draftId: string;
  }): Promise<PersistentFollowupDraft> {
    return this.store.get(input);
  }
}

export class GetFormalFollowup {
  constructor(private readonly store: FollowupConfirmationStore) {}

  async execute(input: {
    actor: ActorScope;
    followupId: string;
  }): Promise<FormalFollowupRecord> {
    return this.store.getFollowup(input);
  }
}

export class ReviseFollowupDraft {
  constructor(private readonly store: FollowupConfirmationStore) {}

  async execute(input: {
    actor: ActorScope;
    draftId: string;
    versionNo: string;
    candidate: PersistentFollowupDraftCandidate;
    changedAt: string;
  }): Promise<PersistentFollowupDraft> {
    return this.store.revise({
      ...input,
      candidate: normalizeCandidate(input.candidate),
    });
  }
}

export class CancelFollowupDraft {
  constructor(private readonly store: FollowupConfirmationStore) {}

  async execute(input: {
    actor: ActorScope;
    draftId: string;
    versionNo: string;
    idempotencyKey: string;
    cancelledAt: string;
  }): Promise<PersistentFollowupDraft> {
    assertIdempotencyKey(input.idempotencyKey);
    return await this.store.cancel(input);
  }
}

export class ConfirmFollowupDraft {
  constructor(private readonly store: FollowupConfirmationStore) {}

  async execute(input: {
    actor: ActorScope;
    draftId: string;
    versionNo: string;
    idempotencyKey: string;
    confirmedAt: string;
  }): Promise<FollowupConfirmationResult> {
    assertIdempotencyKey(input.idempotencyKey);
    return await this.store.confirm(input);
  }
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new InvalidIdempotencyKeyError();
  }
}

function normalizeCandidate(input: {
  entityId: string;
  summary: string;
  occurredAt: string;
  followupType?: PersistentFollowupDraftCandidate["followupType"];
  relatedOpportunityIds: string[];
  primaryOpportunityId: string | null;
  facts: Array<{ factType: string; factValue: string }>;
}): PersistentFollowupDraftCandidate {
  const summary = input.summary.trim();
  const relatedOpportunityIds = [...new Set(input.relatedOpportunityIds)];
  const facts = input.facts.map((fact) => ({
    factType: fact.factType.trim(),
    factValue: fact.factValue.trim(),
  }));
  if (
    summary.length === 0 ||
    summary.length > 5_000 ||
    relatedOpportunityIds.length !== input.relatedOpportunityIds.length ||
    (input.primaryOpportunityId !== null &&
      !relatedOpportunityIds.includes(input.primaryOpportunityId)) ||
    (relatedOpportunityIds.length > 1 && !input.primaryOpportunityId) ||
    facts.some(
      (fact) =>
        !/^[a-z][a-z0-9_.-]{0,99}$/.test(fact.factType) ||
        fact.factValue.length === 0 ||
        fact.factValue.length > 5_000,
    )
  ) {
    throw new InvalidFollowupDraftCandidateError();
  }

  return {
    entityId: input.entityId,
    summary,
    occurredAt: input.occurredAt,
    followupType: input.followupType ?? "other",
    relatedOpportunityIds,
    primaryOpportunityId: input.primaryOpportunityId,
    facts,
  };
}
