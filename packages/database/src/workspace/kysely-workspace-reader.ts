import { randomUUID } from "node:crypto";
import type {
  WorkspaceBattleChange,
  WorkspacePriorityAction,
  WorkspaceProjection,
  WorkspaceReader,
  WorkspaceScopeMode,
} from "@battlefield/core";
import { type Kysely, sql } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

interface KpiRow {
  assigned_entity_count: bigint | number | string;
  has_personal_scope: boolean | null;
  has_observer_scope: boolean | null;
  pending_draft_count: bigint | number | string;
  pending_proposal_count: bigint | number | string;
  overdue_action_count: bigint | number | string;
  unread_notification_count: bigint | number | string;
  high_risk_entity_count: bigint | number | string;
  data_incomplete_entity_count: bigint | number | string;
}

interface ActionRow {
  action_id: string;
  entity_id: string;
  entity_name: string;
  title: string;
  owner_user_id: string;
  owner_name: string;
  priority: "low" | "medium" | "high" | "urgent";
  status: "planned" | "in_progress";
  planned_at: Date | string;
  is_overdue: boolean;
}

interface BattleChangeRow {
  entity_id: string;
  entity_name: string;
  is_t0: boolean;
  state_id: string;
  effective_at: Date | string;
  relationship_score: number | string | null;
  potential_score: number | string | null;
  quadrant_code: string | null;
  risk_level: "low" | "medium" | "high" | "critical";
  data_sufficiency: "insufficient" | "partial" | "sufficient";
  data_gaps: unknown;
  previous_state_id: string | null;
  previous_relationship_score: number | string | null;
  previous_potential_score: number | string | null;
  previous_quadrant_code: string | null;
}

interface QuadrantRow {
  quadrant_code: string | null;
  entity_count: bigint | number | string;
}

export interface KyselyWorkspaceReaderOptions {
  requestIdFactory?: () => string;
}

export class InvalidWorkspaceNowError extends Error {
  constructor(options?: ErrorOptions) {
    super("The workspace projection instant is invalid.", options);
    this.name = "InvalidWorkspaceNowError";
  }
}

