import { randomUUID } from "node:crypto";
import {
  type ActionPriority,
  ActionProposalNotFoundError,
  type ActionProposalRecord,
  type ActionProposalStatus,
  type ActionQueryReader,
  BusinessActionNotFoundError,
  type BusinessActionRecord,
  InvalidActionQueryCursorError,
} from "@battlefield/core";
import { type Kysely, sql } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

interface ProposalRow {
  proposal_id: string;
  entity_id: string;
  entity_name: string;
  opportunity_id: string | null;
  title: string;
  description: string;
  suggested_owner_id: string | null;
  suggested_owner_name: string | null;
  suggested_priority: ActionPriority;
  suggested_planned_at: Date | string | null;
  source_state_id: string;
  status: ActionProposalStatus;
  version_no: bigint | number | string;
  proposed_at: Date | string;
  expires_at: Date | string;
  decided_at: Date | string | null;
  decided_by: string | null;
  decision_reason: string | null;
  action_id: string | null;
}

interface ActionRow {
  action_id: string;
  entity_id: string;
  entity_name: string;
  opportunity_id: string | null;
  title: string;
  description: string;
  owner_user_id: string;
  owner_name: string;
  priority: ActionPriority;
  status: "planned" | "in_progress" | "completed" | "cancelled";
  planned_at: Date | string;
  completed_at: Date | string | null;
  source_proposal_id: string;
  confirmed_by: string;
  confirmed_at: Date | string;
  version_no: bigint | number | string;
}

interface ProposalCursor {
  proposedAt: string;
  id: string;
}

interface ActionCursor {
  plannedAt: string;
  id: string;
}

interface OwnerCursor {
  rank: number;
  displayName: string;
  id: string;
}

export interface KyselyActionQueryReaderOptions {
  requestIdFactory?: () => string;
}

