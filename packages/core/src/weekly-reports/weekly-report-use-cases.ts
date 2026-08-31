import type { Clock } from "../followup-drafts/create-followup-draft.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type {
  WeeklyReportDetail,
  WeeklyReportRepository,
  WeeklyReportStatus,
  WeeklyReportType,
} from "./weekly-report-repository.js";

const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1_000;

export class GenerateWeeklyReport {
  constructor(
    private readonly dependencies: {
      repository: WeeklyReportRepository;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    actor: ActorScope;
    idempotencyKey: string;
    reportType: WeeklyReportType;
    periodStart: string;
    periodEnd: string;
  }): Promise<WeeklyReportDetail> {
    const start = Date.parse(input.periodStart);
    const end = Date.parse(input.periodEnd);
    const duration = end - start;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      duration <= 0 ||
      duration > MAX_PERIOD_MS
    ) {
      throw new InvalidWeeklyReportPeriodError();
    }
    const now = this.dependencies.clock.now();
    const nowTimestamp = now.getTime();
    if (!Number.isFinite(nowTimestamp)) {
      throw new InvalidWeeklyReportClockError();
    }
    if (nowTimestamp < start) {
      throw new InvalidWeeklyReportPeriodError();
    }
    return this.dependencies.repository.generate({
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      reportType: input.reportType,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      generatedAt: now.toISOString(),
      dataCutoffAt: new Date(Math.min(end, nowTimestamp)).toISOString(),
    });
  }
}

export class ListWeeklyReports {
  constructor(
    private readonly dependencies: { repository: WeeklyReportRepository },
  ) {}

  async execute(input: {
    actor: ActorScope;
    reportType?: WeeklyReportType;
    status?: WeeklyReportStatus;
    cursor?: string;
    limit: number;
  }) {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new InvalidWeeklyReportListLimitError();
    }
    return this.dependencies.repository.list(input);
  }
}

export class GetWeeklyReport {
  constructor(
    private readonly dependencies: { repository: WeeklyReportRepository },
  ) {}

  async execute(input: { actor: ActorScope; versionId: string }) {
    return this.dependencies.repository.get(input);
  }
}

export class ReviewWeeklyReport {
  constructor(
    private readonly dependencies: { repository: WeeklyReportRepository },
  ) {}

  async execute(input: {
    actor: ActorScope;
    versionId: string;
    versionNo: number;
    note: string;
    items: Array<{ itemId: string; included: boolean }>;
  }) {
    validatePositiveVersion(input.versionNo);
    if (input.note.length > 2_000 || input.items.length > 400) {
      throw new InvalidWeeklyReportReviewError();
    }
    if (
      new Set(input.items.map((item) => item.itemId)).size !==
      input.items.length
    ) {
      throw new InvalidWeeklyReportReviewError();
    }
    return this.dependencies.repository.review(input);
  }
}

export class PublishWeeklyReport {
  constructor(
    private readonly dependencies: { repository: WeeklyReportRepository },
  ) {}

  async execute(input: {
    actor: ActorScope;
    versionId: string;
    versionNo: number;
    idempotencyKey: string;
  }) {
    validatePositiveVersion(input.versionNo);
    return this.dependencies.repository.publish(input);
  }
}

export class ReviseWeeklyReport {
  constructor(
    private readonly dependencies: { repository: WeeklyReportRepository },
  ) {}

  async execute(input: {
    actor: ActorScope;
    versionId: string;
    versionNo: number;
    idempotencyKey: string;
  }) {
    validatePositiveVersion(input.versionNo);
    return this.dependencies.repository.revise(input);
  }
}

export class InvalidWeeklyReportPeriodError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The report period must be positive and no longer than 31 days.",
      options,
    );
    this.name = "InvalidWeeklyReportPeriodError";
  }
}

export class InvalidWeeklyReportClockError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report server clock is invalid.", options);
    this.name = "InvalidWeeklyReportClockError";
  }
}

export class InvalidWeeklyReportListLimitError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report list limit is invalid.", options);
    this.name = "InvalidWeeklyReportListLimitError";
  }
}

export class InvalidWeeklyReportReviewError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report review request is invalid.", options);
    this.name = "InvalidWeeklyReportReviewError";
  }
}

export class InvalidWeeklyReportVersionError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report version is invalid.", options);
    this.name = "InvalidWeeklyReportVersionError";
  }
}

function validatePositiveVersion(versionNo: number): void {
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw new InvalidWeeklyReportVersionError();
  }
}
