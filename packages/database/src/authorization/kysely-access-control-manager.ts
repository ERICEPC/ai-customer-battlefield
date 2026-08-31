import { createHash, randomUUID } from "node:crypto";
import {
  AccessControlAccessDeniedError,
  AccessControlIdempotencyConflictError,
  AccessControlLockoutError,
  type AccessControlRepository,
  AccessControlRoleNotFoundError,
  type ManagementCapability,
  managementCapabilityCodes,
  type RoleCapabilityUpdate,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import { appendAuditEntry } from "../audit/append-audit-entry.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";
import { actorHasManagementCapability } from "./management-capabilities.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed";
  response_payload: unknown;
}

export interface KyselyAccessControlManagerOptions {
  requestIdFactory?: () => string;
}

export class KyselyAccessControlManager implements AccessControlRepository {
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyAccessControlManagerOptions = {},
  ) {
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async getSnapshot(
    input: Parameters<AccessControlRepository["getSnapshot"]>[0],
  ) {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        await assertAccessController(transaction, input.actor);
        const [definitions, grants, membershipCounts] = await Promise.all([
          transaction
            .selectFrom("app.management_capabilities")
            .select(["code", "name", "description"])
            .orderBy("code")
            .execute(),
          transaction
            .selectFrom("app.role_capability_grants")
            .select(["role_code", "capability_code"])
            .where("tenant_id", "=", input.actor.tenantId)
            .orderBy("role_code")
            .orderBy("capability_code")
            .execute(),
          currentRoleCounts(transaction, input.actor.tenantId),
        ]);
        const roles = new Map<
          string,
          { activeUserCount: number; capabilities: ManagementCapability[] }
        >();
        for (const membership of membershipCounts) {
          roles.set(membership.roleCode, {
            activeUserCount: membership.activeUserCount,
            capabilities: [],
          });
        }
        for (const grant of grants) {
          const role = roles.get(grant.role_code) ?? {
            activeUserCount: 0,
            capabilities: [],
          };
          role.capabilities.push(grant.capability_code);
          roles.set(grant.role_code, role);
        }
        return {
          capabilities: definitions,
          roles: [...roles.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([roleCode, role]) => ({
              roleCode,
              displayName: displayRoleName(roleCode),
              activeUserCount: role.activeUserCount,
              capabilities: role.capabilities,
            })),
        };
      },
    );
  }

  async replaceRoleCapabilities(
    input: Parameters<AccessControlRepository["replaceRoleCapabilities"]>[0],
  ): Promise<RoleCapabilityUpdate> {
    const requestId = this.requestIdFactory();
    const requestHash = accessChangeHash(input);
    const roleId = stableRoleAggregateId(input.actor.tenantId, input.roleCode);
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        await assertAccessController(transaction, input.actor);
        await lockTenantAccessControl(transaction, input.actor.tenantId);
        const replay = await beginIdempotentChange(transaction, {
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        });
        if (replay) return replay;
        if (!(await roleExists(transaction, input))) {
          throw new AccessControlRoleNotFoundError();
        }

        const before = await currentCapabilities(
          transaction,
          input.actor.tenantId,
          input.roleCode,
        );
        const after = orderedCapabilities(input.capabilities);
        const changed = !sameCapabilities(before, after);
        if (changed) {
          await assertControllerRemains(transaction, input, after);
          const removed = before.filter(
            (capability) => !after.includes(capability),
          );
          const added = after.filter(
            (capability) => !before.includes(capability),
          );
          if (removed.length > 0) {
            await transaction
              .deleteFrom("app.role_capability_grants")
              .where("tenant_id", "=", input.actor.tenantId)
              .where("role_code", "=", input.roleCode)
              .where("capability_code", "in", removed)
              .execute();
          }
          const updatedAt = await currentTimestamp(transaction);
          if (added.length > 0) {
            await transaction
              .insertInto("app.role_capability_grants")
              .values(
                added.map((capability) => ({
                  tenant_id: input.actor.tenantId,
                  role_code: input.roleCode,
                  capability_code: capability,
                  granted_by: input.actor.userId,
                  reason: input.reason,
                  created_at: updatedAt,
                })),
              )
              .execute();
          }
          const response = updateResponse(
            input.roleCode,
            after,
            true,
            updatedAt,
          );
          await appendAuditEntry(transaction, {
            tenantId: input.actor.tenantId,
            actorUserId: input.actor.userId,
            aggregateType: "access_control_role",
            aggregateId: roleId,
            action: "access_control.role_capabilities_updated",
            occurredAt: response.updatedAt,
            requestId,
            beforePayload: { roleCode: input.roleCode, capabilities: before },
            afterPayload: { roleCode: input.roleCode, capabilities: after },
            reason: input.reason,
          });
          await completeIdempotentChange(transaction, {
            tenantId: input.actor.tenantId,
            idempotencyKey: input.idempotencyKey,
            roleId,
            response,
            completedAt: updatedAt,
          });
          return response;
        }

        const completedAt = await currentTimestamp(transaction);
        const response = updateResponse(
          input.roleCode,
          after,
          false,
          completedAt,
        );
        await completeIdempotentChange(transaction, {
          tenantId: input.actor.tenantId,
          idempotencyKey: input.idempotencyKey,
          roleId,
          response,
          completedAt,
        });
        return response;
      },
    );
  }
}

