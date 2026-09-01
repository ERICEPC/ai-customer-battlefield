import { fileURLToPath } from "node:url";
import { hashPassword } from "@battlefield/core";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { KyselyIdentityStore } from "../src/identity/kysely-identity-store.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const SALES_ID = "30000000-0000-4000-8000-000000000001";
const LEADER_ID = "30000000-0000-4000-8000-000000000072";
const ENDED_SALES_ID = "30000000-0000-4000-8000-000000000073";
const DEPARTMENT_ID = "31000000-0000-4000-8000-000000000001";
const REQUEST_ID = "90000000-0000-4000-8000-000000000081";
const SESSION_ID = "81000000-0000-4000-8000-000000000001";
const LEADER_SESSION_ID = "81000000-0000-4000-8000-000000000002";
const TOKEN_HASH = "a".repeat(64);

describe("KyselyIdentityStore", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let store: KyselyIdentityStore;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedIdentity(database);
    store = new KyselyIdentityStore(database.db, {
      requestId: () => REQUEST_ID,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("loads Sales 1 with its direct leader", async () => {
    const account = await store.findLoginAccount({
      tenantSlug: "alpha",
      email: "SALES1@DEMO.LOCAL",
    });

    expect(account).toMatchObject({
      tenantId: TENANT_ID,
      userId: SALES_ID,
      profile: {
        user: {
          id: SALES_ID,
          displayName: "销售1",
          email: "sales1@demo.local",
        },
        role: "sales",
        capabilities: [],
        department: { id: DEPARTMENT_ID, name: "商业化一部" },
        directLeader: { id: LEADER_ID, displayName: "领导A" },
        teamMembers: [],
      },
    });
    expect(account?.passwordHash).toMatch(/^scrypt\$/);
  });

  test("loads Leader A with current department sales only", async () => {
    const account = await store.findLoginAccount({
      tenantSlug: "alpha",
      email: "leader.a@demo.local",
    });

    expect(account?.profile).toMatchObject({
      role: "department_leader",
      capabilities: [
        "access_control.manage",
        "ai_runtime_config.manage",
        "audit.read",
        "business_rules.manage",
        "management_query.execute",
        "worker_operations.manage",
      ],
      directLeader: null,
      teamMembers: [{ id: SALES_ID, displayName: "销售1" }],
    });
    expect(account?.profile.teamMembers).not.toContainEqual(
      expect.objectContaining({ id: ENDED_SALES_ID }),
    );
  });

  test("creates, resolves, expires, and revokes a server session", async () => {
    await store.createSession({
      actor: { tenantId: TENANT_ID, userId: SALES_ID },
      sessionId: SESSION_ID,
      tokenHash: TOKEN_HASH,
      expiresAt: "2026-09-01T08:00:00.000Z",
      createdAt: "2026-08-31T08:00:00.000Z",
    });

    await expect(
      store.resolveSession({
        tenantId: TENANT_ID,
        tokenHash: TOKEN_HASH,
        now: "2026-08-31T09:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      sessionId: SESSION_ID,
      userId: SALES_ID,
      profile: { role: "sales" },
    });
    await expect(
      store.resolveSession({
        tenantId: TENANT_ID,
        tokenHash: TOKEN_HASH,
        now: "2026-09-01T08:00:00.000Z",
      }),
    ).resolves.toBeNull();

    await store.revokeSession({
      actor: { tenantId: TENANT_ID, userId: SALES_ID },
      sessionId: SESSION_ID,
      revokedAt: "2026-08-31T10:00:00.000Z",
    });
    await expect(
      store.resolveSession({
        tenantId: TENANT_ID,
        tokenHash: TOKEN_HASH,
        now: "2026-08-31T11:00:00.000Z",
      }),
    ).resolves.toBeNull();
  });

  test("refreshes an existing leader session after a capability is revoked", async () => {
    await store.createSession({
      actor: { tenantId: TENANT_ID, userId: LEADER_ID },
      sessionId: LEADER_SESSION_ID,
      tokenHash: "b".repeat(64),
      expiresAt: "2026-09-01T08:00:00.000Z",
      createdAt: "2026-08-31T08:00:00.000Z",
    });

    const before = await store.resolveSession({
      tenantId: TENANT_ID,
      tokenHash: "b".repeat(64),
      now: "2026-08-31T09:00:00.000Z",
    });
    expect(before?.profile.capabilities).toContain("worker_operations.manage");

    await withTenantTransaction(
      database.db,
      { tenantId: TENANT_ID, userId: LEADER_ID, requestId: REQUEST_ID },
      (transaction) =>
        transaction
          .deleteFrom("app.role_capability_grants")
          .where("tenant_id", "=", TENANT_ID)
          .where("role_code", "=", "department_leader")
          .where("capability_code", "=", "worker_operations.manage")
          .executeTakeFirstOrThrow(),
    );

    const after = await store.resolveSession({
      tenantId: TENANT_ID,
      tokenHash: "b".repeat(64),
      now: "2026-08-31T09:01:00.000Z",
    });
    expect(after?.profile.capabilities).toEqual([
      "access_control.manage",
      "ai_runtime_config.manage",
      "audit.read",
      "business_rules.manage",
      "management_query.execute",
    ]);
  });
});

async function seedIdentity(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  const passwordHash = await hashPassword("Demo@2026", {
    salt: Buffer.alloc(16, 8),
  });
  await withTenantTransaction(
    database.db,
    { tenantId: TENANT_ID, userId: SALES_ID, requestId: REQUEST_ID },
    async (transaction) => {
      await sql`
        insert into app.tenants (id, slug, name)
        values (${TENANT_ID}::uuid, 'alpha', 'Alpha')
      `.execute(transaction);
      await sql`
        insert into app.org_units (tenant_id, id, code, name, unit_type)
        values (
          ${TENANT_ID}::uuid,
          ${DEPARTMENT_ID}::uuid,
          'commercial-one',
          '商业化一部',
          'department'
        )
      `.execute(transaction);
      await sql`
        insert into app.users (tenant_id, id, display_name, email)
        values
          (${TENANT_ID}::uuid, ${SALES_ID}::uuid, '销售1', 'sales1@demo.local'),
          (${TENANT_ID}::uuid, ${LEADER_ID}::uuid, '领导A', 'leader.a@demo.local'),
          (${TENANT_ID}::uuid, ${ENDED_SALES_ID}::uuid, '历史销售', 'former@demo.local')
      `.execute(transaction);
      await sql`
        insert into app.user_memberships (
          tenant_id, id, user_id, org_unit_id, role_code, valid_from, valid_to
        ) values
          (
            ${TENANT_ID}::uuid,
            '32000000-0000-4000-8000-000000000001'::uuid,
            ${SALES_ID}::uuid,
            ${DEPARTMENT_ID}::uuid,
            'sales',
            '2026-01-01T00:00:00.000Z'::timestamptz,
            null
          ),
          (
            ${TENANT_ID}::uuid,
            '32000000-0000-4000-8000-000000000002'::uuid,
            ${LEADER_ID}::uuid,
            ${DEPARTMENT_ID}::uuid,
            'department_leader',
            '2026-01-01T00:00:00.000Z'::timestamptz,
            null
          ),
          (
            ${TENANT_ID}::uuid,
            '32000000-0000-4000-8000-000000000003'::uuid,
            ${ENDED_SALES_ID}::uuid,
            ${DEPARTMENT_ID}::uuid,
            'sales',
            '2025-01-01T00:00:00.000Z'::timestamptz,
            '2025-12-31T00:00:00.000Z'::timestamptz
          )
      `.execute(transaction);
      await sql`
        insert into app.user_credentials (tenant_id, user_id, password_hash)
        values
          (${TENANT_ID}::uuid, ${SALES_ID}::uuid, ${passwordHash}),
          (${TENANT_ID}::uuid, ${LEADER_ID}::uuid, ${passwordHash})
      `.execute(transaction);
    },
  );
}
