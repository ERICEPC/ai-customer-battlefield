import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export type AsyncWorkKind = "outbox" | "reminder" | "notification_delivery";
export type AsyncWorkFailureStatus = "failed" | "dead_lettered";

export interface WorkerOperationsHealth {
  observedAt: string;
  worker: {
    workerKey: string;
    state: "healthy" | "degraded" | "stale" | "never_started";
    instanceId: string | null;
    startedAt: string | null;
    lastTickStartedAt: string | null;
    lastTickCompletedAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  };
  queues: Array<{
    kind: AsyncWorkKind;
    readyCount: number;
    processingCount: number;
    failedCount: number;
    deadLetteredCount: number;
    oldestReadyAt: string | null;
  }>;
}

export interface AsyncWorkFailureRecord {
  kind: AsyncWorkKind;
  workItemId: string;
  category: string;
  status: AsyncWorkFailureStatus;
  attemptCount: number;
  lastErrorCode: string;
  lastErrorMessage: string;
  availableAt: string;
  claimedAt: string | null;
  createdAt: string;
  relatedResource: { type: string; id: string } | null;
}

export interface AsyncWorkFailurePage {
  items: AsyncWorkFailureRecord[];
  nextCursor: string | null;
}

export interface AsyncWorkReplayResult {
  replayId: string;
  kind: AsyncWorkKind;
  workItemId: string;
  status: "queued";
  replayedAt: string;
}

export interface WorkerOperationsRepository {
  getHealth(input: { actor: ActorScope }): Promise<WorkerOperationsHealth>;
  listFailures(input: {
    actor: ActorScope;
    limit: number;
    cursor?: string;
    kind?: AsyncWorkKind;
    status?: AsyncWorkFailureStatus;
  }): Promise<AsyncWorkFailurePage>;
  replay(input: {
    actor: ActorScope;
    kind: AsyncWorkKind;
    workItemId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<AsyncWorkReplayResult>;
}

export interface WorkerHeartbeatReporter {
  register(input: {
    actor: ActorScope;
    workerKey: string;
    instanceId: string;
    startedAt: string;
    expectedIntervalMs: number;
    leaseMs: number;
  }): Promise<void>;
  markTickStarted(input: {
    actor: ActorScope;
    workerKey: string;
    instanceId: string;
    startedAt: string;
  }): Promise<void>;
  markTickSucceeded(input: {
    actor: ActorScope;
    workerKey: string;
    instanceId: string;
    completedAt: string;
    summary: {
      recovered: number;
      claimed: number;
      completed: number;
      failed: number;
    };
  }): Promise<void>;
  markTickFailed(input: {
    actor: ActorScope;
    workerKey: string;
    instanceId: string;
    failedAt: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
}

export interface WorkerExecutionLeaseStore {
  acquire(input: {
    actor: ActorScope;
    workerKey: string;
    instanceId: string;
    observedAt: string;
    leaseMs: number;
  }): Promise<boolean>;
  renew(input: {
    actor: ActorScope;
    workerKey: string;
    instanceId: string;
    observedAt: string;
    leaseMs: number;
  }): Promise<boolean>;
  release(input: {
    actor: ActorScope;
    workerKey: string;
    instanceId: string;
  }): Promise<void>;
}

export class GetWorkerOperationsHealth {
  constructor(private readonly repository: WorkerOperationsRepository) {}

  execute(input: { actor: ActorScope }): Promise<WorkerOperationsHealth> {
    return this.repository.getHealth(input);
  }
}

export class ListAsyncWorkFailures {
  constructor(private readonly repository: WorkerOperationsRepository) {}

  execute(input: {
    actor: ActorScope;
    limit: number;
    cursor?: string;
    kind?: AsyncWorkKind;
    status?: AsyncWorkFailureStatus;
  }): Promise<AsyncWorkFailurePage> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new InvalidAsyncWorkListInputError();
    }
    if (input.cursor !== undefined && input.cursor.trim().length === 0) {
      throw new InvalidAsyncWorkListInputError();
    }
    return this.repository.listFailures(input);
  }
}

export class ReplayAsyncWorkItem {
  constructor(private readonly repository: WorkerOperationsRepository) {}

  execute(input: {
    actor: ActorScope;
    kind: AsyncWorkKind;
    workItemId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<AsyncWorkReplayResult> {
    const reason = input.reason.trim();
    if (
      !UUID_PATTERN.test(input.workItemId) ||
      reason.length < 1 ||
      reason.length > 1_000 ||
      !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
    ) {
      throw new InvalidAsyncWorkReplayInputError();
    }
    return this.repository.replay({ ...input, reason });
  }
}

export class InvalidAsyncWorkListInputError extends Error {
  constructor() {
    super("Async-work failure list input is invalid.");
    this.name = "InvalidAsyncWorkListInputError";
  }
}

export class InvalidAsyncWorkReplayInputError extends Error {
  constructor() {
    super("Async-work replay input is invalid.");
    this.name = "InvalidAsyncWorkReplayInputError";
  }
}

export class InvalidAsyncWorkCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super("Async-work failure cursor is invalid.", options);
    this.name = "InvalidAsyncWorkCursorError";
  }
}

export class AsyncWorkItemNotFoundError extends Error {
  constructor() {
    super("Async-work item was not found.");
    this.name = "AsyncWorkItemNotFoundError";
  }
}

export class AsyncWorkItemNotReplayableError extends Error {
  constructor() {
    super("Async-work item is not in a replayable state.");
    this.name = "AsyncWorkItemNotReplayableError";
  }
}

export class AsyncWorkReplayConflictError extends Error {
  constructor() {
    super("Idempotency key was already used for a different replay request.");
    this.name = "AsyncWorkReplayConflictError";
  }
}

export class WorkerOperationsAccessDeniedError extends Error {
  constructor() {
    super("Current actor cannot manage worker operations.");
    this.name = "WorkerOperationsAccessDeniedError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
