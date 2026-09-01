import { fileURLToPath } from "node:url";
import {
  AccessControlAccessDeniedError,
  AccessControlIdempotencyConflictError,
  AccessControlLockoutError,
  AccessControlRoleNotFoundError,
} from "@battlefield/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KyselyAccessControlManager } from "../src/authorization/kysely-access-control-manager.js";
import { actorHasManagementCapability } from "../src/authorization/management-capabilities.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import {
  createPgliteDatabase,
  SYNTHETIC_MANAGER_USER_ID,
  SYNTHETIC_OTHER_TENANT_ID,
  SYNTHETIC_OTHER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticManagementObserver,
  seedSyntheticTwoLevelIdentity,
} from "../src/testing/index.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const REQUEST_ID = "90000000-0000-4000-8000-000000000218";
const leader = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_MANAGER_USER_ID,
};
const sales = { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID };

describe("KyselyAccessControlManager", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let manager: KyselyAccessControlManager;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    await seedSyntheticTwoLevelIdentity(database);
    manager = new KyselyAccessControlManager(database.db, {
      requestIdFactory: () => REQUEST_ID,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("lists the closed catalog with active role counts and current grants", async () => {
    const snapshot = await manager.getSnapshot({ actor: leader });

    expect(snapshot.capabilities.map((item) => item.code)).toEqual([
      "access_control.manage",
      "ai_runtime_config.manage",
      "audit.read",
      "business_rules.manage",
      "management_query.execute",
      "worker_operations.manage",
    ]);
    expect(snapshot.roles).toEqual([
      {
        roleCode: "department_leader",
        displayName: "部门领导",
        activeUserCount: 1,
        capabilities: snapshot.capabilities.map((item) => item.code),
      },
      {
        roleCode: "sales",
        displayName: "销售",
        activeUserCount: 1,
        capabilities: [],
      },
    ]);
  });

  test("replaces a role grant set and appends one reasoned audit entry", async () => {
    const updated = await manager.replaceRoleCapabilities({
      actor: leader,
      roleCode: "sales",
      capabilities: ["audit.read", "worker_operations.manage"],
      reason: "销售骨干临时承担审计与运维",
      idempotencyKey: "grant-sales-governance-1",
    });

    expect(updated).toMatchObject({
      roleCode: "sales",
      capabilities: ["audit.read", "worker_operations.manage"],
      changed: true,
    });
    await expect(hasCapability(sales, "audit.read")).resolves.toBe(true);
    const rows = await readChangeAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      aggregate_type: "access_control_role",
      action: "access_control.role_capabilities_updated",
      actor_user_id: leader.userId,
      request_id: REQUEST_ID,
      reason: "销售骨干临时承担审计与运维",
      before_payload: { roleCode: "sales", capabilities: [] },
      after_payload: {
        roleCode: "sales",
        capabilities: ["audit.read", "worker_operations.manage"],
      },
    });
  });

  test("replays the same request exactly and rejects idempotency reuse", async () => {
    const input = {
      actor: leader,
      roleCode: "sales",
      capabilities: ["audit.read"] as const,
      reason: "允许查看受控审计",
      idempotencyKey: "grant-sales-audit-1",
    };
    const first = await manager.replaceRoleCapabilities({
      ...input,
      capabilities: [...input.capabilities],
    });
    const replay = await manager.replaceRoleCapabilities({
      ...input,
      capabilities: [...input.capabilities],
    });

    expect(replay).toEqual(first);
    expect(await readChangeAudit()).toHaveLength(1);
    await expect(
      manager.replaceRoleCapabilities({
        ...input,
        capabilities: ["worker_operations.manage"],
      }),
    ).rejects.toBeInstanceOf(AccessControlIdempotencyConflictError);
  });

  test("prevents tenant lockout but allows an explicit controller transfer", async () => {
    await expect(
      manager.replaceRoleCapabilities({
        actor: leader,
        roleCode: "department_leader",
        capabilities: ["audit.read"],
        reason: "错误地移除唯一管理员",
        idempotencyKey: "lockout-attempt-1",
      }),
    ).rejects.toBeInstanceOf(AccessControlLockoutError);

    await manager.replaceRoleCapabilities({
      actor: leader,
      roleCode: "sales",
      capabilities: ["access_control.manage"],
      reason: "先转移权限管理职责",
      idempotencyKey: "transfer-controller-1",
    });
    await manager.replaceRoleCapabilities({
      actor: leader,
      roleCode: "department_leader",
      capabilities: ["audit.read"],
      reason: "完成权限管理职责转移",
      idempotencyKey: "transfer-controller-2",
    });

    await expect(hasCapability(sales, "access_control.manage")).resolves.toBe(
      true,
    );
    await expect(manager.getSnapshot({ actor: leader })).rejects.toBeInstanceOf(
      AccessControlAccessDeniedError,
    );
    await expect(manager.getSnapshot({ actor: sales })).resolves.toMatchObject({
      roles: expect.any(Array),
    });
  });

  test("rejects unknown roles, ungranted actors, and another tenant", async () => {
    await expect(
      manager.replaceRoleCapabilities({
        actor: leader,
        roleCode: "regional_director",
        capabilities: ["audit.read"],
        reason: "未知角色",
        idempotencyKey: "unknown-role-1",
      }),
    ).rejects.toBeInstanceOf(AccessControlRoleNotFoundError);
    await expect(manager.getSnapshot({ actor: sales })).rejects.toBeInstanceOf(
      AccessControlAccessDeniedError,
    );
    await expect(
      manager.getSnapshot({
        actor: {
          tenantId: SYNTHETIC_OTHER_TENANT_ID,
          userId: SYNTHETIC_OTHER_USER_ID,
        },
      }),
    ).rejects.toBeInstanceOf(AccessControlAccessDeniedError);
  });

  async function hasCapability(
    actor: { tenantId: string; userId: string },
    capability: "access_control.manage" | "audit.read",
  ): Promise<boolean> {
    return withTenantTransaction(
      database.db,
      { ...actor, requestId: REQUEST_ID },
      (transaction) =>
        actorHasManagementCapability(transaction, actor, capability),
    );
  }

  async function readChangeAudit() {
    return withTenantTransaction(
      database.db,
      { ...leader, requestId: REQUEST_ID },
      (transaction) =>
        transaction
          .selectFrom("app.audit_entries")
          .selectAll()
          .where("tenant_id", "=", leader.tenantId)
          .where("action", "=", "access_control.role_capabilities_updated")
          .orderBy("occurred_at")
          .execute(),
    );
  }
});
