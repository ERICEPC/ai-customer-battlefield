import { randomUUID } from "node:crypto";
import {
  CreateFollowupDraft,
  type FollowupDraftAgent,
} from "@battlefield/core";
import type { Provider } from "@nestjs/common";

import { DeterministicFollowupDraftAgent } from "./deterministic-followup-draft-agent.js";

export const FOLLOWUP_DRAFT_AGENT = Symbol("FOLLOWUP_DRAFT_AGENT");
export const CREATE_FOLLOWUP_DRAFT = Symbol("CREATE_FOLLOWUP_DRAFT");

export const followupDraftProviders: Provider[] = [
  {
    provide: FOLLOWUP_DRAFT_AGENT,
    useClass: DeterministicFollowupDraftAgent,
  },
  {
    provide: CREATE_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_DRAFT_AGENT],
    useFactory: (agent: FollowupDraftAgent) =>
      new CreateFollowupDraft({
        agent,
        idGenerator: { next: () => randomUUID() },
        clock: { now: () => new Date() },
      }),
  },
];
