import { fileURLToPath } from "node:url";
import {
  AsyncWorkReplayConflictError,
  WorkerOperationsAccessDeniedError,
} from "@battlefield/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import {
  createPgliteDatabase,
  SYNTHETIC_MANAGER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticManagementObserver,
  seedSyntheticTwoLevelIdentity,
} from "../src/testing/index.js";
import { KyselyWorkerHeartbeatStore } from "../src/worker-operations/kysely-worker-heartbeat-store.js";
import { KyselyWorkerOperationsRepository } from "../src/worker-operations/kysely-worker-operations-repository.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const OUTBOX_ID = "d1000000-0000-4000-8000-000000000001";
const EVENT_ID = "d2000000-0000-4000-8000-000000000001";
const INSTANCE_ID = "d3000000-0000-4000-8000-000000000001";
const REQUEST_ID = "d4000000-0000-4000-8000-000000000001";
const managerActor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_MANAGER_USER_ID,
};
const workerActor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_USER_ID,
};

describe("KyselyWorkerOperationsRepository", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let repository: KyselyWorkerOperationsRepository;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    await seedSyntheticTwoLevelIdentity(database);
    await seedDeadLetteredOutbox(database);
    repository = new KyselyWorkerOperationsRepository(database.db, {
      requestIdFactory: () => REQUEST_ID,
      clock: { now: () => new Date("2026-09-01T06:00:00.000Z") },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("reports heartbeat state and bounded queue failure counts", async () => {
    const heartbeats = new KyselyWorkerHeartbeatStore(database.db);
    await heartbeats.register({
      actor: workerActor,
      workerKey: "reminder_worker",
      instanceId: INSTANCE_ID,
      startedAt: "2026-09-01T05:59:00.000Z",
      expectedIntervalMs: 5_000,
      leaseMs: 60_000,
    });
    await heartbeats.markTickStarted({
      actor: workerActor,
      workerKey: "reminder_worker",
      instanceId: INSTANCE_ID,
      startedAt: "2026-09-01T05:59:50.000Z",
    });
    await heartbeats.markTickSucceeded({
      actor: workerActor,
      workerKey: "reminder_worker",
      instanceId: INSTANCE_ID,
      completedAt: "2026-09-01T05:59:51.000Z",
      summary: { recovered: 0, claimed: 1, completed: 0, failed: 1 },
    });
    await heartbeats.markTickStarted({
      actor: workerActor,
      workerKey: "reminder_worker",
      instanceId: INSTANCE_ID,
      startedAt: "2026-09-01T05:59:55.000Z",
    });
    await heartbeats.markTickSucceeded({
      actor: workerActor,
      workerKey: "reminder_worker",
      instanceId: INSTANCE_ID,
      completedAt: "2026-09-01T05:59:56.000Z",
      summary: { recovered: 0, claimed: 0, completed: 0, failed: 0 },
    });

    await expect(
      repository.getHealth({ actor: managerActor }),
    ).resolves.toEqual({
      observedAt: "2026-09-01T06:00:00.000Z",
      worker: {
        workerKey: "reminder_worker",
        state: "healthy",
        instanceId: INSTANCE_ID,
        startedAt: "2026-09-01T05:59:00.000Z",
        lastTickStartedAt: "2026-09-01T05:59:55.000Z",
        lastTickCompletedAt: "2026-09-01T05:59:56.000Z",
        lastSuccessAt: "2026-09-01T05:59:56.000Z",
        lastFailureAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      queues: [
        {
          kind: "outbox",
          readyCount: 0,
          processingCount: 0,
          failedCount: 0,
          deadLetteredCount: 1,
          oldestReadyAt: null,
        },
        {
          kind: "reminder",
          readyCount: 0,
          processingCount: 0,
          failedCount: 0,
          deadLetteredCount: 0,
          oldestReadyAt: null,
        },
        {
          kind: "notification_delivery",
          readyCount: 0,
          processingCount: 0,
          failedCount: 0,
          deadLetteredCount: 0,
          oldestReadyAt: null,
        },
      ],
    });
  });

  test("lists metadata-only failures and idempotently replays with audit history", async () => {
    await expect(
      repository.listFailures({ actor: managerActor, limit: 20 }),
    ).resolves.toEqual({
      items: [
        {
          kind: "outbox",
          workItemId: OUTBOX_ID,
          category: "synthetic.unknown.v1",
          status: "dead_lettered",
          attemptCount: 8,
          lastErrorCode: "UNKNOWN_OUTBOX_TOPIC",
          lastErrorMessage: "No handler is registered for this topic.",
          availableAt: "2026-09-01T05:00:00.000Z",
          claimedAt: null,
          createdAt: "2026-09-01T05:00:00.000Z",
          relatedResource: {
            type: "business_entity",
            id: "50000000-0000-4000-8000-000000000001",
          },
        },
      ],
      nextCursor: null,
    });

    const replayInput = {
      actor: managerActor,
      kind: "outbox" as const,
      workItemId: OUTBOX_ID,
      reason: "处理器已部署，重新执行",
      idempotencyKey: "worker-replay-1",
    };
    const first = await repository.replay(replayInput);
    expect(await repository.replay(replayInput)).toEqual(first);
    await expect(
      repository.replay({ ...replayInput, reason: "不同的请求" }),
    ).rejects.toBeInstanceOf(AsyncWorkReplayConflictError);

    const state = await withTenantTransaction(
      database.db,
      { ...managerActor, requestId: REQUEST_ID },
      async (transaction) => ({
        outbox: await transaction
          .selectFrom("app.outbox_messages")
          .select(["status", "attempt_count", "last_error_code", "last_error"])
          .where("tenant_id", "=", managerActor.tenantId)
          .where("id", "=", OUTBOX_ID)
          .executeTakeFirstOrThrow(),
        replayCount: Number(
          (
            await transaction
              .selectFrom("app.async_work_replay_history")
              .select(({ fn }) => fn.countAll().as("count"))
              .where("tenant_id", "=", managerActor.tenantId)
              .executeTakeFirstOrThrow()
          ).count,
        ),
        auditCount: Number(
          (
            await transaction
              .selectFrom("app.audit_entries")
              .select(({ fn }) => fn.countAll().as("count"))
              .where("tenant_id", "=", managerActor.tenantId)
              .where("aggregate_type", "=", "async_work")
              .where("aggregate_id", "=", OUTBOX_ID)
              .where("action", "=", "async_work.replayed")
              .executeTakeFirstOrThrow()
          ).count,
        ),
      }),
    );
    expect(state).toEqual({
      outbox: {
        status: "pending",
        attempt_count: 0,
        last_error_code: null,
        last_error: null,
      },
      replayCount: 1,
      auditCount: 1,
    });
  });

  test("requires a current leader membership even inside the database adapter", async () => {
    await expect(
      repository.listFailures({ actor: workerActor, limit: 20 }),
    ).rejects.toBeInstanceOf(WorkerOperationsAccessDeniedError);
  });
});

async function seedDeadLetteredOutbox(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...workerActor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .insertInto("app.domain_events")
        .values({
          tenant_id: workerActor.tenantId,
          id: EVENT_ID,
          aggregate_type: "business_entity",
          aggregate_id: "50000000-0000-4000-8000-000000000001",
          event_type: "synthetic.unknown.v1",
          event_version: 1,
          payload: JSON.stringify({ synthetic: true }),
          occurred_at: "2026-09-01T05:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.outbox_messages")
        .values({
          tenant_id: workerActor.tenantId,
          id: OUTBOX_ID,
          event_id: EVENT_ID,
          topic: "synthetic.unknown.v1",
          payload: JSON.stringify({ synthetic: true }),
          status: "dead_lettered",
          dedupe_key: "synthetic-worker-dead-letter",
          available_at: "2026-09-01T05:00:00.000Z",
          attempt_count: 8,
          last_error_code: "UNKNOWN_OUTBOX_TOPIC",
          last_error: "No handler is registered for this topic.",
          claim_token: null,
          claimed_at: null,
          published_at: null,
          created_at: "2026-09-01T05:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
    },
  );
}
