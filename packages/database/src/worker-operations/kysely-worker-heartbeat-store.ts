import { randomUUID } from "node:crypto";
import type { WorkerHeartbeatReporter } from "@battlefield/core";
import type { Kysely, Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

export class WorkerHeartbeatInstanceLostError extends Error {
  constructor() {
    super("Worker heartbeat ownership moved to another instance.");
    this.name = "WorkerHeartbeatInstanceLostError";
  }
}

export class KyselyWorkerHeartbeatStore implements WorkerHeartbeatReporter {
  constructor(private readonly database: Kysely<BattlefieldDatabase>) {}

  async register(
    input: Parameters<WorkerHeartbeatReporter["register"]>[0],
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      (transaction) =>
        transaction
          .insertInto("app.worker_heartbeats")
          .values({
            tenant_id: input.actor.tenantId,
            worker_key: input.workerKey,
            instance_id: input.instanceId,
            started_at: input.startedAt,
            expected_interval_ms: input.expectedIntervalMs,
            lease_ms: input.leaseMs,
            last_tick_started_at: null,
            last_tick_completed_at: null,
            last_success_at: null,
            last_failure_at: null,
            last_error_code: null,
            last_error_message: null,
            last_tick_summary: JSON.stringify({}),
            updated_at: input.startedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "worker_key"]).doUpdateSet({
              instance_id: input.instanceId,
              started_at: input.startedAt,
              expected_interval_ms: input.expectedIntervalMs,
              lease_ms: input.leaseMs,
              last_tick_started_at: null,
              last_tick_completed_at: null,
              last_success_at: null,
              last_failure_at: null,
              last_error_code: null,
              last_error_message: null,
              last_tick_summary: JSON.stringify({}),
              updated_at: input.startedAt,
            }),
          )
          .executeTakeFirstOrThrow(),
    );
  }

  async markTickStarted(
    input: Parameters<WorkerHeartbeatReporter["markTickStarted"]>[0],
  ): Promise<void> {
    await this.updateOwned(input, (transaction) =>
      transaction
        .updateTable("app.worker_heartbeats")
        .set({
          last_tick_started_at: input.startedAt,
          last_tick_completed_at: null,
          updated_at: input.startedAt,
        })
        .where("tenant_id", "=", input.actor.tenantId)
        .where("worker_key", "=", input.workerKey)
        .where("instance_id", "=", input.instanceId)
        .executeTakeFirst(),
    );
  }

  async markTickSucceeded(
    input: Parameters<WorkerHeartbeatReporter["markTickSucceeded"]>[0],
  ): Promise<void> {
    await this.updateOwned(input, (transaction) =>
      transaction
        .updateTable("app.worker_heartbeats")
        .set({
          last_tick_completed_at: input.completedAt,
          last_success_at: input.completedAt,
          last_error_code: null,
          last_error_message: null,
          last_tick_summary: JSON.stringify(input.summary),
          updated_at: input.completedAt,
        })
        .where("tenant_id", "=", input.actor.tenantId)
        .where("worker_key", "=", input.workerKey)
        .where("instance_id", "=", input.instanceId)
        .executeTakeFirst(),
    );
  }

  async markTickFailed(
    input: Parameters<WorkerHeartbeatReporter["markTickFailed"]>[0],
  ): Promise<void> {
    await this.updateOwned(input, (transaction) =>
      transaction
        .updateTable("app.worker_heartbeats")
        .set({
          last_tick_completed_at: input.failedAt,
          last_failure_at: input.failedAt,
          last_error_code: input.errorCode,
          last_error_message: input.errorMessage,
          last_tick_summary: JSON.stringify({}),
          updated_at: input.failedAt,
        })
        .where("tenant_id", "=", input.actor.tenantId)
        .where("worker_key", "=", input.workerKey)
        .where("instance_id", "=", input.instanceId)
        .executeTakeFirst(),
    );
  }

  private async updateOwned(
    input: {
      actor: { tenantId: string; userId: string };
      workerKey: string;
      instanceId: string;
    },
    update: (
      transaction: DatabaseTransaction,
    ) => Promise<{ numUpdatedRows: bigint }>,
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const result = await update(transaction);
        if (result.numUpdatedRows !== 1n) {
          throw new WorkerHeartbeatInstanceLostError();
        }
      },
    );
  }
}
