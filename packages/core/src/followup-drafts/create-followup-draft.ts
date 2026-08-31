import { InvalidRawInputError } from "./errors.js";
import type { ActorScope, FollowupDraftAgent } from "./followup-draft-agent.js";

export interface DraftIdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

export interface FollowupDraft {
  draftId: string;
  status: "pending_confirmation";
  rawInput: string;
  candidate: {
    entityId: string;
    summary: string;
    occurredAt: string;
    followupType: "meeting" | "call" | "message" | "email" | "other";
    relatedOpportunityIds: string[];
    primaryOpportunityId: string | null;
    facts: Array<{ factType: string; factValue: string }>;
  };
  versionNo: "1";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  confirmedAt: null;
  confirmedBy: null;
  cancelledAt: null;
  followupId: null;
}

interface CreateFollowupDraftDependencies {
  agent: FollowupDraftAgent;
  idGenerator: DraftIdGenerator;
  clock: Clock;
}

export class CreateFollowupDraft {
  readonly #agent: FollowupDraftAgent;
  readonly #idGenerator: DraftIdGenerator;
  readonly #clock: Clock;

  constructor({ agent, idGenerator, clock }: CreateFollowupDraftDependencies) {
    this.#agent = agent;
    this.#idGenerator = idGenerator;
    this.#clock = clock;
  }

  async execute(input: {
    actor: ActorScope;
    entityId: string;
    rawInput: string;
    occurredAt?: string;
  }): Promise<FollowupDraft> {
    const rawInput = input.rawInput.trim();
    if (rawInput.length === 0 || rawInput.length > 10_000) {
      throw new InvalidRawInputError();
    }

    const now = this.#clock.now();
    const occurredAt = input.occurredAt ?? now.toISOString();
    const candidate = await this.#agent.propose({
      actor: input.actor,
      entityId: input.entityId,
      rawInput,
      occurredAt,
    });
    const createdAt = now.toISOString();

    return {
      draftId: this.#idGenerator.next(),
      status: "pending_confirmation",
      rawInput,
      candidate: {
        entityId: input.entityId,
        summary: candidate.summary,
        occurredAt,
        followupType: candidate.followupType ?? "other",
        relatedOpportunityIds: candidate.relatedOpportunityIds,
        primaryOpportunityId: candidate.primaryOpportunityId ?? null,
        facts: candidate.facts ?? [],
      },
      versionNo: "1",
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1_000,
      ).toISOString(),
      confirmedAt: null,
      confirmedBy: null,
      cancelledAt: null,
      followupId: null,
    };
  }
}
