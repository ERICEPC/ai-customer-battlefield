import { randomUUID } from "node:crypto";
import {
  type ActorScope,
  type BattleDataSufficiency,
  type BattleMapPage,
  type BattleQueryReader,
  type BattleStateDetail,
  BattleStateNotFoundError,
  type BattleStateRecord,
  InvalidBattleMapCursorError,
} from "@battlefield/core";
import { type Kysely, sql } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

interface StateRow {
  state_id: string;
  entity_id: string;
  version_no: bigint | number | string;
  input_version: string;
  relationship_score: number | string | null;
  potential_score: number | string | null;
  quadrant_code: string | null;
  primary_opportunity_id: string | null;
  risk_level: "low" | "medium" | "high" | "critical";
  data_sufficiency: BattleDataSufficiency;
  data_gaps: unknown;
  summary: string;
  analysis_run_id: string;
  effective_at: Date | string;
}

interface MapRow extends Omit<StateRow, "state_id"> {
  state_id: string | null;
  entity_id: string;
  entity_name: string;
  entity_type_code: string;
  is_t0: boolean;
  primary_owner_name: string | null;
  entity_updated_at: Date | string;
  evidence_fact_ids: unknown;
}

interface MapCursor {
  updatedAt: string;
  id: string;
}

export interface KyselyBattleQueryReaderOptions {
  requestIdFactory?: () => string;
}

export class KyselyBattleQueryReader implements BattleQueryReader {
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyBattleQueryReaderOptions = {},
  ) {
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async getCurrent(
    input: Parameters<BattleQueryReader["getCurrent"]>[0],
  ): Promise<BattleStateDetail> {
    return this.getDetail(input);
  }

  async getVersion(
    input: Parameters<BattleQueryReader["getVersion"]>[0],
  ): Promise<BattleStateDetail> {
    return this.getDetail(input);
  }

  private async getDetail(input: {
    actor: ActorScope;
    entityId: string;
    battleStateVersionId?: string;
  }): Promise<BattleStateDetail> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.entityId },
      async (transaction) => {
        const versionFilter = input.battleStateVersionId
          ? sql`and state.id = ${input.battleStateVersionId}::uuid`
          : sql`and state.id = (
              select current.battle_state_version_id
              from app.battle_state_current as current
              where current.tenant_id = ${input.actor.tenantId}::uuid
                and current.entity_id = ${input.entityId}::uuid
            )`;
        const stateResult = await sql<StateRow>`
          select
            state.id::text as state_id,
            state.entity_id::text as entity_id,
            state.version_no,
            state.input_version,
            state.relationship_score,
            state.potential_score,
            state.quadrant_code,
            state.primary_opportunity_id::text as primary_opportunity_id,
            state.risk_level,
            state.data_sufficiency,
            state.data_gaps,
            state.summary,
            state.analysis_run_id::text as analysis_run_id,
            state.effective_at
          from app.battle_state_versions as state
          where state.tenant_id = ${input.actor.tenantId}::uuid
            and state.entity_id = ${input.entityId}::uuid
          ${versionFilter}
          ${stateVisibilityFilter(input.actor)}
          limit 1
        `.execute(transaction);
        const state = stateResult.rows[0];
        if (!state) {
          throw new BattleStateNotFoundError();
        }
        const facts = await transaction
          .selectFrom("app.battle_state_evidence_links as link")
          .innerJoin("app.business_facts as fact", (join) =>
            join
              .onRef("fact.tenant_id", "=", "link.tenant_id")
              .onRef("fact.id", "=", "link.fact_id"),
          )
          .select([
            "fact.id as fact_id",
            "fact.fact_type",
            "fact.fact_value",
            "fact.occurred_at",
            "fact.opportunity_id",
          ])
          .where("link.tenant_id", "=", input.actor.tenantId)
          .where("link.battle_state_version_id", "=", state.state_id)
          .where("link.fact_id", "is not", null)
          .orderBy("fact.occurred_at")
          .orderBy("fact.id")
          .execute();
        const signals = await transaction
          .selectFrom("app.battle_state_evidence_links as link")
          .innerJoin("app.business_signals as signal", (join) =>
            join
              .onRef("signal.tenant_id", "=", "link.tenant_id")
              .onRef("signal.id", "=", "link.signal_id"),
          )
          .select([
            "signal.id as signal_id",
            "signal.fact_id",
            "signal.dimension",
            "signal.direction",
            "signal.strength",
            "signal.reason",
          ])
          .where("link.tenant_id", "=", input.actor.tenantId)
          .where("link.battle_state_version_id", "=", state.state_id)
          .where("link.signal_id", "is not", null)
          .orderBy("signal.created_at")
          .orderBy("signal.id")
          .execute();
        const evidenceFactIds = facts.map((fact) => fact.fact_id);

        return {
          state: mapState(state, evidenceFactIds),
          evidenceFacts: facts.map((fact) => ({
            factId: fact.fact_id,
            factType: fact.fact_type,
            factValue: fact.fact_value,
            occurredAt: toIsoString(fact.occurred_at),
            opportunityId: fact.opportunity_id,
          })),
          signals: signals.map((signal) => ({
            signalId: signal.signal_id,
            factId: signal.fact_id,
            dimension: signal.dimension,
            direction: signal.direction,
            strength: signal.strength,
            reason: signal.reason,
          })),
        };
      },
    );
  }

  async listMap(
    input: Parameters<BattleQueryReader["listMap"]>[0],
  ): Promise<BattleMapPage> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new InvalidBattleMapCursorError();
    }
    const cursor = input.cursor ? decodeMapCursor(input.cursor) : undefined;

    return withTenantTransaction(
      this.database,
      {
        ...input.actor,
        requestId: this.requestIdFactory(),
      },
      async (transaction) => {
        const entityFilter = input.entityId
          ? sql`and entity.id = ${input.entityId}::uuid`
          : sql``;
        const t0Filter =
          input.isT0 === undefined
            ? sql``
            : sql`and entity.is_t0 = ${input.isT0}`;
        const quadrantFilter = input.quadrantCode
          ? sql`and state.quadrant_code = ${input.quadrantCode}`
          : sql``;
        const sufficiencyFilter = input.dataSufficiency
          ? sql`and state.data_sufficiency = ${input.dataSufficiency}`
          : sql``;
        const cursorFilter = cursor
          ? sql`and (entity.updated_at, entity.id) < (
              ${cursor.updatedAt}::timestamptz,
              ${cursor.id}::uuid
            )`
          : sql``;
        const result = await sql<MapRow>`
          select
            entity.id::text as entity_id,
            entity.name as entity_name,
            entity_type.code as entity_type_code,
            entity.is_t0,
            entity.updated_at as entity_updated_at,
            primary_owner.display_name as primary_owner_name,
            state.id::text as state_id,
            state.version_no,
            state.input_version,
            state.relationship_score,
            state.potential_score,
            state.quadrant_code,
            state.primary_opportunity_id::text as primary_opportunity_id,
            state.risk_level,
            state.data_sufficiency,
            state.data_gaps,
            state.summary,
            state.analysis_run_id::text as analysis_run_id,
            state.effective_at,
            coalesce(evidence.fact_ids, '[]'::jsonb) as evidence_fact_ids
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
              and assignment.valid_from <= current_timestamp
              and (
                assignment.valid_to is null
                or assignment.valid_to > current_timestamp
              )
            order by assignment.valid_from desc, assignment.id desc
            limit 1
          ) as primary_owner on true
          left join app.battle_state_current as current_state
            on current_state.tenant_id = entity.tenant_id
            and current_state.entity_id = entity.id
          left join app.battle_state_versions as state
            on state.tenant_id = current_state.tenant_id
            and state.id = current_state.battle_state_version_id
          left join lateral (
            select jsonb_agg(link.fact_id::text order by link.fact_id) as fact_ids
            from app.battle_state_evidence_links as link
            where link.tenant_id = state.tenant_id
              and link.battle_state_version_id = state.id
              and link.fact_id is not null
          ) as evidence on true
          where entity.tenant_id = ${input.actor.tenantId}::uuid
          ${entityVisibilityFilter(input.actor)}
          ${entityFilter}
          ${t0Filter}
          ${quadrantFilter}
          ${sufficiencyFilter}
          ${cursorFilter}
          order by entity.updated_at desc, entity.id desc
          limit ${input.limit + 1}
        `.execute(transaction);
        const hasNextPage = result.rows.length > input.limit;
        const rows = result.rows.slice(0, input.limit);
        const last = rows.at(-1);
        return {
          items: rows.map((row) => ({
            entityId: row.entity_id,
            entityName: row.entity_name,
            entityTypeCode: row.entity_type_code,
            isT0: row.is_t0,
            primaryOwnerName: row.primary_owner_name,
            state:
              row.state_id === null
                ? null
                : mapState(
                    row as StateRow,
                    decodeStringArray(row.evidence_fact_ids),
                  ),
          })),
          nextCursor:
            hasNextPage && last
              ? encodeMapCursor({
                  updatedAt: toIsoString(last.entity_updated_at),
                  id: last.entity_id,
                })
              : null,
        };
      },
    );
  }
}

