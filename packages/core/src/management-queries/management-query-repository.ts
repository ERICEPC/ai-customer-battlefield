import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export type ManagementQueryScopeKind = "self" | "observed_portfolio";
export type ManagementQueryEvidenceKind =
  | "followup"
  | "fact"
  | "stage_change"
  | "action"
  | "battle_state";

export interface ManagementQuerySubject {
  userId: string;
  displayName: string;
  scopeKind: ManagementQueryScopeKind;
}

export interface ManagementQueryEvidence {
  kind: ManagementQueryEvidenceKind;
  evidenceId: string;
  occurredAt: string;
  label: string;
  deepLink: string;
}

export interface ManagementQueryMetrics {
  confirmedFollowupCount: number;
  validFactCount: number;
  stageChangeCount: number;
  completedActionCount: number;
  openActionCount: number;
  overdueActionCount: number;
}

export interface ManagementQueryHighlight extends ManagementQueryMetrics {
  entityId: string;
  entityName: string;
  latestActivityAt: string | null;
  evidence: ManagementQueryEvidence[];
}

export interface ManagementQueryDataGap {
  entityId: string;
  entityName: string;
  code: "missing_battle_state";
  message: string;
}

export interface ManagementQueryResult {
  queryId: string;
  capability: "sales_weekly_progress";
  subject: { userId: string; displayName: string };
  period: { start: string; end: string };
  dataCutoffAt: string;
  scope: { kind: ManagementQueryScopeKind; entityCount: number };
  metrics: ManagementQueryMetrics;
  highlights: ManagementQueryHighlight[];
  dataGaps: ManagementQueryDataGap[];
}

export interface ManagementQueryRepository {
  listSubjects(input: {
    actor: ActorScope;
    cursor?: string;
    limit: number;
  }): Promise<{ items: ManagementQuerySubject[]; nextCursor: string | null }>;
  runSalesWeeklyProgress(input: {
    actor: ActorScope;
    idempotencyKey: string;
    subjectUserId: string;
    periodStart: string;
    periodEnd: string;
    queryNow: string;
    dataCutoffAt: string;
  }): Promise<ManagementQueryResult>;
}

export class ManagementQuerySubjectNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super("The management-query subject was not found.", options);
    this.name = "ManagementQuerySubjectNotFoundError";
  }
}

export class ManagementQueryResultLimitExceededError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The management-query result exceeds the configured processing limit.",
      options,
    );
    this.name = "ManagementQueryResultLimitExceededError";
  }
}

export class ManagementQueryIdempotencyConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super("The management-query idempotency key cannot be reused.", options);
    this.name = "ManagementQueryIdempotencyConflictError";
  }
}

export class InvalidManagementQueryCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super("The management-query subject cursor is invalid.", options);
    this.name = "InvalidManagementQueryCursorError";
  }
}
