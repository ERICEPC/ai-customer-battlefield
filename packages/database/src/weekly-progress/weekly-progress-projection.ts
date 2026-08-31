import { sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

export interface WeeklyProgressScopeEntity {
  entity_id: string;
  entity_name: string;
}

export interface WeeklyProgressEvidence {
  kind: "followup" | "fact" | "stage_change" | "action" | "battle_state";
  evidenceId: string;
  occurredAt: string;
  label: string;
  deepLink: string;
}

export interface WeeklyProgressMetrics {
  confirmedFollowupCount: number;
  validFactCount: number;
  stageChangeCount: number;
  completedActionCount: number;
  openActionCount: number;
  overdueActionCount: number;
}

export interface WeeklyProgressEntityProjection extends WeeklyProgressMetrics {
  entityId: string;
  entityName: string;
  progressEvidence: WeeklyProgressEvidence[];
  openActionEvidence: WeeklyProgressEvidence[];
  overdueEvidence: WeeklyProgressEvidence[];
  battleStateEvidence: WeeklyProgressEvidence | null;
  riskLevel: "low" | "medium" | "high" | "critical" | null;
}

export interface WeeklyProgressProjection {
  entities: WeeklyProgressEntityProjection[];
  metrics: WeeklyProgressMetrics;
}

interface OpenActionRow {
  id: string;
  entity_id: string;
  title: string;
  planned_at: Date | string;
  confirmed_at: Date | string;
}

interface BattleStateRow {
  id: string;
  entity_id: string;
  summary: string;
  risk_level: "low" | "medium" | "high" | "critical";
  effective_at: Date | string;
}

const MAX_EVIDENCE_LABEL_LENGTH = 500;

export async function projectWeeklyProgress(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    entities: WeeklyProgressScopeEntity[];
    actionOwnerUserIds: string[];
    periodStart: string;
    periodEnd: string;
    dataCutoffAt: string;
    maxEventRowsPerKind: number;
    assertRowLimit: (actual: number, maximum: number) => void;
  },
): Promise<WeeklyProgressProjection> {
  const entityIds = input.entities.map((entity) => entity.entity_id);
  const projections = new Map<string, WeeklyProgressEntityProjection>(
    input.entities.map((entity) => [
      entity.entity_id,
      {
        entityId: entity.entity_id,
        entityName: entity.entity_name,
        ...emptyMetrics(),
        progressEvidence: [],
        openActionEvidence: [],
        overdueEvidence: [],
        battleStateEvidence: null,
        riskLevel: null,
      },
    ]),
  );
  if (entityIds.length === 0) {
    return { entities: [], metrics: emptyMetrics() };
  }

  const followups = await transaction
    .selectFrom("app.followups")
    .select(["id", "entity_id", "occurred_at", "summary"])
    .where("tenant_id", "=", input.tenantId)
    .where("entity_id", "in", entityIds)
    .where("occurred_at", ">=", sql<Date>`${input.periodStart}::timestamptz`)
    .where("occurred_at", "<", sql<Date>`${input.periodEnd}::timestamptz`)
    .where("occurred_at", "<=", sql<Date>`${input.dataCutoffAt}::timestamptz`)
    .where("confirmed_at", "<=", sql<Date>`${input.dataCutoffAt}::timestamptz`)
    .limit(input.maxEventRowsPerKind + 1)
    .execute();
  input.assertRowLimit(followups.length, input.maxEventRowsPerKind);
  for (const row of followups) {
    const projection = projections.get(row.entity_id);
    if (!projection) continue;
    projection.confirmedFollowupCount += 1;
    addEvidence(projection.progressEvidence, {
      kind: "followup",
      evidenceId: row.id,
      occurredAt: toIso(row.occurred_at),
      label: evidenceLabel(row.summary),
      deepLink: `/battle-map?entityId=${row.entity_id}`,
    });
  }

  const facts = await transaction
    .selectFrom("app.business_facts")
    .select(["id", "entity_id", "occurred_at", "fact_value"])
    .where("tenant_id", "=", input.tenantId)
    .where("entity_id", "in", entityIds)
    .where("valid_status", "=", "valid")
    .where("occurred_at", ">=", sql<Date>`${input.periodStart}::timestamptz`)
    .where("occurred_at", "<", sql<Date>`${input.periodEnd}::timestamptz`)
    .where("occurred_at", "<=", sql<Date>`${input.dataCutoffAt}::timestamptz`)
    .where("confirmed_at", "<=", sql<Date>`${input.dataCutoffAt}::timestamptz`)
    .limit(input.maxEventRowsPerKind + 1)
    .execute();
  input.assertRowLimit(facts.length, input.maxEventRowsPerKind);
  for (const row of facts) {
    const projection = projections.get(row.entity_id);
    if (!projection) continue;
    projection.validFactCount += 1;
    addEvidence(projection.progressEvidence, {
      kind: "fact",
      evidenceId: row.id,
      occurredAt: toIso(row.occurred_at),
      label: evidenceLabel(row.fact_value),
      deepLink: `/battle-map?entityId=${row.entity_id}`,
    });
  }

  const stages = await transaction
    .selectFrom("app.opportunity_stage_history as history")
    .innerJoin("app.opportunities as opportunity", (join) =>
      join
        .onRef("opportunity.tenant_id", "=", "history.tenant_id")
        .onRef("opportunity.id", "=", "history.opportunity_id"),
    )
    .select([
      "history.id",
      "opportunity.entity_id",
      "history.changed_at",
      "history.from_stage_code",
      "history.to_stage_code",
    ])
    .where("history.tenant_id", "=", input.tenantId)
    .where("opportunity.entity_id", "in", entityIds)
    .where(
      "history.changed_at",
      ">=",
      sql<Date>`${input.periodStart}::timestamptz`,
    )
    .where(
      "history.changed_at",
      "<",
      sql<Date>`${input.periodEnd}::timestamptz`,
    )
    .where(
      "history.changed_at",
      "<=",
      sql<Date>`${input.dataCutoffAt}::timestamptz`,
    )
    .limit(input.maxEventRowsPerKind + 1)
    .execute();
  input.assertRowLimit(stages.length, input.maxEventRowsPerKind);
  for (const row of stages) {
    const projection = projections.get(row.entity_id);
    if (!projection) continue;
    projection.stageChangeCount += 1;
    addEvidence(projection.progressEvidence, {
      kind: "stage_change",
      evidenceId: row.id,
      occurredAt: toIso(row.changed_at),
      label: evidenceLabel(
        `${row.from_stage_code ?? "未设置"} → ${row.to_stage_code}`,
      ),
      deepLink: `/battle-map?entityId=${row.entity_id}`,
    });
  }

  let completedActions: Array<{
    id: string;
    entity_id: string;
    title: string;
    changed_at: Date | string;
  }> = [];
  let openActions: OpenActionRow[] = [];
  if (input.actionOwnerUserIds.length > 0) {
    completedActions = await transaction
      .selectFrom("app.action_status_history as history")
      .innerJoin("app.business_actions as action", (join) =>
        join
          .onRef("action.tenant_id", "=", "history.tenant_id")
          .onRef("action.id", "=", "history.action_id"),
      )
      .select([
        "action.id",
        "action.entity_id",
        "action.title",
        "history.changed_at",
      ])
      .where("history.tenant_id", "=", input.tenantId)
      .where("action.entity_id", "in", entityIds)
      .where("action.owner_user_id", "in", input.actionOwnerUserIds)
      .where("history.to_status", "=", "completed")
      .where(
        "history.changed_at",
        ">=",
        sql<Date>`${input.periodStart}::timestamptz`,
      )
      .where(
        "history.changed_at",
        "<",
        sql<Date>`${input.periodEnd}::timestamptz`,
      )
      .where(
        "history.changed_at",
        "<=",
        sql<Date>`${input.dataCutoffAt}::timestamptz`,
      )
      .limit(input.maxEventRowsPerKind + 1)
      .execute();
    input.assertRowLimit(completedActions.length, input.maxEventRowsPerKind);
    const openResult = await sql<OpenActionRow>`
      select
        action.id::text as id,
        action.entity_id::text as entity_id,
        action.title,
        action.planned_at,
        action.confirmed_at
      from app.business_actions as action
      inner join lateral (
        select history.to_status
        from app.action_status_history as history
        where history.tenant_id = action.tenant_id
          and history.action_id = action.id
          and history.changed_at < ${input.periodEnd}::timestamptz
          and history.changed_at <= ${input.dataCutoffAt}::timestamptz
        order by history.version_no desc
        limit 1
      ) as cutoff_status on true
      where action.tenant_id = ${input.tenantId}::uuid
        and action.entity_id in (
          ${sql.join(entityIds.map((id) => sql`${id}::uuid`))}
        )
        and action.owner_user_id in (
          ${sql.join(input.actionOwnerUserIds.map((id) => sql`${id}::uuid`))}
        )
        and action.confirmed_at < ${input.periodEnd}::timestamptz
        and action.confirmed_at <= ${input.dataCutoffAt}::timestamptz
        and cutoff_status.to_status in ('planned', 'in_progress')
      limit ${input.maxEventRowsPerKind - completedActions.length + 1}
    `.execute(transaction);
    openActions = openResult.rows;
    input.assertRowLimit(
      completedActions.length + openActions.length,
      input.maxEventRowsPerKind,
    );
  }
  for (const row of completedActions) {
    const projection = projections.get(row.entity_id);
    if (!projection) continue;
    projection.completedActionCount += 1;
    addEvidence(projection.progressEvidence, {
      kind: "action",
      evidenceId: row.id,
      occurredAt: toIso(row.changed_at),
      label: evidenceLabel(row.title),
      deepLink: `/actions?actionId=${row.id}`,
    });
  }
  for (const row of openActions) {
    const projection = projections.get(row.entity_id);
    if (!projection) continue;
    projection.openActionCount += 1;
    const evidence: WeeklyProgressEvidence = {
      kind: "action",
      evidenceId: row.id,
      occurredAt: toIso(row.confirmed_at),
      label: evidenceLabel(row.title),
      deepLink: `/actions?actionId=${row.id}`,
    };
    addEvidence(projection.openActionEvidence, evidence);
    if (new Date(row.planned_at).getTime() <= Date.parse(input.dataCutoffAt)) {
      projection.overdueActionCount += 1;
      addEvidence(projection.overdueEvidence, evidence);
    }
  }

  const stateResult = await sql<BattleStateRow>`
    select distinct on (state.entity_id)
      state.id::text as id,
      state.entity_id::text as entity_id,
      state.summary,
      state.risk_level,
      state.effective_at
    from app.battle_state_versions as state
    where state.tenant_id = ${input.tenantId}::uuid
      and state.entity_id in (
        ${sql.join(entityIds.map((id) => sql`${id}::uuid`))}
      )
      and state.effective_at < ${input.periodEnd}::timestamptz
      and state.effective_at <= ${input.dataCutoffAt}::timestamptz
    order by state.entity_id, state.effective_at desc, state.version_no desc
  `.execute(transaction);
  for (const row of stateResult.rows) {
    const projection = projections.get(row.entity_id);
    if (!projection) continue;
    projection.riskLevel = row.risk_level;
    projection.battleStateEvidence = {
      kind: "battle_state",
      evidenceId: row.id,
      occurredAt: toIso(row.effective_at),
      label: evidenceLabel(row.summary),
      deepLink: `/battle-map?entityId=${row.entity_id}&stateVersion=${row.id}`,
    };
  }

  const metrics = emptyMetrics();
  for (const projection of projections.values())
    addMetrics(metrics, projection);
  return { entities: [...projections.values()], metrics };
}

function emptyMetrics(): WeeklyProgressMetrics {
  return {
    confirmedFollowupCount: 0,
    validFactCount: 0,
    stageChangeCount: 0,
    completedActionCount: 0,
    openActionCount: 0,
    overdueActionCount: 0,
  };
}

function addMetrics(
  target: WeeklyProgressMetrics,
  source: WeeklyProgressMetrics,
): void {
  target.confirmedFollowupCount += source.confirmedFollowupCount;
  target.validFactCount += source.validFactCount;
  target.stageChangeCount += source.stageChangeCount;
  target.completedActionCount += source.completedActionCount;
  target.openActionCount += source.openActionCount;
  target.overdueActionCount += source.overdueActionCount;
}

function addEvidence(
  target: WeeklyProgressEvidence[],
  evidence: WeeklyProgressEvidence,
): void {
  if (
    !target.some(
      (candidate) =>
        candidate.kind === evidence.kind &&
        candidate.evidenceId === evidence.evidenceId,
    )
  ) {
    target.push(evidence);
  }
}

function evidenceLabel(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  if (normalized.length <= MAX_EVIDENCE_LABEL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_EVIDENCE_LABEL_LENGTH - 1)}…`;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Database timestamp is invalid.");
  }
  return date.toISOString();
}