function stateVisibilityFilter(actor: ActorScope) {
  return sql`
    and exists (
      select 1
      from app.entity_assignments as visible_assignment
      where visible_assignment.tenant_id = ${actor.tenantId}::uuid
        and visible_assignment.entity_id = state.entity_id
        and visible_assignment.user_id = ${actor.userId}::uuid
        and visible_assignment.valid_from <= current_timestamp
        and (
          visible_assignment.valid_to is null
          or visible_assignment.valid_to > current_timestamp
        )
    )
  `;
}

function entityVisibilityFilter(actor: ActorScope) {
  return sql`
    and exists (
      select 1
      from app.entity_assignments as visible_assignment
      where visible_assignment.tenant_id = ${actor.tenantId}::uuid
        and visible_assignment.entity_id = entity.id
        and visible_assignment.user_id = ${actor.userId}::uuid
        and visible_assignment.valid_from <= current_timestamp
        and (
          visible_assignment.valid_to is null
          or visible_assignment.valid_to > current_timestamp
        )
    )
  `;
}

function mapState(row: StateRow, evidenceFactIds: string[]): BattleStateRecord {
  return {
    battleStateVersionId: row.state_id,
    entityId: row.entity_id,
    versionNo: String(row.version_no),
    inputVersion: row.input_version,
    relationshipScore:
      row.relationship_score === null ? null : String(row.relationship_score),
    potentialScore:
      row.potential_score === null ? null : String(row.potential_score),
    quadrantCode: row.quadrant_code,
    primaryOpportunityId: row.primary_opportunity_id,
    riskLevel: row.risk_level,
    dataSufficiency: row.data_sufficiency,
    dataGaps: decodeStringArray(row.data_gaps),
    summary: row.summary,
    analysisRunId: row.analysis_run_id,
    effectiveAt: toIsoString(row.effective_at),
    evidenceFactIds,
  };
}

function encodeMapCursor(cursor: MapCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMapCursor(value: string): MapCursor {
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
      !isUuid(candidate.id)
    ) {
      throw new Error("Cursor values are invalid.");
    }
    return { updatedAt: candidate.updatedAt, id: candidate.id };
  } catch (error) {
    throw new InvalidBattleMapCursorError({ cause: error });
  }
}

function decodeStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("Database JSON string array is invalid.");
  }
  return parsed;
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
