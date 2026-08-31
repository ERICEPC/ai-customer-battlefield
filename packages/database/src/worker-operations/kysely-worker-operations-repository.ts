import { createHash, randomUUID } from "node:crypto";
import {
  type AsyncWorkFailureRecord,
  type AsyncWorkFailureStatus,
  AsyncWorkItemNotFoundError,
  AsyncWorkItemNotReplayableError,
  type AsyncWorkKind,
  AsyncWorkReplayConflictError,
  InvalidAsyncWorkCursorError,
  WorkerOperationsAccessDeniedError,
  type WorkerOperationsRepository,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import { appendAuditEntry } from "../audit/append-audit-entry.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface FailureCursor {
  createdAt: string;
  kind: AsyncWorkKind;
  workItemId: string;
}

interface QueueMetricRow {
  kind: AsyncWorkKind;
  ready_count: number | string | bigint;
  processing_count: number | string | bigint;
  failed_count: number | string | bigint;
  dead_lettered_count: number | string | bigint;
  oldest_ready_at: Date | string | null;
}

interface PriorFailure {
  status: AsyncWorkFailureStatus;
  attemptCount: number;
  errorCode: string;
  errorMessage: string;
}

export interface KyselyWorkerOperationsRepositoryOptions {
  workerKey?: string;
  requestIdFactory?: () => string;
  clock?: { now(): Date };
}

export class KyselyWorkerOperationsRepository
  implements WorkerOperationsRepository
{
  private readonly workerKey: string;
  private readonly requestIdFactory: () => string;
  private readonly clock: { now(): Date };

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyWorkerOperationsRepositoryOptions = {},
  ) {
    this.workerKey = options.workerKey ?? "reminder_worker";
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async getHealth(
    input: Parameters<WorkerOperationsRepository["getHealth"]>[0],
  ) {
    const observedAt = this.clock.now();
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        await assertOperator(transaction, input.actor);
        const heartbeat = await transaction
          .selectFrom("app.worker_heartbeats")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("worker_key", "=", this.workerKey)
          .executeTakeFirst();
        const metrics = await queueMetrics(
          transaction,
          input.actor.tenantId,
          observedAt,
        );
        return {
          observedAt: observedAt.toISOString(),
          worker: heartbeat
            ? mapHeartbeat(heartbeat, observedAt)
            : {
                workerKey: this.workerKey,
                state: "never_started" as const,
                instanceId: null,
                startedAt: null,
                lastTickStartedAt: null,
                lastTickCompletedAt: null,
                lastSuccessAt: null,
                lastFailureAt: null,
                lastErrorCode: null,
                lastErrorMessage: null,
              },
          queues: metrics.map((metric) => ({
            kind: metric.kind,
            readyCount: Number(metric.ready_count),
            processingCount: Number(metric.processing_count),
            failedCount: Number(metric.failed_count),
            deadLetteredCount: Number(metric.dead_lettered_count),
            oldestReadyAt: nullableIso(metric.oldest_ready_at),
          })),
        };
      },
    );
  }

  async listFailures(
    input: Parameters<WorkerOperationsRepository["listFailures"]>[0],
  ) {
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        await assertOperator(transaction, input.actor);
        const candidates: AsyncWorkFailureRecord[] = [];
        if (!input.kind || input.kind === "outbox") {
          candidates.push(
            ...(await listOutboxFailures(transaction, input, cursor)),
          );
        }
        if (!input.kind || input.kind === "reminder") {
          candidates.push(
            ...(await listReminderFailures(transaction, input, cursor)),
          );
        }
        if (!input.kind || input.kind === "notification_delivery") {
          candidates.push(
            ...(await listDeliveryFailures(transaction, input, cursor)),
          );
        }
        const ordered = candidates
          .filter((item) => !cursor || comesAfterCursor(item, cursor))
          .sort(compareFailures);
        const hasNextPage = ordered.length > input.limit;
        const items = ordered.slice(0, input.limit);
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            hasNextPage && last
              ? encodeCursor({
                  createdAt: last.createdAt,
                  kind: last.kind,
                  workItemId: last.workItemId,
                })
              : null,
        };
      },
    );
  }

  async replay(input: Parameters<WorkerOperationsRepository["replay"]>[0]) {
    const requestId = this.requestIdFactory();
    const requestHash = replayRequestHash(input);
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        await assertOperator(transaction, input.actor);
        await sql`select pg_advisory_xact_lock(hashtext(${`${input.actor.tenantId}:async-work:${input.idempotencyKey}`}))`.execute(
          transaction,
        );
        const existing = await transaction
          .selectFrom("app.async_work_replay_history")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("idempotency_key", "=", input.idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new AsyncWorkReplayConflictError();
          }
          return {
            replayId: existing.id,
            kind: existing.work_kind,
            workItemId: existing.work_item_id,
            status: "queued" as const,
            replayedAt: toIso(existing.replayed_at),
          };
        }

        const prior = await queueForReplay(transaction, input);
        const replayedAt = await currentTimestamp(transaction);
        const replayId = randomUUID();
        await transaction
          .insertInto("app.async_work_replay_history")
          .values({
            tenant_id: input.actor.tenantId,
            id: replayId,
            work_kind: input.kind,
            work_item_id: input.workItemId,
            prior_status: prior.status,
            prior_attempt_count: prior.attemptCount,
            prior_error_code: prior.errorCode,
            prior_error_message: safeMessage(prior.errorMessage),
            reason: input.reason,
            idempotency_key: input.idempotencyKey,
            request_hash: requestHash,
            replayed_by: input.actor.userId,
            replayed_at: replayedAt,
          })
          .executeTakeFirstOrThrow();
        await appendAuditEntry(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "async_work",
          aggregateId: input.workItemId,
          action: "async_work.replayed",
          occurredAt: replayedAt.toISOString(),
          requestId,
          beforePayload: {
            kind: input.kind,
            status: prior.status,
            attemptCount: prior.attemptCount,
            errorCode: prior.errorCode,
          },
          afterPayload: { kind: input.kind, status: "queued" },
          reason: input.reason,
        });
        return {
          replayId,
          kind: input.kind,
          workItemId: input.workItemId,
          status: "queued" as const,
          replayedAt: replayedAt.toISOString(),
        };
      },
    );
  }
}