export class KyselyActionQueryReader implements ActionQueryReader {
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyActionQueryReaderOptions = {},
  ) {
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async listOwners(input: Parameters<ActionQueryReader["listOwners"]>[0]) {
    assertLimit(input.limit);
    const cursor = input.cursor ? decodeOwnerCursor(input.cursor) : undefined;
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const cursorFilter = cursor
          ? sql`and (
              case when app_user.id = ${input.actor.userId}::uuid then 0 else 1 end,
              lower(app_user.display_name),
              app_user.id
            ) > (
              ${cursor.rank},
              ${cursor.displayName},
              ${cursor.id}::uuid
            )`
          : sql``;
        const result = await sql<{
          user_id: string;
          display_name: string;
          sort_name: string;
          sort_rank: number;
        }>`
          select
            app_user.id::text as user_id,
            app_user.display_name,
            lower(app_user.display_name) as sort_name,
            case when app_user.id = ${input.actor.userId}::uuid then 0 else 1 end as sort_rank
          from app.users as app_user
          where app_user.tenant_id = ${input.actor.tenantId}::uuid
            and app_user.status = 'active'
          ${cursorFilter}
          order by
            sort_rank,
            lower(app_user.display_name),
            app_user.id
          limit ${input.limit + 1}
        `.execute(transaction);
        const hasNext = result.rows.length > input.limit;
        const rows = result.rows.slice(0, input.limit);
        const last = rows.at(-1);
        return {
          items: rows.map((row) => ({
            userId: row.user_id,
            displayName: row.display_name,
          })),
          nextCursor:
            hasNext && last
              ? encodeOwnerCursor({
                  rank: Number(last.sort_rank),
                  displayName: last.sort_name,
                  id: last.user_id,
                })
              : null,
        };
      },
    );
  }

  async getProposal(
    input: Parameters<ActionQueryReader["getProposal"]>[0],
  ): Promise<ActionProposalRecord> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.proposalId },
      async (transaction) => {
        const result = await sql<ProposalRow>`
          ${proposalSelect()}
          where proposal.tenant_id = ${input.actor.tenantId}::uuid
            and proposal.id = ${input.proposalId}::uuid
        `.execute(transaction);
        const row = result.rows[0];
        if (!row) throw new ActionProposalNotFoundError();
        return mapProposal(row);
      },
    );
  }

  async listProposals(
    input: Parameters<ActionQueryReader["listProposals"]>[0],
  ) {
    assertLimit(input.limit);
    const cursor = input.cursor
      ? decodeCursor<ProposalCursor>(input.cursor, "proposedAt")
      : undefined;
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const statusFilter = proposalStatusFilter(input.status);
        const priorityFilter = input.priority
          ? sql`and proposal.suggested_priority = ${input.priority}`
          : sql``;
        const entityFilter = input.entityId
          ? sql`and proposal.entity_id = ${input.entityId}::uuid`
          : sql``;
        const cursorFilter = cursor
          ? sql`and (proposal.proposed_at, proposal.id) < (
              ${cursor.proposedAt}::timestamptz,
              ${cursor.id}::uuid
            )`
          : sql``;
        const result = await sql<ProposalRow>`
          ${proposalSelect()}
          where proposal.tenant_id = ${input.actor.tenantId}::uuid
          ${statusFilter}
          ${priorityFilter}
          ${entityFilter}
          ${cursorFilter}
          order by proposal.proposed_at desc, proposal.id desc
          limit ${input.limit + 1}
        `.execute(transaction);
        const hasNext = result.rows.length > input.limit;
        const rows = result.rows.slice(0, input.limit);
        const last = rows.at(-1);
        return {
          items: rows.map(mapProposal),
          nextCursor:
            hasNext && last
              ? encodeCursor({
                  proposedAt: toIsoString(last.proposed_at),
                  id: last.proposal_id,
                })
              : null,
        };
      },
    );
  }

  async getAction(
    input: Parameters<ActionQueryReader["getAction"]>[0],
  ): Promise<BusinessActionRecord> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.actionId },
      async (transaction) => {
        const result = await sql<ActionRow>`
          ${actionSelect()}
          where action.tenant_id = ${input.actor.tenantId}::uuid
            and action.id = ${input.actionId}::uuid
        `.execute(transaction);
        const row = result.rows[0];
        if (!row) throw new BusinessActionNotFoundError();
        return mapAction(row);
      },
    );
  }

  async listActions(input: Parameters<ActionQueryReader["listActions"]>[0]) {
    assertLimit(input.limit);
    const cursor = input.cursor
      ? decodeCursor<ActionCursor>(input.cursor, "plannedAt")
      : undefined;
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const statusFilter = input.status
          ? sql`and action.status = ${input.status}`
          : sql``;
        const priorityFilter = input.priority
          ? sql`and action.priority = ${input.priority}`
          : sql``;
        const entityFilter = input.entityId
          ? sql`and action.entity_id = ${input.entityId}::uuid`
          : sql``;
        const ownerFilter = input.ownerUserId
          ? sql`and action.owner_user_id = ${input.ownerUserId}::uuid`
          : sql``;
        const cursorFilter = cursor
          ? sql`and (action.planned_at, action.id) > (
              ${cursor.plannedAt}::timestamptz,
              ${cursor.id}::uuid
            )`
          : sql``;
        const result = await sql<ActionRow>`
          ${actionSelect()}
          where action.tenant_id = ${input.actor.tenantId}::uuid
          ${statusFilter}
          ${priorityFilter}
          ${entityFilter}
          ${ownerFilter}
          ${cursorFilter}
          order by action.planned_at, action.id
          limit ${input.limit + 1}
        `.execute(transaction);
        const hasNext = result.rows.length > input.limit;
        const rows = result.rows.slice(0, input.limit);
        const last = rows.at(-1);
        return {
          items: rows.map(mapAction),
          nextCursor:
            hasNext && last
              ? encodeCursor({
                  plannedAt: toIsoString(last.planned_at),
                  id: last.action_id,
                })
              : null,
        };
      },
    );
  }
}

function proposalSelect() {
  return sql`
    select
      proposal.id::text as proposal_id,
      proposal.entity_id::text as entity_id,
      entity.name as entity_name,
      proposal.opportunity_id::text as opportunity_id,
      proposal.title,
      proposal.description,
      proposal.suggested_owner_id::text as suggested_owner_id,
      suggested_owner.display_name as suggested_owner_name,
      proposal.suggested_priority,
      proposal.suggested_planned_at,
      proposal.source_battle_state_version_id::text as source_state_id,
      case
        when proposal.status = 'pending_confirmation'
          and proposal.expires_at <= current_timestamp
        then 'expired'
        else proposal.status
      end as status,
      proposal.version_no,
      proposal.proposed_at,
      proposal.expires_at,
      proposal.decided_at,
      proposal.decided_by::text as decided_by,
      proposal.decision_reason,
      action.id::text as action_id
    from app.action_proposals as proposal
    join app.business_entities as entity
      on entity.tenant_id = proposal.tenant_id
      and entity.id = proposal.entity_id
    left join app.users as suggested_owner
      on suggested_owner.tenant_id = proposal.tenant_id
      and suggested_owner.id = proposal.suggested_owner_id
    left join app.business_actions as action
      on action.tenant_id = proposal.tenant_id
      and action.source_proposal_id = proposal.id
  `;
}

