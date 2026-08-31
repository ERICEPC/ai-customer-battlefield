import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export type WeeklyReportType = "personal" | "managed_portfolio";
export type WeeklyReportStatus =
  | "draft"
  | "in_review"
  | "published"
  | "cancelled";
export type WeeklyReportSectionKind =
  | "progress"
  | "risk"
  | "next_action"
  | "data_gap";

export interface WeeklyReportMetrics {
  confirmedFollowupCount: number;
  validFactCount: number;
  stageChangeCount: number;
  completedActionCount: number;
  openActionCount: number;
  overdueActionCount: number;
}

export interface WeeklyReportEvidence {
  kind: "followup" | "fact" | "stage_change" | "action" | "battle_state";
  evidenceId: string;
  occurredAt: string;
  label: string;
  deepLink: string;
}

export interface WeeklyReportItem {
  itemId: string;
  sectionKind: WeeklyReportSectionKind;
  entityId: string;
  entityName: string;
  title: string;
  summary: string;
  severity: "positive" | "info" | "warning" | "critical";
  occurredAt: string | null;
  included: boolean;
  sortOrder: number;
  contributors: Array<{ userId: string; displayName: string }>;
  evidence: WeeklyReportEvidence[];
}

export interface WeeklyReportDetail {
  reportId: string;
  versionId: string;
  reportType: WeeklyReportType;
  revisionNo: number;
  lockVersion: number;
  status: WeeklyReportStatus;
  title: string;
  note: string;
  period: { start: string; end: string };
  dataCutoffAt: string;
  scope: { label: string; entityCount: number; contributorCount: number };
  metrics: WeeklyReportMetrics;
  generator: { kind: "deterministic" | "agent"; version: string };
  sections: Array<{ kind: WeeklyReportSectionKind; items: WeeklyReportItem[] }>;
  previousVersionId: string | null;
  createdAt: string;
  publishedAt: string | null;
  capabilities: {
    canReview: boolean;
    canPublish: boolean;
    canRevise: boolean;
  };
}

export interface WeeklyReportListItem {
  reportId: string;
  versionId: string;
  reportType: WeeklyReportType;
  revisionNo: number;
  status: WeeklyReportStatus;
  title: string;
  period: { start: string; end: string };
  dataCutoffAt: string;
  entityCount: number;
  createdAt: string;
  publishedAt: string | null;
}

export interface WeeklyReportRepository {
  generate(input: {
    actor: ActorScope;
    idempotencyKey: string;
    reportType: WeeklyReportType;
    periodStart: string;
    periodEnd: string;
    generatedAt: string;
    dataCutoffAt: string;
  }): Promise<WeeklyReportDetail>;
  list(input: {
    actor: ActorScope;
    reportType?: WeeklyReportType;
    status?: WeeklyReportStatus;
    cursor?: string;
    limit: number;
  }): Promise<{ items: WeeklyReportListItem[]; nextCursor: string | null }>;
  get(input: {
    actor: ActorScope;
    versionId: string;
  }): Promise<WeeklyReportDetail>;
  review(input: {
    actor: ActorScope;
    versionId: string;
    lockVersion: number;
    note: string;
    items: Array<{ itemId: string; included: boolean }>;
  }): Promise<WeeklyReportDetail>;
  publish(input: {
    actor: ActorScope;
    versionId: string;
    lockVersion: number;
    idempotencyKey: string;
  }): Promise<WeeklyReportDetail>;
  revise(input: {
    actor: ActorScope;
    versionId: string;
    lockVersion: number;
    idempotencyKey: string;
  }): Promise<WeeklyReportDetail>;
}

export class WeeklyReportNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report was not found.", options);
    this.name = "WeeklyReportNotFoundError";
  }
}

export class WeeklyReportVersionConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report version changed.", options);
    this.name = "WeeklyReportVersionConflictError";
  }
}

export class WeeklyReportScopeConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report scope changed.", options);
    this.name = "WeeklyReportScopeConflictError";
  }
}

export class WeeklyReportIdempotencyConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report idempotency key cannot be reused.", options);
    this.name = "WeeklyReportIdempotencyConflictError";
  }
}

export class WeeklyReportResultLimitExceededError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The weekly report exceeds the configured processing limit.",
      options,
    );
    this.name = "WeeklyReportResultLimitExceededError";
  }
}

export class InvalidWeeklyReportCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super("The weekly report cursor is invalid.", options);
    this.name = "InvalidWeeklyReportCursorError";
  }
}