async function queueMetrics(
  transaction: DatabaseTransaction,
  tenantId: string,
  now: Date,
): Promise<QueueMetricRow[]> {
  const result = await sql<QueueMetricRow>`
    select
      'outbox'::text as kind,
      count(*) filter (
        where status in ('pending', 'failed') and available_at <= ${now}
      ) as ready_count,
      count(*) filter (where status = 'processing') as processing_count,
      count(*) filter (where status = 'failed') as failed_count,
      count(*) filter (where status = 'dead_lettered') as dead_lettered_count,
      min(available_at) filter (
        where status in ('pending', 'failed') and available_at <= ${now}
      ) as oldest_ready_at
    from app.outbox_messages
    where tenant_id = ${tenantId}
    union all
    select
      'reminder'::text as kind,
      count(*) filter (
        where status in ('scheduled', 'failed') and available_at <= ${now}
      ),
      count(*) filter (where status = 'processing'),
      count(*) filter (where status = 'failed'),
      count(*) filter (where status = 'dead_lettered'),
      min(available_at) filter (
        where status in ('scheduled', 'failed') and available_at <= ${now}
      )
    from app.reminder_instances
    where tenant_id = ${tenantId}
    union all
    select
      'notification_delivery'::text as kind,
      count(*) filter (
        where status in ('pending', 'failed') and available_at <= ${now}
      ),
      count(*) filter (where status = 'processing'),
      count(*) filter (where status = 'failed'),
      count(*) filter (where status = 'dead_lettered'),
      min(available_at) filter (
        where status in ('pending', 'failed') and available_at <= ${now}
      )
    from app.notification_deliveries
    where tenant_id = ${tenantId}
  `.execute(transaction);
  return result.rows;
}