export class KyselyWorkspaceReader implements WorkspaceReader {
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyWorkspaceReaderOptions = {},
  ) {
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async read(
    input: Parameters<WorkspaceReader["read"]>[0],
  ): Promise<WorkspaceProjection> {
    assertCanonicalInstant(input.now);
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const kpiResult = await sql<KpiRow>`
          with scoped_entities as (
            select
              assignment.entity_id,
              bool_or(assignment.assignment_role in ('owner', 'collaborator'))
                as has_personal_scope,
              bool_or(assignment.assignment_role = 'management_observer')
                as has_observer_scope
            from app.entity_assignments as assignment
            where assignment.tenant_id = ${input.actor.tenantId}::uuid
              and assignment.user_id = ${input.actor.userId}::uuid
              and assignment.valid_from <= ${input.now}::timestamptz
              and (
                assignment.valid_to is null
                or assignment.valid_to > ${input.now}::timestamptz
              )
            group by assignment.entity_id
          ), scoped_states as (
            select
              scope.entity_id,
              scope.has_personal_scope,
              scope.has_observer_scope,
              state.risk_level,
              state.data_sufficiency
            from scoped_entities as scope
            left join app.battle_state_current as current_state
              on current_state.tenant_id = ${input.actor.tenantId}::uuid
              and current_state.entity_id = scope.entity_id
            left join app.battle_state_versions as state
              on state.tenant_id = current_state.tenant_id
              and state.id = current_state.battle_state_version_id
          )
          select
            count(*) as assigned_entity_count,
            coalesce(bool_or(scoped_states.has_personal_scope), false)
              as has_personal_scope,
            coalesce(bool_or(scoped_states.has_observer_scope), false)
              as has_observer_scope,
            (
              select count(*)
              from app.followup_drafts as draft
              inner join app.source_inputs as source
                on source.tenant_id = draft.tenant_id
                and source.id = draft.source_input_id
              where draft.tenant_id = ${input.actor.tenantId}::uuid
                and source.submitted_by = ${input.actor.userId}::uuid
                and draft.status = 'pending_confirmation'
                and draft.expires_at > ${input.now}::timestamptz
            ) as pending_draft_count,
            (
              select count(*)
              from app.action_proposals as proposal
              inner join scoped_entities as scope
                on scope.entity_id = proposal.entity_id
              where proposal.tenant_id = ${input.actor.tenantId}::uuid
                and proposal.status = 'pending_confirmation'
                and proposal.expires_at > ${input.now}::timestamptz
            ) as pending_proposal_count,
            (
              select count(*)
              from app.business_actions as action
              inner join scoped_entities as scope
                on scope.entity_id = action.entity_id
              where action.tenant_id = ${input.actor.tenantId}::uuid
                and action.status in ('planned', 'in_progress')
                and action.planned_at <= ${input.now}::timestamptz
                and (
                  action.owner_user_id = ${input.actor.userId}::uuid
                  or scope.has_observer_scope
                )
            ) as overdue_action_count,
            (
              select count(*)
              from app.notification_events as notification
              where notification.tenant_id = ${input.actor.tenantId}::uuid
                and notification.recipient_user_id = ${input.actor.userId}::uuid
                and notification.read_at is null
            ) as unread_notification_count,
            count(*) filter (
              where scoped_states.risk_level in ('high', 'critical')
            ) as high_risk_entity_count,
            count(*) filter (
              where scoped_states.data_sufficiency is null
                or scoped_states.data_sufficiency <> 'sufficient'
            ) as data_incomplete_entity_count
          from scoped_states
        `.execute(transaction);
        const kpiRow = kpiResult.rows[0];
        if (!kpiRow) {
          throw new Error("Workspace KPI projection returned no row.");
        }

        const actionResult = await sql<ActionRow>`
          with scoped_entities as (
            select
              assignment.entity_id,
              bool_or(assignment.assignment_role = 'management_observer')
                as has_observer_scope
            from app.entity_assignments as assignment
            where assignment.tenant_id = ${input.actor.tenantId}::uuid
              and assignment.user_id = ${input.actor.userId}::uuid
              and assignment.valid_from <= ${input.now}::timestamptz
              and (
                assignment.valid_to is null
                or assignment.valid_to > ${input.now}::timestamptz
              )
            group by assignment.entity_id
          )
          select
            action.id::text as action_id,
            action.entity_id::text as entity_id,
            entity.name as entity_name,
            action.title,
            action.owner_user_id::text as owner_user_id,
            owner.display_name as owner_name,
            action.priority,
            action.status,
            action.planned_at,
            action.planned_at <= ${input.now}::timestamptz as is_overdue
          from app.business_actions as action
          inner join scoped_entities as scope
            on scope.entity_id = action.entity_id
          inner join app.business_entities as entity
            on entity.tenant_id = action.tenant_id
            and entity.id = action.entity_id
          inner join app.users as owner
            on owner.tenant_id = action.tenant_id
            and owner.id = action.owner_user_id
          where action.tenant_id = ${input.actor.tenantId}::uuid
            and action.status in ('planned', 'in_progress')
            and (
              action.owner_user_id = ${input.actor.userId}::uuid
              or scope.has_observer_scope
            )
          order by
            case when action.planned_at <= ${input.now}::timestamptz
              then 0 else 1 end,
            case action.priority
              when 'urgent' then 0
              when 'high' then 1
              when 'medium' then 2
              else 3
            end,
            action.planned_at,
            action.id
          limit 5
        `.execute(transaction);

        const battleResult = await sql<BattleChangeRow>`
          with scoped_entities as (
            select distinct assignment.entity_id
            from app.entity_assignments as assignment
            where assignment.tenant_id = ${input.actor.tenantId}::uuid
              and assignment.user_id = ${input.actor.userId}::uuid
              and assignment.valid_from <= ${input.now}::timestamptz
              and (
                assignment.valid_to is null
                or assignment.valid_to > ${input.now}::timestamptz
              )
          )
          select
            entity.id::text as entity_id,
            entity.name as entity_name,
            entity.is_t0,
            state.id::text as state_id,
            state.effective_at,
            state.relationship_score,
            state.potential_score,
            state.quadrant_code,
            state.risk_level,
            state.data_sufficiency,
            state.data_gaps,
            previous_state.id::text as previous_state_id,
            previous_state.relationship_score as previous_relationship_score,
            previous_state.potential_score as previous_potential_score,
            previous_state.quadrant_code as previous_quadrant_code
          from scoped_entities as scope
          inner join app.business_entities as entity
            on entity.tenant_id = ${input.actor.tenantId}::uuid
            and entity.id = scope.entity_id
          inner join app.battle_state_current as current_state
            on current_state.tenant_id = entity.tenant_id
            and current_state.entity_id = entity.id
          inner join app.battle_state_versions as state
            on state.tenant_id = current_state.tenant_id
            and state.id = current_state.battle_state_version_id
          left join lateral (
            select previous.*
            from app.battle_state_versions as previous
            where previous.tenant_id = state.tenant_id
              and previous.entity_id = state.entity_id
              and previous.version_no < state.version_no
            order by previous.version_no desc
            limit 1
          ) as previous_state on true
          where entity.tenant_id = ${input.actor.tenantId}::uuid
          order by state.effective_at desc, state.id desc
          limit 5
        `.execute(transaction);

        const quadrantResult = await sql<QuadrantRow>`
          with scoped_entities as (
            select distinct assignment.entity_id
            from app.entity_assignments as assignment
            where assignment.tenant_id = ${input.actor.tenantId}::uuid
              and assignment.user_id = ${input.actor.userId}::uuid
              and assignment.valid_from <= ${input.now}::timestamptz
              and (
                assignment.valid_to is null
                or assignment.valid_to > ${input.now}::timestamptz
              )
          )
          select
            state.quadrant_code,
            count(*) as entity_count
          from scoped_entities as scope
          left join app.battle_state_current as current_state
            on current_state.tenant_id = ${input.actor.tenantId}::uuid
            and current_state.entity_id = scope.entity_id
          left join app.battle_state_versions as state
            on state.tenant_id = current_state.tenant_id
            and state.id = current_state.battle_state_version_id
          group by state.quadrant_code
          order by state.quadrant_code nulls last
        `.execute(transaction);

        return {
          scopeMode: toScopeMode(
            Boolean(kpiRow.has_personal_scope),
            Boolean(kpiRow.has_observer_scope),
          ),
          kpis: {
            assignedEntityCount: toCount(kpiRow.assigned_entity_count),
            pendingDraftCount: toCount(kpiRow.pending_draft_count),
            pendingProposalCount: toCount(kpiRow.pending_proposal_count),
            overdueActionCount: toCount(kpiRow.overdue_action_count),
            unreadNotificationCount: toCount(kpiRow.unread_notification_count),
            highRiskEntityCount: toCount(kpiRow.high_risk_entity_count),
            dataIncompleteEntityCount: toCount(
              kpiRow.data_incomplete_entity_count,
            ),
          },
          priorityActions: actionResult.rows.map(mapAction),
          recentBattleChanges: battleResult.rows.map(mapBattleChange),
          quadrantDistribution: quadrantResult.rows.map((row) => ({
            quadrantCode: row.quadrant_code,
            count: toCount(row.entity_count),
          })),
        };
      },
    );
  }
}

