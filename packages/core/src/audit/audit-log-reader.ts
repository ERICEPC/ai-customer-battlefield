import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export interface AuditEntryRecord {
  entryId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  actor: {
    userId: string;
    displayName: string;
  };
  requestId: string | null;
  reason: string | null;
  occurredAt: string;
}

export interface AuditEntryPage {
  items: AuditEntryRecord[];
  nextCursor: string | null;
}

export interface AuditLogReaderInput {
  actor: ActorScope;
  limit: number;
  cursor?: string;
  actorUserId?: string;
  aggregateType?: string;
  aggregateId?: string;
  action?: string;
  occurredFrom?: string;
  occurredBefore?: string;
}

export interface AuditLogReader {
  list(input: AuditLogReaderInput): Promise<AuditEntryPage>;
}

export class InvalidAuditLogListInputError extends Error {
  constructor() {
    super("Audit-log list input is invalid.");
    this.name = "InvalidAuditLogListInputError";
  }
}

export class InvalidAuditLogCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super("Audit-log cursor is invalid.", options);
    this.name = "InvalidAuditLogCursorError";
  }
}
