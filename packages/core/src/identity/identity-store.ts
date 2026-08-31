import type { ManagementCapability } from "../authorization/management-capability.js";

export type IdentityRole = "sales" | "department_leader";

export interface IdentityPerson {
  id: string;
  displayName: string;
}

export interface IdentityProfile {
  user: IdentityPerson & { email: string };
  role: IdentityRole;
  capabilities: ManagementCapability[];
  department: { id: string; name: string };
  directLeader: IdentityPerson | null;
  teamMembers: IdentityPerson[];
}

export interface LoginAccount {
  tenantId: string;
  userId: string;
  passwordHash: string;
  lockedUntil: string | null;
  profile: IdentityProfile;
}

export interface StoredSessionIdentity {
  sessionId: string;
  tenantId: string;
  userId: string;
  expiresAt: string;
  profile: IdentityProfile;
}

export interface IdentityStore {
  findLoginAccount(input: {
    tenantSlug: string;
    email: string;
  }): Promise<LoginAccount | null>;
  createSession(input: {
    actor: { tenantId: string; userId: string };
    sessionId: string;
    tokenHash: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<void>;
  resolveSession(input: {
    tenantId: string;
    tokenHash: string;
    now: string;
  }): Promise<StoredSessionIdentity | null>;
  revokeSession(input: {
    actor: { tenantId: string; userId: string };
    sessionId: string;
    revokedAt: string;
  }): Promise<void>;
}