async function assertAccessController(
  transaction: DatabaseTransaction,
  actor: { tenantId: string; userId: string },
): Promise<void> {
  if (
    !(await actorHasManagementCapability(
      transaction,
      actor,
      "access_control.manage",
    ))
  ) {
    throw new AccessControlAccessDeniedError();
  }
}

async function currentRoleCounts(
  transaction: DatabaseTransaction,
  tenantId: string,
): Promise<Array<{ roleCode: string; activeUserCount: number }>> {
  const rows = await transaction
    .selectFrom("app.user_memberships as membership")
    .innerJoin("app.users as member", (join) =>
      join
        .onRef("member.tenant_id", "=", "membership.tenant_id")
        .onRef("member.id", "=", "membership.user_id"),
    )
    .select([
      "membership.role_code",
      sql<string>`count(distinct membership.user_id)`.as("active_user_count"),
    ])
    .where("membership.tenant_id", "=", tenantId)
    .where("member.status", "=", "active")
    .where("membership.valid_from", "<=", sql<Date>`current_timestamp`)
    .where((expression) =>
      expression.or([
        expression("membership.valid_to", "is", null),
        expression("membership.valid_to", ">", sql<Date>`current_timestamp`),
      ]),
    )
    .groupBy("membership.role_code")
    .execute();
  return rows.map((row) => ({
    roleCode: row.role_code,
    activeUserCount: Number(row.active_user_count),
  }));
}

async function roleExists(
  transaction: DatabaseTransaction,
  input: Parameters<AccessControlRepository["replaceRoleCapabilities"]>[0],
): Promise<boolean> {
  const membership = await transaction
    .selectFrom("app.user_memberships")
    .select("id")
    .where("tenant_id", "=", input.actor.tenantId)
    .where("role_code", "=", input.roleCode)
    .limit(1)
    .executeTakeFirst();
  if (membership) return true;
  const grant = await transaction
    .selectFrom("app.role_capability_grants")
    .select("capability_code")
    .where("tenant_id", "=", input.actor.tenantId)
    .where("role_code", "=", input.roleCode)
    .limit(1)
    .executeTakeFirst();
  return grant !== undefined;
}

async function currentCapabilities(
  transaction: DatabaseTransaction,
  tenantId: string,
  roleCode: string,
): Promise<ManagementCapability[]> {
  const rows = await transaction
    .selectFrom("app.role_capability_grants")
    .select("capability_code")
    .where("tenant_id", "=", tenantId)
    .where("role_code", "=", roleCode)
    .orderBy("capability_code")
    .execute();
  return rows.map((row) => row.capability_code);
}