async function listOutboxFailures(
  transaction: DatabaseTransaction,
  input: Parameters<WorkerOperationsRepository["listFailures"]>[0],
  cursor?: FailureCursor,
): Promise<AsyncWorkFailureRecord[]> {
  let query = transaction
    .selectFrom("app.outbox_messages as item")
    .innerJoin("app.domain_events as event", (join) =>
      join
        .onRef("event.tenant_id", "=", "item.tenant_id")
        .onRef("event.id", "=", "item.event_id"),
    )
    .select([
      "item.id",
      "item.topic",
      "item.status",
      "item.attempt_count",
      "item.last_error_code",
      "item.last_error",
      "item.available_at",
      "item.claimed_at",
      "item.created_at",
      "event.aggregate_type",
      "event.aggregate_id",
    ])
    .where("item.tenant_id", "=", input.actor.tenantId)
    .where("item.status", "in", failureStatuses(input.status));
  if (cursor) {
    query = query.where("item.created_at", "<=", new Date(cursor.createdAt));
  }
  const rows = await query
    .orderBy("item.created_at", "desc")
    .orderBy("item.id", "desc")
    .limit(input.limit + 1)
    .execute();
  return rows.map((row) => ({
    kind: "outbox",
    workItemId: row.id,
    category: safeCategory(row.topic),
    status: failureStatus(row.status),
    attemptCount: row.attempt_count,
    lastErrorCode: requiredError(row.last_error_code),
    lastErrorMessage: safeMessage(requiredError(row.last_error)),
    availableAt: toIso(row.available_at),
    claimedAt: nullableIso(row.claimed_at),
    createdAt: toIso(row.created_at),
    relatedResource: {
      type: safeCategory(row.aggregate_type, 100),
      id: row.aggregate_id,
    },
  }));
}

async function listReminderFailures(
  transaction: DatabaseTransaction,
  input: Parameters<WorkerOperationsRepository["listFailures"]>[0],
  cursor?: FailureCursor,
): Promise<AsyncWorkFailureRecord[]> {
  let query = transaction
    .selectFrom("app.reminder_instances")
    .select([
      "id",
      "kind",
      "status",
      "attempt_count",
      "last_error_code",
      "last_error_message",
      "available_at",
      "claimed_at",
      "created_at",
      "action_id",
    ])
    .where("tenant_id", "=", input.actor.tenantId)
    .where("status", "in", failureStatuses(input.status));
  if (cursor) {
    query = query.where("created_at", "<=", new Date(cursor.createdAt));
  }
  const rows = await query
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(input.limit + 1)
    .execute();
  return rows.map((row) => ({
    kind: "reminder",
    workItemId: row.id,
    category: row.kind,
    status: failureStatus(row.status),
    attemptCount: row.attempt_count,
    lastErrorCode: requiredError(row.last_error_code),
    lastErrorMessage: safeMessage(requiredError(row.last_error_message)),
    availableAt: toIso(row.available_at),
    claimedAt: nullableIso(row.claimed_at),
    createdAt: toIso(row.created_at),
    relatedResource: { type: "business_action", id: row.action_id },
  }));
}

async function listDeliveryFailures(
  transaction: DatabaseTransaction,
  input: Parameters<WorkerOperationsRepository["listFailures"]>[0],
  cursor?: FailureCursor,
): Promise<AsyncWorkFailureRecord[]> {
  let query = transaction
    .selectFrom("app.notification_deliveries")
    .select([
      "id",
      "channel",
      "status",
      "attempt_count",
      "last_error_code",
      "last_error_message",
      "available_at",
      "claimed_at",
      "created_at",
      "notification_event_id",
    ])
    .where("tenant_id", "=", input.actor.tenantId)
    .where("status", "in", failureStatuses(input.status));
  if (cursor) {
    query = query.where("created_at", "<=", new Date(cursor.createdAt));
  }
  const rows = await query
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(input.limit + 1)
    .execute();
  return rows.map((row) => ({
    kind: "notification_delivery",
    workItemId: row.id,
    category: row.channel,
    status: failureStatus(row.status),
    attemptCount: row.attempt_count,
    lastErrorCode: requiredError(row.last_error_code),
    lastErrorMessage: safeMessage(requiredError(row.last_error_message)),
    availableAt: toIso(row.available_at),
    claimedAt: nullableIso(row.claimed_at),
    createdAt: toIso(row.created_at),
    relatedResource: {
      type: "notification_event",
      id: row.notification_event_id,
    },
  }));
}

