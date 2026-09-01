import { randomUUID } from "node:crypto";
import type { WorkerExecutionLeaseStore } from "@battlefield/core";
import { type Kysely, sql } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

export class KyselyWorkerExecutionLeaseStore
  implements WorkerExecutionLeaseStore
{
  constructor(private readonly database: Kysely<BattlefieldDatabase>) {}

  async acquire(
    input: Parameters<WorkerExecutionLeaseStore["acquire"]>[0],
  ): Promise<boolean> {
    const leaseExpiresAt = expiry(input.observedAt, input.leaseMs);
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const result = await sql<{ instance_id: string }>`
          insert into app.worker_execution_leases as current_lease (
            tenant_id,
            worker_key,
            instance_id,
            acquired_at,
            renewed_at,
            lease_expires_at
          ) values (
            ${input.actor.tenantId}::uuid,
            ${input.workerKey},
            ${input.instanceId}::uuid,
            ${input.observedAt}::timestamptz,
            ${input.observedAt}::timestamptz,
            ${leaseExpiresAt}::timestamptz
          )
          on conflict (tenant_id, worker_key) do update set
            instance_id = excluded.instance_id,
            acquired_at = excluded.acquired_at,
            renewed_at = excluded.renewed_at,
            lease_expires_at = excluded.lease_expires_at
          where current_lease.instance_id = excluded.instance_id
            or current_lease.lease_expires_at <= excluded.acquired_at
          returning instance_id::text as instance_id
        `.execute(transaction);
        return result.rows[0]?.instance_id === input.instanceId;
      },
    );
  }

  async renew(
    input: Parameters<WorkerExecutionLeaseStore["renew"]>[0],
  ): Promise<boolean> {
    const leaseExpiresAt = expiry(input.observedAt, input.leaseMs);
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const result = await transaction
          .updateTable("app.worker_execution_leases")
          .set({
            renewed_at: input.observedAt,
            lease_expires_at: leaseExpiresAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("worker_key", "=", input.workerKey)
          .where("instance_id", "=", input.instanceId)
          .where("lease_expires_at", ">", new Date(input.observedAt))
          .executeTakeFirst();
        return result.numUpdatedRows === 1n;
      },
    );
  }

  async release(
    input: Parameters<WorkerExecutionLeaseStore["release"]>[0],
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      (transaction) =>
        transaction
          .deleteFrom("app.worker_execution_leases")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("worker_key", "=", input.workerKey)
          .where("instance_id", "=", input.instanceId)
          .executeTakeFirst()
          .then(() => undefined),
    );
  }
}

function expiry(observedAt: string, leaseMs: number): string {
  const observed = new Date(observedAt);
  if (
    Number.isNaN(observed.getTime()) ||
    !Number.isInteger(leaseMs) ||
    leaseMs < 1_000 ||
    leaseMs > 3_600_000
  ) {
    throw new Error("Worker execution lease input is invalid.");
  }
  return new Date(observed.getTime() + leaseMs).toISOString();
}
