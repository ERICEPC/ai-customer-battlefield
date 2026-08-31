import { randomUUID } from "node:crypto";
import {
  type BusinessEntityListItem,
  type BusinessEntityPage,
  type BusinessEntityReader,
  type BusinessEntityReaderInput,
  type BusinessEntityStatus,
  InvalidBusinessEntityListInputError,
} from "@battlefield/core";
import { type Kysely, sql } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

interface DirectoryRow {
  id: string;
  type_code: string;
  name: string;
  short_name: string | null;
  status: BusinessEntityStatus;
  is_t0: boolean;
  primary_owner_name: string | null;
  opportunity_id: string | null;
  opportunity_name: string | null;
  stage_code: string | null;
  stage_progress: number | string | null;
  latest_followup_id: string | null;
  latest_followup_summary: string | null;
  latest_followup_confirmed_at: Date | string | null;
  updated_at: Date | string;
  version_no: bigint | number | string;
}

interface DirectoryCursor {
  updatedAt: string;
  id: string;
}

export interface KyselyBusinessEntityReaderOptions {
  requestIdFactory?: () => string;
}

export class KyselyBusinessEntityReader implements BusinessEntityReader {
  readonly #requestIdFactory: () => string;

  constructor(
    private readonly db: Kysely<BattlefieldDatabase>,
    options: KyselyBusinessEntityReaderOptions = {},
  ) {
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async list(input: BusinessEntityReaderInput): Promise<BusinessEntityPage> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new InvalidBusinessEntityListInputError();
    }
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;

    return withTenantTransaction(
      this.db,
      {
        tenantId: input.actor.tenantId,
        userId: input.actor.userId,
        requestId: this.#requestIdFactory(),
      },
      async (transaction) => {
        const statusFilter = input.status
          ? sql`and entity.status = ${input.status}`
          : sql``;
        const searchFilter = input.search
          ? sql`and (
              entity.name ilike ${`%${input.search}%`}
              or coalesce(entity.short_name, '') ilike ${`%${input.search}%`}
            )`
          : sql``;
        const cursorFilter = cursor
          ? sql`where (directory.updated_at, directory.id::uuid) < (
              ${cursor.updatedAt}::timestamptz,
              ${cursor.id}::uuid
            )`
          : sql``;

        const result = await sql<DirectoryRow>`
          with directory as (
            select
              entity.id::text as id,
              entity_type.code as type_code,
              entity.name,
              entity.short_name,
              entity.status,
              entity.is_t0,
              primary_owner.display_name as primary_owner_name,
              primary_opportunity.id::text as opportunity_id,
              primary_opportunity.name as opportunity_name,
              primary_opportunity.stage_code,
              primary_opportunity.stage_progress,
              latest_followup.id::text as latest_followup_id,
              latest_followup.summary as latest_followup_summary,
              latest_followup.confirmed_at as latest_followup_confirmed_at,
              greatest(
                entity.updated_at,
                coalesce(latest_followup.confirmed_at, '-infinity'::timestamptz),
                coalesce(current_state.updated_at, '-infinity'::timestamptz)
              ) as updated_at,
              entity.version_no
            from app.business_entities as entity
            inner join app.business_entity_types as entity_type
              on entity_type.tenant_id = entity.tenant_id
              and entity_type.id = entity.type_id
            left join lateral (
              select app_user.display_name
              from app.entity_assignments as assignment
              inner join app.users as app_user
                on app_user.tenant_id = assignment.tenant_id
                and app_user.id = assignment.user_id
              where assignment.tenant_id = entity.tenant_id
                and assignment.entity_id = entity.id
                and assignment.assignment_role = 'owner'
                and assignment.is_primary
                and assignment.valid_to is null
              order by assignment.valid_from desc, assignment.id desc
              limit 1
            ) as primary_owner on true
            left join lateral (
              select
                opportunity.id,
                opportunity.name,
                opportunity.stage_code,
                opportunity.stage_progress
              from app.opportunities as opportunity
              where opportunity.tenant_id = entity.tenant_id
                and opportunity.entity_id = entity.id
                and opportunity.status = 'open'
                and opportunity.is_primary
              order by opportunity.updated_at desc, opportunity.id desc
              limit 1
            ) as primary_opportunity on true
            left join lateral (
              select followup.id, followup.summary, followup.confirmed_at
              from app.followups as followup
              where followup.tenant_id = entity.tenant_id
                and followup.entity_id = entity.id
              order by followup.confirmed_at desc, followup.id desc
              limit 1
            ) as latest_followup on true
            left join app.battle_state_current as current_state
              on current_state.tenant_id = entity.tenant_id
              and current_state.entity_id = entity.id
            where entity.tenant_id = ${input.actor.tenantId}::uuid
            ${statusFilter}
            ${searchFilter}
          )
          select * from directory
          ${cursorFilter}
          order by directory.updated_at desc, directory.id desc
          limit ${input.limit + 1}
        `.execute(transaction);

        const hasNextPage = result.rows.length > input.limit;
        const pageRows = result.rows.slice(0, input.limit);
        const items = pageRows.map(mapDirectoryRow);
        const lastRow = pageRows.at(-1);

        return {
          items,
          nextCursor:
            hasNextPage && lastRow
              ? encodeCursor({
                  updatedAt: toIsoString(lastRow.updated_at),
                  id: lastRow.id,
                })
              : null,
        };
      },
    );
  }
}

function mapDirectoryRow(row: DirectoryRow): BusinessEntityListItem {
  const primaryOpportunity =
    row.opportunity_id &&
    row.opportunity_name &&
    row.stage_code &&
    row.stage_progress !== null
      ? {
          id: row.opportunity_id,
          name: row.opportunity_name,
          stageCode: row.stage_code,
          stageProgress: String(row.stage_progress),
        }
      : null;

  return {
    id: row.id,
    typeCode: row.type_code,
    name: row.name,
    shortName: row.short_name,
    status: row.status,
    isT0: row.is_t0,
    primaryOwnerName: row.primary_owner_name,
    primaryOpportunity,
    latestFollowup:
      row.latest_followup_id &&
      row.latest_followup_summary &&
      row.latest_followup_confirmed_at
        ? {
            followupId: row.latest_followup_id,
            summary: row.latest_followup_summary.trim().slice(0, 500),
            confirmedAt: toIsoString(row.latest_followup_confirmed_at),
          }
        : null,
    updatedAt: toIsoString(row.updated_at),
    versionNo: String(row.version_no),
  };
}

function encodeCursor(cursor: DirectoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): DirectoryCursor {
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
      Object.keys(parsed).sort().join(",") !== "id,updatedAt"
    ) {
      throw new Error("Cursor payload is invalid.");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.updatedAt !== "string" ||
      toIsoString(candidate.updatedAt) !== candidate.updatedAt ||
      typeof candidate.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.id,
      )
    ) {
      throw new Error("Cursor values are invalid.");
    }

    return { updatedAt: candidate.updatedAt, id: candidate.id };
  } catch (error) {
    throw new InvalidBusinessEntityListInputError({ cause: error });
  }
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Database timestamp is invalid.");
  }
  return date.toISOString();
}
