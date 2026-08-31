import { randomUUID } from "node:crypto";
import type {
  IdentityPerson,
  IdentityProfile,
  IdentityRole,
  IdentityStore,
  LoginAccount,
  StoredSessionIdentity,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";

interface AccountRow {
  user_id: string;
  display_name: string;
  email: string;
  password_hash: string;
  locked_until: Date | string | null;
  role_code: string;
  department_id: string;
  department_name: string;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  expires_at: Date | string;
}

interface PersonRow {
  user_id: string;
  display_name: string;
}

export interface KyselyIdentityStoreOptions {
  requestId?: () => string;
}

export class KyselyIdentityStore implements IdentityStore {
  private readonly requestId: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyIdentityStoreOptions = {},
  ) {
    this.requestId = options.requestId ?? randomUUID;
  }

  async findLoginAccount(input: {
    tenantSlug: string;
    email: string;
  }): Promise<LoginAccount | null> {
    const tenant = await sql<{ tenant_id: string | null }>`
      select app.resolve_active_tenant_id(${input.tenantSlug}) as tenant_id
    `.execute(this.database);
    const tenantId = tenant.rows[0]?.tenant_id ?? null;
    if (!tenantId) return null;

    return withTenantTransaction(
      this.database,
      { tenantId, userId: SYSTEM_USER_ID, requestId: this.requestId() },
      async (transaction) => {
        const rows = await sql<AccountRow>`
          select
            app_user.id as user_id,
            app_user.display_name,
            app_user.email,
            credential.password_hash,
            credential.locked_until,
            membership.role_code,
            department.id as department_id,
            department.name as department_name
          from app.users as app_user
          inner join app.user_credentials as credential
            on credential.tenant_id = app_user.tenant_id
           and credential.user_id = app_user.id
          inner join app.user_memberships as membership
            on membership.tenant_id = app_user.tenant_id
           and membership.user_id = app_user.id
           and membership.valid_from <= current_timestamp
           and (membership.valid_to is null or membership.valid_to > current_timestamp)
          inner join app.org_units as department
            on department.tenant_id = membership.tenant_id
           and department.id = membership.org_unit_id
           and department.status = 'active'
          where app_user.tenant_id = ${tenantId}::uuid
            and lower(app_user.email) = lower(${input.email})
            and app_user.status = 'active'
            and membership.role_code in ('sales', 'department_leader')
          order by membership.created_at desc
          limit 2
        `.execute(transaction);
        if (rows.rows.length !== 1) return null;
        const row = rows.rows[0];
        if (!row || !isIdentityRole(row.role_code)) return null;
        const profile = await loadProfile(transaction, tenantId, row);
        if (!profile) return null;
        return {
          tenantId,
          userId: row.user_id,
          passwordHash: row.password_hash,
          lockedUntil: toNullableIso(row.locked_until),
          profile,
        };
      },
    );
  }

  async createSession(
    input: Parameters<IdentityStore["createSession"]>[0],
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestId() },
      async (transaction) => {
        await transaction
          .insertInto("app.user_sessions")
          .values({
            tenant_id: input.actor.tenantId,
            id: input.sessionId,
            user_id: input.actor.userId,
            token_hash: input.tokenHash,
            expires_at: input.expiresAt,
            last_used_at: input.createdAt,
            revoked_at: null,
            created_at: input.createdAt,
          })
          .executeTakeFirstOrThrow();
      },
    );
  }

  async resolveSession(
    input: Parameters<IdentityStore["resolveSession"]>[0],
  ): Promise<StoredSessionIdentity | null> {
    return withTenantTransaction(
      this.database,
      {
        tenantId: input.tenantId,
        userId: SYSTEM_USER_ID,
        requestId: this.requestId(),
      },
      async (transaction) => {
        const result = await sql<SessionRow>`
          select
            session.id as session_id,
            session.user_id,
            session.expires_at
          from app.user_sessions as session
          inner join app.users as app_user
            on app_user.tenant_id = session.tenant_id
           and app_user.id = session.user_id
           and app_user.status = 'active'
          where session.tenant_id = ${input.tenantId}::uuid
            and session.token_hash = ${input.tokenHash}
            and session.revoked_at is null
            and session.expires_at > ${input.now}::timestamptz
          limit 1
        `.execute(transaction);
        const session = result.rows[0];
        if (!session) return null;
        const accountRows = await accountRowsForUser(
          transaction,
          input.tenantId,
          session.user_id,
        );
        if (accountRows.length !== 1) return null;
        const account = accountRows[0];
        if (!account || !isIdentityRole(account.role_code)) return null;
        const profile = await loadProfile(transaction, input.tenantId, account);
        if (!profile) return null;
        await transaction
          .updateTable("app.user_sessions")
          .set({ last_used_at: input.now })
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", session.session_id)
          .executeTakeFirstOrThrow();
        return {
          sessionId: session.session_id,
          tenantId: input.tenantId,
          userId: session.user_id,
          expiresAt: toIso(session.expires_at),
          profile,
        };
      },
    );
  }

  async revokeSession(
    input: Parameters<IdentityStore["revokeSession"]>[0],
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestId() },
      async (transaction) => {
        await transaction
          .updateTable("app.user_sessions")
          .set({ revoked_at: input.revokedAt })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.sessionId)
          .where("user_id", "=", input.actor.userId)
          .where("revoked_at", "is", null)
          .executeTakeFirst();
      },
    );
  }
}

