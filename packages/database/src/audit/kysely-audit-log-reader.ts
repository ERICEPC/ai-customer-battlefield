import { randomUUID } from "node:crypto";
import {
  type AuditEntryPage,
  type AuditLogReader,
  type AuditLogReaderInput,
  InvalidAuditLogCursorError,
  InvalidAuditLogListInputError,
} from "@battlefield/core";
import { type Kysely, sql } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

interface AuditRow {
  entry_id: string;
  aggregate_type: string;
  aggregate_id: string;
  action: string;
  actor_user_id: string;
  actor_display_name: string;
  request_id: string | null;
  reason: string | null;
  occurred_at: Date | string;
}

interface AuditCursor {
  occurredAt: string;
  id: string;
}

export interface KyselyAuditLogReaderOptions {
  requestIdFactory?: () => string;
}

export class KyselyAuditLogReader implements AuditLogReader {
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyAuditLogReaderOptions = {},
  ) {
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async list(input: AuditLogReaderInput): Promise<AuditEntryPage> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new InvalidAuditLogListInputError();
    }
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;

    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const actorFilter = input.actorUserId
          ? sql`and audit.actor_user_id = ${input.actorUserId}::uuid`
          : sql``;
        const aggregateTypeFilter = input.aggregateType
          ? sql`and audit.aggregate_type = ${input.aggregateType}`
          : sql``;
        const aggregateIdFilter = input.aggregateId
          ? sql`and audit.aggregate_id = ${input.aggregateId}::uuid`
          : sql``;
        const actionFilter = input.action
          ? sql`and audit.action = ${input.action}`
          : sql``;
        const occurredFromFilter = input.occurredFrom
          ? sql`and audit.occurred_at >= ${input.occurredFrom}::timestamptz`
          : sql``;
        const occurredBeforeFilter = input.occurredBefore
          ? sql`and audit.occurred_at < ${input.occurredBefore}::timestamptz`
          : sql``;
        const cursorFilter = cursor
          ? sql`and (audit.occurred_at, audit.id) < (
              ${cursor.occurredAt}::timestamptz,
              ${cursor.id}::uuid
            )`
          : sql``;
        const result = await sql<AuditRow>`
          select
            audit.id::text as entry_id,
            audit.aggregate_type,
            audit.aggregate_id::text as aggregate_id,
            audit.action,
            audit.actor_user_id::text as actor_user_id,
            audit_actor.display_name as actor_display_name,
            audit.request_id,
            audit.reason,
            audit.occurred_at
          from app.audit_entries as audit
          inner join app.users as audit_actor
            on audit_actor.tenant_id = audit.tenant_id
            and audit_actor.id = audit.actor_user_id
          where audit.tenant_id = ${input.actor.tenantId}::uuid
            and (
              audit.actor_user_id = ${input.actor.userId}::uuid
              or exists (
                select 1
                from app.entity_assignments as observer_assignment
                where observer_assignment.tenant_id = audit.tenant_id
                  and observer_assignment.user_id = ${input.actor.userId}::uuid
                  and observer_assignment.assignment_role = 'management_observer'
                  and observer_assignment.valid_from <= current_timestamp
                  and (
                    observer_assignment.valid_to is null
                    or observer_assignment.valid_to > current_timestamp
                  )
                  and ${auditMatchesEntitySql()}
              )
              or (
                audit.aggregate_type = 'weekly_report'
                and exists (
                  select 1
                  from app.weekly_report_versions as report_version
                  inner join app.weekly_report_audiences as audience
                    on audience.tenant_id = report_version.tenant_id
                    and audience.report_version_id = report_version.id
                  where report_version.tenant_id = audit.tenant_id
                    and report_version.report_id = audit.aggregate_id
                    and audience.user_id = ${input.actor.userId}::uuid
                )
              )
            )
          ${actorFilter}
          ${aggregateTypeFilter}
          ${aggregateIdFilter}
          ${actionFilter}
          ${occurredFromFilter}
          ${occurredBeforeFilter}
          ${cursorFilter}
          order by audit.occurred_at desc, audit.id desc
          limit ${input.limit + 1}
        `.execute(transaction);
        const hasNextPage = result.rows.length > input.limit;
        const rows = result.rows.slice(0, input.limit);
        const last = rows.at(-1);
        return {
          items: rows.map((row) => ({
            entryId: row.entry_id,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            action: row.action,
            actor: {
              userId: row.actor_user_id,
              displayName: row.actor_display_name,
            },
            requestId: row.request_id,
            reason: row.reason,
            occurredAt: toIsoString(row.occurred_at),
          })),
          nextCursor:
            hasNextPage && last
              ? encodeCursor({
                  occurredAt: toIsoString(last.occurred_at),
                  id: last.entry_id,
                })
              : null,
        };
      },
    );
  }
}

function auditMatchesEntitySql() {
  return sql`
    (
      (
        audit.aggregate_type = 'business_entity'
        and observer_assignment.entity_id = audit.aggregate_id
      )
      or (
        audit.aggregate_type = 'opportunity'
        and exists (
          select 1
          from app.opportunities as opportunity
          where opportunity.tenant_id = audit.tenant_id
            and opportunity.id = audit.aggregate_id
            and opportunity.entity_id = observer_assignment.entity_id
        )
      )
      or (
        audit.aggregate_type = 'followup'
        and exists (
          select 1
          from app.followups as followup
          where followup.tenant_id = audit.tenant_id
            and followup.id = audit.aggregate_id
            and followup.entity_id = observer_assignment.entity_id
        )
      )
      or (
        audit.aggregate_type = 'followup_draft'
        and exists (
          select 1
          from app.followup_drafts as draft
          where draft.tenant_id = audit.tenant_id
            and draft.id = audit.aggregate_id
            and draft.entity_id = observer_assignment.entity_id
        )
      )
      or (
        audit.aggregate_type = 'action_proposal'
        and exists (
          select 1
          from app.action_proposals as proposal
          where proposal.tenant_id = audit.tenant_id
            and proposal.id = audit.aggregate_id
            and proposal.entity_id = observer_assignment.entity_id
        )
      )
      or (
        audit.aggregate_type = 'business_action'
        and exists (
          select 1
          from app.business_actions as business_action
          where business_action.tenant_id = audit.tenant_id
            and business_action.id = audit.aggregate_id
            and business_action.entity_id = observer_assignment.entity_id
        )
      )
      or (
        audit.aggregate_type in ('battle_state', 'battle_state_version')
        and exists (
          select 1
          from app.battle_state_versions as battle_state
          where battle_state.tenant_id = audit.tenant_id
            and battle_state.id = audit.aggregate_id
            and battle_state.entity_id = observer_assignment.entity_id
        )
      )
    )
  `;
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): AuditCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Cursor encoding is invalid.");
    }
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("Cursor encoding is not canonical.");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "id,occurredAt"
    ) {
      throw new Error("Cursor payload is invalid.");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.occurredAt !== "string" ||
      toIsoString(candidate.occurredAt) !== candidate.occurredAt ||
      typeof candidate.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.id,
      )
    ) {
      throw new Error("Cursor values are invalid.");
    }
    return { occurredAt: candidate.occurredAt, id: candidate.id };
  } catch (error) {
    throw new InvalidAuditLogCursorError({ cause: error });
  }
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Database timestamp is invalid.");
  }
  return date.toISOString();
}