async function queueForReplay(
  transaction: DatabaseTransaction,
  input: Parameters<WorkerOperationsRepository["replay"]>[0],
): Promise<PriorFailure> {
  if (input.kind === "outbox") {
    const row = await transaction
      .selectFrom("app.outbox_messages")
      .select(["status", "attempt_count", "last_error_code", "last_error"])
      .where("tenant_id", "=", input.actor.tenantId)
      .where("id", "=", input.workItemId)
      .forUpdate()
      .executeTakeFirst();
    const prior = priorFailure(
      row?.status,
      row?.attempt_count,
      row?.last_error_code,
      row?.last_error,
    );
    await transaction
      .updateTable("app.outbox_messages")
      .set({
        status: "pending",
        available_at: sql`current_timestamp`,
        attempt_count: 0,
        claim_token: null,
        claimed_at: null,
        last_error_code: null,
        last_error: null,
        published_at: null,
      })
      .where("tenant_id", "=", input.actor.tenantId)
      .where("id", "=", input.workItemId)
      .executeTakeFirstOrThrow();
    return prior;
  }
  if (input.kind === "reminder") {
    const row = await transaction
      .selectFrom("app.reminder_instances")
      .select([
        "status",
        "attempt_count",
        "last_error_code",
        "last_error_message",
      ])
      .where("tenant_id", "=", input.actor.tenantId)
      .where("id", "=", input.workItemId)
      .forUpdate()
      .executeTakeFirst();
    const prior = priorFailure(
      row?.status,
      row?.attempt_count,
      row?.last_error_code,
      row?.last_error_message,
    );
    await transaction
      .updateTable("app.reminder_instances")
      .set({
        status: "scheduled",
        available_at: sql`current_timestamp`,
        attempt_count: 0,
        claim_token: null,
        claimed_at: null,
        last_error_code: null,
        last_error_message: null,
        updated_at: sql`current_timestamp`,
      })
      .where("tenant_id", "=", input.actor.tenantId)
      .where("id", "=", input.workItemId)
      .executeTakeFirstOrThrow();
    return prior;
  }
  const row = await transaction
    .selectFrom("app.notification_deliveries")
    .select([
      "status",
      "attempt_count",
      "last_error_code",
      "last_error_message",
    ])
    .where("tenant_id", "=", input.actor.tenantId)
    .where("id", "=", input.workItemId)
    .forUpdate()
    .executeTakeFirst();
  const prior = priorFailure(
    row?.status,
    row?.attempt_count,
    row?.last_error_code,
    row?.last_error_message,
  );
  await transaction
    .updateTable("app.notification_deliveries")
    .set({
      status: "pending",
      available_at: sql`current_timestamp`,
      attempt_count: 0,
      claim_token: null,
      claimed_at: null,
      last_error_code: null,
      last_error_message: null,
      delivered_at: null,
      provider_message_id: null,
      provider_request_id: null,
      updated_at: sql`current_timestamp`,
    })
    .where("tenant_id", "=", input.actor.tenantId)
    .where("id", "=", input.workItemId)
    .executeTakeFirstOrThrow();
  return prior;
}

function priorFailure(
  status: string | undefined,
  attemptCount: number | undefined,
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): PriorFailure {
  if (status === undefined) throw new AsyncWorkItemNotFoundError();
  if (status !== "failed" && status !== "dead_lettered") {
    throw new AsyncWorkItemNotReplayableError();
  }
  if (attemptCount === undefined || !errorCode || !errorMessage) {
    throw new AsyncWorkItemNotReplayableError();
  }
  return { status, attemptCount, errorCode, errorMessage };
}

async function assertOperator(
  transaction: DatabaseTransaction,
  actor: { tenantId: string; userId: string },
): Promise<void> {
  const membership = await transaction
    .selectFrom("app.user_memberships")
    .select("id")
    .where("tenant_id", "=", actor.tenantId)
    .where("user_id", "=", actor.userId)
    .where("role_code", "=", "department_leader")
    .where("valid_from", "<=", sql<Date>`current_timestamp`)
    .where((expression) =>
      expression.or([
        expression("valid_to", "is", null),
        expression("valid_to", ">", sql<Date>`current_timestamp`),
      ]),
    )
    .executeTakeFirst();
  if (!membership) throw new WorkerOperationsAccessDeniedError();
}

