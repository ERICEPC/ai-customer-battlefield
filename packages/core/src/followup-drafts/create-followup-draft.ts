import { InvalidRawInputError } from "./errors.js";
import type {
  ActorScope,
  FollowupDraftAgent,
  FollowupDraftCandidate,
} from "./followup-draft-agent.js";

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
  candidate: FollowupDraftCandidate;
  createdAt: string;
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
    rawInput: string;
  }): Promise<FollowupDraft> {
    const rawInput = input.rawInput.trim();
    if (rawInput.length === 0 || rawInput.length > 10_000) {
      throw new InvalidRawInputError();
    }

    const candidate = await this.#agent.propose({
      actor: input.actor,
      rawInput,
    });

    return {
      draftId: this.#idGenerator.next(),
      status: "pending_confirmation",
      rawInput,
      candidate,
      createdAt: this.#clock.now().toISOString(),
    };
  }
}
