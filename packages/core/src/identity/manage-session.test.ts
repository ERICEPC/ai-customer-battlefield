import { describe, expect, it } from "vitest";

import type {
  IdentityProfile,
  IdentityStore,
  LoginAccount,
  StoredSessionIdentity,
} from "./identity-store.js";
import {
  AuthenticateSession,
  hashPassword,
  hashSessionToken,
  InvalidCredentialsError,
  ResolveSession,
  RevokeSession,
} from "./manage-session.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const salesId = "30000000-0000-4000-8000-000000000001";
const leaderId = "30000000-0000-4000-8000-000000000072";
const sessionId = "81000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-31T12:00:00.000Z");
const rawToken = "session-secret-with-at-least-thirty-two-bytes";

const salesProfile: IdentityProfile = {
  user: {
    id: salesId,
    displayName: "销售1",
    email: "sales1@demo.local",
  },
  role: "sales",
  capabilities: [],
  department: {
    id: "31000000-0000-4000-8000-000000000001",
    name: "商业化一部",
  },
  directLeader: { id: leaderId, displayName: "领导A" },
  teamMembers: [],
};

describe("session identity use cases", () => {
  it("authenticates a password and persists only the session token hash", async () => {
    const account: LoginAccount = {
      tenantId,
      userId: salesId,
      passwordHash: await hashPassword("Demo@2026", {
        salt: Buffer.alloc(16, 7),
      }),
      lockedUntil: null,
      profile: salesProfile,
    };
    const store = new MemoryIdentityStore(account);
    const authenticate = new AuthenticateSession({
      store,
      clock: { now: () => now },
      idGenerator: { next: () => sessionId },
      tokenGenerator: { next: () => rawToken },
      sessionDurationMs: 8 * 60 * 60 * 1_000,
    });

    const result = await authenticate.execute({
      tenantSlug: "alpha",
      email: "sales1@demo.local",
      password: "Demo@2026",
    });

    expect(result.cookieValue).toBe(`${tenantId}.${rawToken}`);
    expect(result.session).toEqual({
      ...salesProfile,
      expiresAt: "2026-08-31T20:00:00.000Z",
    });
    expect(store.createdSession).toEqual({
      actor: { tenantId, userId: salesId },
      sessionId,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: "2026-08-31T20:00:00.000Z",
      createdAt: "2026-08-31T12:00:00.000Z",
    });
    expect(JSON.stringify(store.createdSession)).not.toContain(rawToken);
  });

  it("uses the same invalid-credentials error for unknown accounts and wrong passwords", async () => {
    const store = new MemoryIdentityStore(null);
    const authenticate = createAuthenticator(store);

    await expect(
      authenticate.execute({
        tenantSlug: "alpha",
        email: "missing@demo.local",
        password: "Wrong@2026",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(store.createdSession).toBeNull();
  });

  it("resolves a cookie into one actor and rejects malformed cookies", async () => {
    const stored: StoredSessionIdentity = {
      sessionId,
      tenantId,
      userId: salesId,
      expiresAt: "2026-08-31T20:00:00.000Z",
      profile: salesProfile,
    };
    const store = new MemoryIdentityStore(null);
    store.resolvedSession = stored;
    const resolve = new ResolveSession({
      store,
      clock: { now: () => now },
    });

    await expect(
      resolve.execute({ cookieValue: "not-a-session" }),
    ).resolves.toBeNull();
    await expect(
      resolve.execute({ cookieValue: `${tenantId}.${rawToken}` }),
    ).resolves.toEqual({
      actor: { tenantId, userId: salesId },
      sessionId,
      session: {
        ...salesProfile,
        expiresAt: "2026-08-31T20:00:00.000Z",
      },
    });
    expect(store.resolveInput).toEqual({
      tenantId,
      tokenHash: hashSessionToken(rawToken),
      now: "2026-08-31T12:00:00.000Z",
    });
  });

  it("revokes the resolved server session", async () => {
    const store = new MemoryIdentityStore(null);
    const revoke = new RevokeSession({
      store,
      clock: { now: () => now },
    });

    await revoke.execute({
      actor: { tenantId, userId: salesId },
      sessionId,
    });

    expect(store.revokedSession).toEqual({
      actor: { tenantId, userId: salesId },
      sessionId,
      revokedAt: "2026-08-31T12:00:00.000Z",
    });
  });
});

function createAuthenticator(store: IdentityStore): AuthenticateSession {
  return new AuthenticateSession({
    store,
    clock: { now: () => now },
    idGenerator: { next: () => sessionId },
    tokenGenerator: { next: () => rawToken },
    sessionDurationMs: 8 * 60 * 60 * 1_000,
  });
}

class MemoryIdentityStore implements IdentityStore {
  createdSession: Parameters<IdentityStore["createSession"]>[0] | null = null;
  resolvedSession: StoredSessionIdentity | null = null;
  resolveInput: Parameters<IdentityStore["resolveSession"]>[0] | null = null;
  revokedSession: Parameters<IdentityStore["revokeSession"]>[0] | null = null;

  constructor(private readonly account: LoginAccount | null) {}

  async findLoginAccount(): Promise<LoginAccount | null> {
    return this.account;
  }

  async createSession(
    input: Parameters<IdentityStore["createSession"]>[0],
  ): Promise<void> {
    this.createdSession = input;
  }

  async resolveSession(
    input: Parameters<IdentityStore["resolveSession"]>[0],
  ): Promise<StoredSessionIdentity | null> {
    this.resolveInput = input;
    return this.resolvedSession;
  }

  async revokeSession(
    input: Parameters<IdentityStore["revokeSession"]>[0],
  ): Promise<void> {
    this.revokedSession = input;
  }
}
