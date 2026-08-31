import { randomUUID } from "node:crypto";
import {
  AuthenticateSession,
  type IdentityStore,
  ResolveSession,
  RevokeSession,
  randomSessionToken,
} from "@battlefield/core";
import { KyselyIdentityStore } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const IDENTITY_STORE = Symbol("IDENTITY_STORE");
export const AUTHENTICATE_SESSION = Symbol("AUTHENTICATE_SESSION");
export const RESOLVE_SESSION = Symbol("RESOLVE_SESSION");
export const REVOKE_SESSION = Symbol("REVOKE_SESSION");

const clock = { now: () => new Date() };

const unavailableStore: IdentityStore = {
  findLoginAccount: () => Promise.reject(identityStoreUnavailable()),
  createSession: () => Promise.reject(identityStoreUnavailable()),
  resolveSession: () => Promise.reject(identityStoreUnavailable()),
  revokeSession: () => Promise.reject(identityStoreUnavailable()),
};

export const authProviders: Provider[] = [
  {
    provide: IDENTITY_STORE,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): IdentityStore =>
      database ? new KyselyIdentityStore(database.db) : unavailableStore,
  },
  {
    provide: AUTHENTICATE_SESSION,
    inject: [IDENTITY_STORE],
    useFactory: (store: IdentityStore) =>
      new AuthenticateSession({
        store,
        clock,
        idGenerator: { next: randomUUID },
        tokenGenerator: { next: randomSessionToken },
        sessionDurationMs: 8 * 60 * 60 * 1_000,
      }),
  },
  {
    provide: RESOLVE_SESSION,
    inject: [IDENTITY_STORE],
    useFactory: (store: IdentityStore) => new ResolveSession({ store, clock }),
  },
  {
    provide: REVOKE_SESSION,
    inject: [IDENTITY_STORE],
    useFactory: (store: IdentityStore) => new RevokeSession({ store, clock }),
  },
];

function identityStoreUnavailable(): Error {
  return new Error("Identity database is not configured.");
}