function toScopeMode(
  hasPersonalScope: boolean,
  hasObserverScope: boolean,
): WorkspaceScopeMode {
  if (hasPersonalScope && hasObserverScope) return "mixed";
  if (hasObserverScope) return "observed_portfolio";
  return "personal";
}

function mapAction(row: ActionRow): WorkspacePriorityAction {
  return {
    actionId: row.action_id,
    entityId: row.entity_id,
    entityName: row.entity_name,
    title: row.title,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    priority: row.priority,
    status: row.status,
    plannedAt: toIsoString(row.planned_at),
    isOverdue: row.is_overdue,
    deepLink: `/actions?actionId=${row.action_id}`,
  };
}

function mapBattleChange(row: BattleChangeRow): WorkspaceBattleChange {
  const currentRelationship = toNullableScore(row.relationship_score);
  const currentPotential = toNullableScore(row.potential_score);
  const previousRelationship = toNullableScore(row.previous_relationship_score);
  const previousPotential = toNullableScore(row.previous_potential_score);
  const hasPrevious = row.previous_state_id !== null;
  return {
    entityId: row.entity_id,
    entityName: row.entity_name,
    isT0: row.is_t0,
    battleStateVersionId: row.state_id,
    effectiveAt: toIsoString(row.effective_at),
    relationshipScore: currentRelationship,
    potentialScore: currentPotential,
    quadrantCode: row.quadrant_code,
    riskLevel: row.risk_level,
    dataSufficiency: row.data_sufficiency,
    dataGaps: decodeStringArray(row.data_gaps).slice(0, 20),
    previousState: hasPrevious
      ? {
          battleStateVersionId: row.previous_state_id as string,
          relationshipScore: previousRelationship,
          potentialScore: previousPotential,
          quadrantCode: row.previous_quadrant_code,
        }
      : null,
    relationshipDelta: hasPrevious
      ? scoreDelta(currentRelationship, previousRelationship)
      : null,
    potentialDelta: hasPrevious
      ? scoreDelta(currentPotential, previousPotential)
      : null,
    quadrantChanged: hasPrevious
      ? row.quadrant_code !== row.previous_quadrant_code
      : false,
    changeKind: hasPrevious ? "updated" : "new_baseline",
    deepLink: `/battle-map?entityId=${row.entity_id}&stateVersion=${row.state_id}`,
  };
}

function scoreDelta(
  current: string | null,
  previous: string | null,
): number | null {
  if (current === null || previous === null) return null;
  return Number((Number(current) - Number(previous)).toFixed(2));
}

function toNullableScore(value: number | string | null): string | null {
  return value === null ? null : String(value);
}

function toCount(value: bigint | number | string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Workspace count is outside the safe integer range.");
  }
  return count;
}

function decodeStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("Workspace data gaps are not a JSON string array.");
  }
  return parsed;
}

function assertCanonicalInstant(value: string): void {
  try {
    if (new Date(value).toISOString() !== value) {
      throw new Error("Instant is not canonical.");
    }
  } catch (error) {
    throw new InvalidWorkspaceNowError({ cause: error });
  }
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Workspace timestamp is invalid.");
  }
  return date.toISOString();
}
