import { randomUUID } from "node:crypto";
import {
  AcceptActionProposal,
  type ActionDecisionStore,
  type ActionQueryReader,
  RejectActionProposal,
  TransitionBusinessAction,
} from "@battlefield/core";
import {
  KyselyActionDecisionStore,
  KyselyActionQueryReader,
} from "@battlefield/database";
import { type Provider, ServiceUnavailableException } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const ACTION_DECISION_STORE = Symbol("ACTION_DECISION_STORE");
export const ACTION_QUERY_READER = Symbol("ACTION_QUERY_READER");
export const ACCEPT_ACTION_PROPOSAL = Symbol("ACCEPT_ACTION_PROPOSAL");
export const REJECT_ACTION_PROPOSAL = Symbol("REJECT_ACTION_PROPOSAL");
export const TRANSITION_BUSINESS_ACTION = Symbol("TRANSITION_BUSINESS_ACTION");

async function unavailable(): Promise<never> {
  throw new ServiceUnavailableException(
    "Business action persistence is not configured.",
  );
}

const unavailableStore: ActionDecisionStore = {
  accept: unavailable,
  reject: unavailable,
  transition: unavailable,
};
const unavailableReader: ActionQueryReader = {
  listOwners: unavailable,
  getProposal: unavailable,
  listProposals: unavailable,
  getAction: unavailable,
  listActions: unavailable,
};

export const businessActionProviders: Provider[] = [
  {
    provide: ACTION_DECISION_STORE,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): ActionDecisionStore =>
      database ? new KyselyActionDecisionStore(database.db) : unavailableStore,
  },
  {
    provide: ACTION_QUERY_READER,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): ActionQueryReader =>
      database ? new KyselyActionQueryReader(database.db) : unavailableReader,
  },
  {
    provide: ACCEPT_ACTION_PROPOSAL,
    inject: [ACTION_DECISION_STORE],
    useFactory: (store: ActionDecisionStore) =>
      new AcceptActionProposal({
        store,
        idGenerator: { next: () => randomUUID() },
        clock: { now: () => new Date() },
      }),
  },
  {
    provide: REJECT_ACTION_PROPOSAL,
    inject: [ACTION_DECISION_STORE],
    useFactory: (store: ActionDecisionStore) =>
      new RejectActionProposal({ store, clock: { now: () => new Date() } }),
  },
  {
    provide: TRANSITION_BUSINESS_ACTION,
    inject: [ACTION_DECISION_STORE],
    useFactory: (store: ActionDecisionStore) =>
      new TransitionBusinessAction({
        store,
        clock: { now: () => new Date() },
      }),
  },
];