function actionSelect() {
  return sql`
    select
      action.id::text as action_id,
      action.entity_id::text as entity_id,
      entity.name as entity_name,
      action.opportunity_id::text as opportunity_id,
      action.title,
      action.description,
      action.owner_user_id::text as owner_user_id,
      action_owner.display_name as owner_name,
      action.priority,
      action.status,
      action.planned_at,
      action.completed_at,
      action.source_proposal_id::text as source_proposal_id,
      action.confirmed_by::text as confirmed_by,
      action.confirmed_at,
      action.version_no
    from app.business_actions as action
    join app.business_entities as entity
      on entity.tenant_id = action.tenant_id
      and entity.id = action.entity_id
    join app.users as action_owner
      on action_owner.tenant_id = action.tenant_id
      and action_owner.id = action.owner_user_id
  `;
}

function mapProposal(row: ProposalRow): ActionProposalRecord {
  return {
    proposalId: row.proposal_id,
    entityId: row.entity_id,
    entityName: row.entity_name,
    opportunityId: row.opportunity_id,
    title: row.title,
    description: row.description,
    suggestedOwnerId: row.suggested_owner_id,
    suggestedOwnerName: row.suggested_owner_name,
    suggestedPriority: row.suggested_priority,
    suggestedPlannedAt: toNullableIsoString(row.suggested_planned_at),
    sourceBattleStateVersionId: row.source_state_id,
    status: row.status,
    versionNo: String(row.version_no),
    proposedAt: toIsoString(row.proposed_at),
    expiresAt: toIsoString(row.expires_at),
    decidedAt: toNullableIsoString(row.decided_at),
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    actionId: row.action_id,
  };
}

function mapAction(row: ActionRow): BusinessActionRecord {
  return {
    actionId: row.action_id,
    entityId: row.entity_id,
    entityName: row.entity_name,
    opportunityId: row.opportunity_id,
    title: row.title,
    description: row.description,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    priority: row.priority,
    status: row.status,
    plannedAt: toIsoString(row.planned_at),
    completedAt: toNullableIsoString(row.completed_at),
    sourceProposalId: row.source_proposal_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: toIsoString(row.confirmed_at),
    versionNo: String(row.version_no),
  };
}

function proposalStatusFilter(status: ActionProposalStatus | undefined) {
  if (status === "pending_confirmation") {
    return sql`and proposal.status = 'pending_confirmation'
      and proposal.expires_at > current_timestamp`;
  }
  if (status === "expired") {
    return sql`and (
      proposal.status = 'expired'
      or (
        proposal.status = 'pending_confirmation'
        and proposal.expires_at <= current_timestamp
      )
    )`;
  }
  return status ? sql`and proposal.status = ${status}` : sql``;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidActionQueryCursorError();
  }
}

function encodeCursor(value: ProposalCursor | ActionCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function encodeOwnerCursor(value: OwnerCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeOwnerCursor(value: string): OwnerCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Cursor encoding is invalid.");
    }
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("Cursor encoding is not canonical.");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Cursor payload is invalid.");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(",") !== "displayName,id,rank" ||
      (candidate.rank !== 0 && candidate.rank !== 1) ||
      typeof candidate.displayName !== "string" ||
      candidate.displayName.length === 0 ||
      typeof candidate.id !== "string" ||
      !isUuid(candidate.id)
    ) {
      throw new Error("Cursor values are invalid.");
    }
    return candidate as unknown as OwnerCursor;
  } catch (error) {
    throw new InvalidActionQueryCursorError({ cause: error });
  }
}

function decodeCursor<Cursor extends ProposalCursor | ActionCursor>(
  value: string,
  timestampKey: "proposedAt" | "plannedAt",
): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Cursor encoding is invalid.");
    }
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("Cursor encoding is not canonical.");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Cursor payload is invalid.");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(",") !== `id,${timestampKey}` ||
      typeof candidate.id !== "string" ||
      !isUuid(candidate.id) ||
      typeof candidate[timestampKey] !== "string" ||
      toIsoString(candidate[timestampKey]) !== candidate[timestampKey]
    ) {
      throw new Error("Cursor values are invalid.");
    }
    return candidate as Cursor;
  } catch (error) {
    throw new InvalidActionQueryCursorError({ cause: error });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Database timestamp is invalid.");
  }
  return date.toISOString();
}

function toNullableIsoString(value: Date | string | null): string | null {
  return value === null ? null : toIsoString(value);
}