async function accountRowsForUser(
  transaction: Transaction<BattlefieldDatabase>,
  tenantId: string,
  userId: string,
): Promise<AccountRow[]> {
  const result = await sql<AccountRow>`
    select
      app_user.id as user_id,
      app_user.display_name,
      app_user.email,
      credential.password_hash,
      credential.locked_until,
      membership.role_code,
      department.id as department_id,
      department.name as department_name
    from app.users as app_user
    inner join app.user_credentials as credential
      on credential.tenant_id = app_user.tenant_id
     and credential.user_id = app_user.id
    inner join app.user_memberships as membership
      on membership.tenant_id = app_user.tenant_id
     and membership.user_id = app_user.id
     and membership.valid_from <= current_timestamp
     and (membership.valid_to is null or membership.valid_to > current_timestamp)
    inner join app.org_units as department
      on department.tenant_id = membership.tenant_id
     and department.id = membership.org_unit_id
     and department.status = 'active'
    where app_user.tenant_id = ${tenantId}::uuid
      and app_user.id = ${userId}::uuid
      and app_user.status = 'active'
      and membership.role_code in ('sales', 'department_leader')
    order by membership.created_at desc
    limit 2
  `.execute(transaction);
  return result.rows;
}

async function loadProfile(
  transaction: Transaction<BattlefieldDatabase>,
  tenantId: string,
  account: AccountRow,
): Promise<IdentityProfile | null> {
  const capabilities = await currentRoleCapabilities(
    transaction,
    tenantId,
    account.role_code,
  );
  if (account.role_code === "sales") {
    const leaders = await currentDepartmentPeople(
      transaction,
      tenantId,
      account.department_id,
      "department_leader",
    );
    if (leaders.length !== 1) return null;
    return baseProfile(account, {
      role: "sales",
      capabilities,
      directLeader: leaders[0] ?? null,
      teamMembers: [],
    });
  }
  if (account.role_code === "department_leader") {
    const teamMembers = await currentDepartmentPeople(
      transaction,
      tenantId,
      account.department_id,
      "sales",
    );
    return baseProfile(account, {
      role: "department_leader",
      capabilities,
      directLeader: null,
      teamMembers,
    });
  }
  return null;
}

function baseProfile(
  account: AccountRow,
  relationship: Pick<
    IdentityProfile,
    "role" | "capabilities" | "directLeader" | "teamMembers"
  >,
): IdentityProfile {
  return {
    user: {
      id: account.user_id,
      displayName: account.display_name,
      email: account.email,
    },
    department: {
      id: account.department_id,
      name: account.department_name,
    },
    ...relationship,
  };
}

async function currentRoleCapabilities(
  transaction: Transaction<BattlefieldDatabase>,
  tenantId: string,
  roleCode: string,
): Promise<IdentityProfile["capabilities"]> {
  const rows = await transaction
    .selectFrom("app.role_capability_grants")
    .select("capability_code")
    .where("tenant_id", "=", tenantId)
    .where("role_code", "=", roleCode)
    .orderBy("capability_code")
    .execute();
  return rows.map((row) => row.capability_code);
}

async function currentDepartmentPeople(
  transaction: Transaction<BattlefieldDatabase>,
  tenantId: string,
  departmentId: string,
  role: IdentityRole,
): Promise<IdentityPerson[]> {
  const result = await sql<PersonRow>`
    select app_user.id as user_id, app_user.display_name
    from app.user_memberships as membership
    inner join app.users as app_user
      on app_user.tenant_id = membership.tenant_id
     and app_user.id = membership.user_id
     and app_user.status = 'active'
    where membership.tenant_id = ${tenantId}::uuid
      and membership.org_unit_id = ${departmentId}::uuid
      and membership.role_code = ${role}
      and membership.valid_from <= current_timestamp
      and (membership.valid_to is null or membership.valid_to > current_timestamp)
    order by lower(app_user.display_name), app_user.id
  `.execute(transaction);
  return result.rows.map((row) => ({
    id: row.user_id,
    displayName: row.display_name,
  }));
}

function isIdentityRole(value: string): value is IdentityRole {
  return value === "sales" || value === "department_leader";
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}
