import { randomUUID } from "node:crypto";
import {
  CancelFollowupDraft,
  ConfirmFollowupDraft,
  CreatePersistentFollowupDraft,
  type FollowupConfirmationStore,
  type FollowupDraftAgent,
  GetFollowupDraft,
  GetFormalFollowup,
  ReviseFollowupDraft,
} from "@battlefield/core";
import { KyselyFollowupConfirmationStore } from "@battlefield/database";
import { type Provider, ServiceUnavailableException } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";
import { DeterministicFollowupDraftAgent } from "./deterministic-followup-draft-agent.js";

export const FOLLOWUP_DRAFT_AGENT = Symbol("FOLLOWUP_DRAFT_AGENT");
export const FOLLOWUP_CONFIRMATION_STORE = Symbol(
  "FOLLOWUP_CONFIRMATION_STORE",
);
export const CREATE_FOLLOWUP_DRAFT = Symbol("CREATE_FOLLOWUP_DRAFT");
export const GET_FOLLOWUP_DRAFT = Symbol("GET_FOLLOWUP_DRAFT");
export const REVISE_FOLLOWUP_DRAFT = Symbol("REVISE_FOLLOWUP_DRAFT");
export const CANCEL_FOLLOWUP_DRAFT = Symbol("CANCEL_FOLLOWUP_DRAFT");
export const CONFIRM_FOLLOWUP_DRAFT = Symbol("CONFIRM_FOLLOWUP_DRAFT");
export const GET_FORMAL_FOLLOWUP = Symbol("GET_FORMAL_FOLLOWUP");

const unavailableStore: FollowupConfirmationStore = {
  create: unavailable,
  get: unavailable,
  revise: unavailable,
  cancel: unavailable,
  confirm: unavailable,
  getFollowup: unavailable,
};

async function unavailable(): Promise<never> {
  throw new ServiceUnavailableException(
    "Follow-up persistence is not configured.",
  );
}

export const followupDraftProviders: Provider[] = [
  {
    provide: FOLLOWUP_DRAFT_AGENT,
    useClass: DeterministicFollowupDraftAgent,
  },
  {
    provide: FOLLOWUP_CONFIRMATION_STORE,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): FollowupConfirmationStore =>
      database
        ? new KyselyFollowupConfirmationStore(database.db)
        : unavailableStore,
  },
  {
    provide: CREATE_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_DRAFT_AGENT, FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (agent: FollowupDraftAgent, store: FollowupConfirmationStore) =>
      new CreatePersistentFollowupDraft({
        agent,
        store,
        idGenerator: { next: () => randomUUID() },
        clock: { now: () => new Date() },
      }),
  },
  {
    provide: GET_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new GetFollowupDraft(store),
  },
  {
    provide: REVISE_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new ReviseFollowupDraft(store),
  },
  {
    provide: CANCEL_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new CancelFollowupDraft(store),
  },
  {
    provide: CONFIRM_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new ConfirmFollowupDraft(store),
  },
  {
    provide: GET_FORMAL_FOLLOWUP,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new GetFormalFollowup(store),
  },
];
