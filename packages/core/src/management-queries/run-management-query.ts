import type { Clock } from "../followup-drafts/create-followup-draft.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type {
  ManagementQueryRepository,
  ManagementQueryResult,
  ManagementQuerySubject,
} from "./management-query-repository.js";

const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1_000;

export interface RunManagementQueryInput {
  actor: ActorScope;
  idempotencyKey: string;
  capability: "sales_weekly_progress";
  subjectUserId: string;
  periodStart: string;
  periodEnd: string;
}

export class RunManagementQuery {
  constructor(
    private readonly dependencies: {
      repository: ManagementQueryRepository;
      clock: Clock;
    },
  ) {}

  async execute(
    input: RunManagementQueryInput,
  ): Promise<ManagementQueryResult> {
    const start = Date.parse(input.periodStart);
    const end = Date.parse(input.periodEnd);
    const duration = end - start;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      duration <= 0 ||
      duration > MAX_PERIOD_MS
    ) {
      throw new InvalidManagementQueryPeriodError();
    }
    const now = this.dependencies.clock.now();
    const nowTimestamp = now.getTime();
    if (!Number.isFinite(nowTimestamp)) {
      throw new InvalidManagementQueryClockError();
    }
    if (nowTimestamp < start) {
      throw new InvalidManagementQueryPeriodError();
    }
    const queryNow = now.toISOString();
    const dataCutoffAt = new Date(Math.min(end, nowTimestamp)).toISOString();
    return this.dependencies.repository.runSalesWeeklyProgress({
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      subjectUserId: input.subjectUserId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      queryNow,
      dataCutoffAt,
    });
  }
}

export class InvalidManagementQueryPeriodError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The management-query period must be positive and no longer than 31 days.",
      options,
    );
    this.name = "InvalidManagementQueryPeriodError";
  }
}

export class InvalidManagementQueryClockError extends Error {
  constructor(options?: ErrorOptions) {
    super("The management-query server clock is invalid.", options);
    this.name = "InvalidManagementQueryClockError";
  }
}

export class ListManagementQuerySubjects {
  constructor(
    private readonly dependencies: {
      repository: ManagementQueryRepository;
    },
  ) {}

  async execute(input: {
    actor: ActorScope;
    cursor?: string;
    limit: number;
  }): Promise<{
    items: ManagementQuerySubject[];
    nextCursor: string | null;
  }> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new InvalidManagementQuerySubjectLimitError();
    }
    return this.dependencies.repository.listSubjects({
      actor: input.actor,
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  }
}

export class InvalidManagementQuerySubjectLimitError extends Error {
  constructor(options?: ErrorOptions) {
    super("The management-query subject limit is invalid.", options);
    this.name = "InvalidManagementQuerySubjectLimitError";
  }
}