async function assertControllerRemains(
  transaction: DatabaseTransaction,
  input: Parameters<AccessControlRepository["replaceRoleCapabilities"]>[0],
  desired: ManagementCapability[],
): Promise<void> {
  const targetKeepsAccess = desired.includes("access_control.manage");
  const controller = await transaction
    .selectFrom("app.user_memberships as membership")
    .innerJoin("app.users as member", (join) =>
      join
        .onRef("member.tenant_id", "=", "membership.tenant_id")
        .onRef("member.id", "=", "membership.user_id"),
    )
    .select("membership.id")
    .where("membership.tenant_id", "=", input.actor.tenantId)
    .where("member.status", "=", "active")
    .where("membership.valid_from", "<=", sql<Date>`current_timestamp`)
    .where((expression) =>
      expression.or([
        expression("membership.valid_to", "is", null),
        expression("membership.valid_to", ">", sql<Date>`current_timestamp`),
      ]),
    )
    .where((expression) =>
      expression.or([
        targetKeepsAccess
          ? expression("membership.role_code", "=", input.roleCode)
          : sql<boolean>`false`,
        expression.and([
          expression("membership.role_code", "!=", input.roleCode),
          sql<boolean>`exists (
            select 1
            from app.role_capability_grants as controller_grant
            where controller_grant.tenant_id = ${input.actor.tenantId}::uuid
              and controller_grant.role_code = membership.role_code
              and controller_grant.capability_code = 'access_control.manage'
          )`,
        ]),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  if (!controller) throw new AccessControlLockoutError();
}

async function lockTenantAccessControl(
  transaction: DatabaseTransaction,
  tenantId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:access-control`}))`.execute(
    transaction,
  );
}

async function beginIdempotentChange(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<RoleCapabilityUpdate | null> {
  let existing = await readIdempotencyRecord(transaction, input);
  if (!existing) {
    const createdAt = await currentTimestamp(transaction);
    const inserted = await transaction
      .insertInto("app.idempotency_records")
      .values({
        tenant_id: input.tenantId,
        id: randomUUID(),
        operation: IDEMPOTENCY_OPERATION,
        idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash,
        status: "in_progress",
        response_payload: null,
        resource_type: null,
        resource_id: null,
        created_by: input.userId,
        created_at: createdAt,
        completed_at: null,
        expires_at: null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["tenant_id", "operation", "idempotency_key"])
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    if (inserted) return null;
    existing = await readIdempotencyRecord(transaction, input);
  }
  if (
    !existing ||
    existing.request_hash !== input.requestHash ||
    existing.status !== "completed"
  ) {
    throw new AccessControlIdempotencyConflictError();
  }
  return decodeUpdate(existing.response_payload);
}

function readIdempotencyRecord(
  transaction: DatabaseTransaction,
  input: { tenantId: string; idempotencyKey: string },
): Promise<IdempotencyRow | undefined> {
  return transaction
    .selectFrom("app.idempotency_records")
    .select(["request_hash", "status", "response_payload"])
    .where("tenant_id", "=", input.tenantId)
    .where("operation", "=", IDEMPOTENCY_OPERATION)
    .where("idempotency_key", "=", input.idempotencyKey)
    .forUpdate()
    .executeTakeFirst() as Promise<IdempotencyRow | undefined>;
}

async function completeIdempotentChange(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    idempotencyKey: string;
    roleId: string;
    response: RoleCapabilityUpdate;
    completedAt: Date;
  },
): Promise<void> {
  await transaction
    .updateTable("app.idempotency_records")
    .set({
      status: "completed",
      response_payload: sql<
        Record<string, unknown>
      >`${JSON.stringify(input.response)}::jsonb`,
      resource_type: "access_control_role",
      resource_id: input.roleId,
      completed_at: input.completedAt,
    })
    .where("tenant_id", "=", input.tenantId)
    .where("operation", "=", IDEMPOTENCY_OPERATION)
    .where("idempotency_key", "=", input.idempotencyKey)
    .executeTakeFirstOrThrow();
}

function decodeUpdate(payload: unknown): RoleCapabilityUpdate {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AccessControlIdempotencyConflictError();
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value.roleCode !== "string" ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(isManagementCapability) ||
    typeof value.changed !== "boolean" ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new AccessControlIdempotencyConflictError();
  }
  return {
    roleCode: value.roleCode,
    capabilities: value.capabilities,
    changed: value.changed,
    updatedAt: value.updatedAt,
  };
}

function updateResponse(
  roleCode: string,
  capabilities: ManagementCapability[],
  changed: boolean,
  updatedAt: Date,
): RoleCapabilityUpdate {
  return {
    roleCode,
    capabilities,
    changed,
    updatedAt: updatedAt.toISOString(),
  };
}

function accessChangeHash(
  input: Parameters<AccessControlRepository["replaceRoleCapabilities"]>[0],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        roleCode: input.roleCode,
        capabilities: orderedCapabilities(input.capabilities),
        reason: input.reason,
      }),
    )
    .digest("hex");
}

function stableRoleAggregateId(tenantId: string, roleCode: string): string {
  const hex = createHash("sha256")
    .update(`${tenantId}:access-control-role:${roleCode}`)
    .digest("hex")
    .slice(0, 32);
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function orderedCapabilities(
  capabilities: readonly ManagementCapability[],
): ManagementCapability[] {
  return managementCapabilityCodes.filter((capability) =>
    capabilities.includes(capability),
  );
}

function sameCapabilities(
  left: readonly ManagementCapability[],
  right: readonly ManagementCapability[],
): boolean {
  return (
    left.length === right.length &&
    left.every((capability, index) => capability === right[index])
  );
}

function isManagementCapability(value: unknown): value is ManagementCapability {
  return (
    typeof value === "string" &&
    managementCapabilityCodes.some((capability) => capability === value)
  );
}

function displayRoleName(roleCode: string): string {
  if (roleCode === "sales") return "销售";
  if (roleCode === "department_leader") return "部门领导";
  return roleCode;
}

async function currentTimestamp(
  transaction: DatabaseTransaction,
): Promise<Date> {
  const result = await sql<{
    now: Date;
  }>`select current_timestamp as now`.execute(transaction);
  const now = result.rows[0]?.now;
  if (!now) throw new AccessControlIdempotencyConflictError();
  return now;
}

const IDEMPOTENCY_OPERATION = "access_control.replace_role_capabilities";