function mapHeartbeat(
  row: {
    worker_key: string;
    instance_id: string;
    started_at: Date | string;
    expected_interval_ms: number;
    lease_ms: number;
    last_tick_started_at: Date | string | null;
    last_tick_completed_at: Date | string | null;
    last_success_at: Date | string | null;
    last_failure_at: Date | string | null;
    last_error_code: string | null;
    last_error_message: string | null;
  },
  observedAt: Date,
) {
  const reference = new Date(
    row.last_tick_completed_at ?? row.last_tick_started_at ?? row.started_at,
  );
  const staleAfterMs = Math.max(row.expected_interval_ms * 3, row.lease_ms * 2);
  const lastSuccess = row.last_success_at
    ? new Date(row.last_success_at)
    : null;
  const lastFailure = row.last_failure_at
    ? new Date(row.last_failure_at)
    : null;
  const state =
    observedAt.getTime() - reference.getTime() > staleAfterMs
      ? "stale"
      : !lastSuccess ||
          (lastFailure && lastFailure.getTime() > lastSuccess.getTime())
        ? "degraded"
        : "healthy";
  return {
    workerKey: row.worker_key,
    state,
    instanceId: row.instance_id,
    startedAt: toIso(row.started_at),
    lastTickStartedAt: nullableIso(row.last_tick_started_at),
    lastTickCompletedAt: nullableIso(row.last_tick_completed_at),
    lastSuccessAt: nullableIso(row.last_success_at),
    lastFailureAt: nullableIso(row.last_failure_at),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  } as const;
}

function failureStatuses(
  status?: AsyncWorkFailureStatus,
): AsyncWorkFailureStatus[] {
  return status ? [status] : ["failed", "dead_lettered"];
}

function failureStatus(value: string): AsyncWorkFailureStatus {
  if (value !== "failed" && value !== "dead_lettered") {
    throw new InvalidAsyncWorkCursorError();
  }
  return value;
}

function requiredError(value: string | null): string {
  if (!value) throw new InvalidAsyncWorkCursorError();
  return value;
}

function safeCategory(value: string, maximum = 200): string {
  return value.slice(0, maximum) || "unknown";
}

function safeMessage(value: string): string {
  return value.slice(0, 500) || "Unknown worker failure.";
}

function compareFailures(
  left: AsyncWorkFailureRecord,
  right: AsyncWorkFailureRecord,
): number {
  const time = right.createdAt.localeCompare(left.createdAt);
  if (time !== 0) return time;
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;
  return right.workItemId.localeCompare(left.workItemId);
}

function comesAfterCursor(
  item: AsyncWorkFailureRecord,
  cursor: FailureCursor,
): boolean {
  if (item.createdAt !== cursor.createdAt) {
    return item.createdAt < cursor.createdAt;
  }
  if (item.kind !== cursor.kind) return item.kind > cursor.kind;
  return item.workItemId < cursor.workItemId;
}

function replayRequestHash(
  input: Parameters<WorkerOperationsRepository["replay"]>[0],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        workItemId: input.workItemId,
        reason: input.reason,
      }),
    )
    .digest("hex");
}

function encodeCursor(cursor: FailureCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): FailureCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("non-canonical encoding");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "createdAt,kind,workItemId"
    ) {
      throw new Error("invalid payload");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt)) ||
      !["outbox", "reminder", "notification_delivery"].includes(
        String(candidate.kind),
      ) ||
      typeof candidate.workItemId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.workItemId,
      )
    ) {
      throw new Error("invalid values");
    }
    return {
      createdAt: new Date(candidate.createdAt).toISOString(),
      kind: candidate.kind as AsyncWorkKind,
      workItemId: candidate.workItemId,
    };
  } catch (error) {
    throw new InvalidAsyncWorkCursorError({ cause: error });
  }
}

async function currentTimestamp(transaction: DatabaseTransaction) {
  const row = await sql<{ now: Date }>`select current_timestamp as now`.execute(
    transaction,
  );
  const now = row.rows[0]?.now;
  if (!now) throw new AsyncWorkItemNotReplayableError();
  return now;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}
