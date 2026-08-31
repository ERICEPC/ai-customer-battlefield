import { createHash, randomUUID } from "node:crypto";
import {
  InvalidManagementQueryCursorError,
  type ManagementQueryDataGap,
  type ManagementQueryEvidence,
  type ManagementQueryHighlight,
  ManagementQueryIdempotencyConflictError,
  type ManagementQueryMetrics,
  type ManagementQueryRepository,
  type ManagementQueryResult,
  ManagementQueryResultLimitExceededError,
  ManagementQuerySubjectNotFoundError,
} from "@battlefield/core";
import { type Kysely, type RawBuilder, sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed";
  response_payload: Record<string, unknown> | null;
}

interface SubjectRow {
  user_id: string;
  display_name: string;
  scope_kind: "self" | "observed_portfolio";
  sort_rank: number | string;
  sort_name: string;
}

interface SubjectCursor {
  rank: number;
  displayName: string;
  id: string;
}

interface EntityRow {
  entity_id: string;
  entity_name: string;
}

interface SubjectScopeRow {
  user_id: string;
  display_name: string;
  scope_kind: "self" | "observed_portfolio";
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
  effective_at: Date | string;
}

interface EntityAggregate extends ManagementQueryHighlight {
  hasBattleState: boolean;
}

const DEFAULT_MAX_SCOPED_ENTITIES = 500;
const DEFAULT_MAX_EVENT_ROWS_PER_KIND = 5_000;
const MAX_EVIDENCE_LABEL_LENGTH = 500;

export interface KyselyManagementQueryRepositoryOptions {
  queryIdFactory?: () => string;
  requestIdFactory?: () => string;
  maxScopedEntities?: number;
  maxEventRowsPerKind?: number;
}

export class KyselyManagementQueryRepository
  implements ManagementQueryRepository
{
  private readonly queryIdFactory: () => string;
  private readonly requestIdFactory: () => string;
  private readonly maxScopedEntities: number;
  private readonly maxEventRowsPerKind: number;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyManagementQueryRepositoryOptions = {},
  ) {
    this.queryIdFactory = options.queryIdFactory ?? randomUUID;
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.maxScopedEntities = positiveLimit(
      options.maxScopedEntities ?? DEFAULT_MAX_SCOPED_ENTITIES,
    );
    this.maxEventRowsPerKind = positiveLimit(
      options.maxEventRowsPerKind ?? DEFAULT_MAX_EVENT_ROWS_PER_KIND,
    );
  }

  async listSubjects(
    input: Parameters<ManagementQueryRepository["listSubjects"]>[0],
  ) {
    assertLimit(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;

    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const cursorFilter = cursor
          ? sql`and (candidate.sort_rank, candidate.sort_name, candidate.user_id) > (
              ${cursor.rank},
              ${cursor.displayName},
              ${cursor.id}::uuid
            )`
          : sql``;
        const result = await sql<SubjectRow>`
          with active_assignments as (
            ${activeAssignmentsSql(
              input.actor.tenantId,
              sql`current_timestamp`,
            )}
          ), candidate as (
            select
              app_user.id as user_id,
              app_user.display_name,
              'self'::text as scope_kind,
              0 as sort_rank,
              lower(app_user.display_name) as sort_name
            from app.users as app_user
            where app_user.tenant_id = ${input.actor.tenantId}::uuid
              and app_user.id = ${input.actor.userId}::uuid
              and app_user.status = 'active'
              and exists (
                select 1
                from active_assignments as self_assignment
                where self_assignment.tenant_id = app_user.tenant_id
                  and self_assignment.user_id = app_user.id
                  and self_assignment.assignment_role in ('owner', 'collaborator')
              )
            union all
            select
              app_user.id as user_id,
              app_user.display_name,
              'observed_portfolio'::text as scope_kind,
              1 as sort_rank,
              lower(app_user.display_name) as sort_name
            from app.users as app_user
            where app_user.tenant_id = ${input.actor.tenantId}::uuid
              and app_user.id <> ${input.actor.userId}::uuid
              and app_user.status = 'active'
              and exists (
                select 1
                from active_assignments as subject_assignment
                inner join active_assignments as observer_assignment
                  on observer_assignment.tenant_id = subject_assignment.tenant_id
                  and observer_assignment.entity_id = subject_assignment.entity_id
                where subject_assignment.tenant_id = app_user.tenant_id
                  and subject_assignment.user_id = app_user.id
                  and subject_assignment.assignment_role in ('owner', 'collaborator')
                  and observer_assignment.user_id = ${input.actor.userId}::uuid
                  and observer_assignment.assignment_role = 'management_observer'
              )
          )
          select
            candidate.user_id::text as user_id,
            candidate.display_name,
            candidate.scope_kind,
            candidate.sort_rank,
            candidate.sort_name
          from candidate
          where true
          ${cursorFilter}
          order by candidate.sort_rank, candidate.sort_name, candidate.user_id
          limit ${input.limit + 1}
        `.execute(transaction);

        const hasNext = result.rows.length > input.limit;
        const rows = result.rows.slice(0, input.limit);
        const last = rows.at(-1);
        return {
          items: rows.map((row) => ({
            userId: row.user_id,
            displayName: row.display_name,
            scopeKind: row.scope_kind,
          })),
          nextCursor:
            hasNext && last
              ? encodeCursor({
                  rank: Number(last.sort_rank),
                  displayName: last.sort_name,
                  id: last.user_id,
                })
              : null,
        };
      },
    );
  }

  async runSalesWeeklyProgress(
    input: Parameters<ManagementQueryRepository["runSalesWeeklyProgress"]>[0],
  ): Promise<ManagementQueryResult> {
    const requestId = this.requestIdFactory();

    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        const scopeResult = await sql<SubjectScopeRow>`
          with active_assignments as (
            ${activeAssignmentsSql(
              input.actor.tenantId,
              sql`${input.queryNow}::timestamptz`,
            )}
          )
          select
            subject.id::text as user_id,
            subject.display_name,
            case
              when subject.id = ${input.actor.userId}::uuid
                and exists (
                  select 1
                  from active_assignments as self_assignment
                  where self_assignment.tenant_id = subject.tenant_id
                    and self_assignment.user_id = subject.id
                    and self_assignment.assignment_role in ('owner', 'collaborator')
                )
              then 'self'
              when exists (
                select 1
                from active_assignments as subject_assignment
                inner join active_assignments as observer_assignment
                  on observer_assignment.tenant_id = subject_assignment.tenant_id
                  and observer_assignment.entity_id = subject_assignment.entity_id
                where subject_assignment.tenant_id = subject.tenant_id
                  and subject_assignment.user_id = subject.id
                  and subject_assignment.assignment_role in ('owner', 'collaborator')
                  and observer_assignment.user_id = ${input.actor.userId}::uuid
                  and observer_assignment.assignment_role = 'management_observer'
              )
              then 'observed_portfolio'
            end as scope_kind
          from app.users as subject
          where subject.tenant_id = ${input.actor.tenantId}::uuid
            and subject.id = ${input.subjectUserId}::uuid
            and subject.status = 'active'
        `.execute(transaction);
        const scope = scopeResult.rows[0];
        if (!scope?.scope_kind) {
          throw new ManagementQuerySubjectNotFoundError();
        }

        const entityResult =
          scope.scope_kind === "self"
            ? await sql<EntityRow>`
                with active_assignments as (
                  ${activeAssignmentsSql(
                    input.actor.tenantId,
                    sql`${input.queryNow}::timestamptz`,
                  )}
                )
                select distinct
                  entity.id::text as entity_id,
                  entity.name as entity_name
                from active_assignments as assignment
                inner join app.business_entities as entity
                  on entity.tenant_id = assignment.tenant_id
                  and entity.id = assignment.entity_id
                where assignment.tenant_id = ${input.actor.tenantId}::uuid
                  and assignment.user_id = ${input.subjectUserId}::uuid
                  and assignment.assignment_role in ('owner', 'collaborator')
                  and entity.status = 'active'
                order by entity_name, entity_id
                limit ${this.maxScopedEntities + 1}
              `.execute(transaction)
            : await sql<EntityRow>`
                with active_assignments as (
                  ${activeAssignmentsSql(
                    input.actor.tenantId,
                    sql`${input.queryNow}::timestamptz`,
                  )}
                )
                select distinct
                  entity.id::text as entity_id,
                  entity.name as entity_name
                from active_assignments as subject_assignment
                inner join active_assignments as observer_assignment
                  on observer_assignment.tenant_id = subject_assignment.tenant_id
                  and observer_assignment.entity_id = subject_assignment.entity_id
                inner join app.business_entities as entity
                  on entity.tenant_id = subject_assignment.tenant_id
                  and entity.id = subject_assignment.entity_id
                where subject_assignment.tenant_id = ${input.actor.tenantId}::uuid
                  and subject_assignment.user_id = ${input.subjectUserId}::uuid
                  and subject_assignment.assignment_role in ('owner', 'collaborator')
                  and observer_assignment.user_id = ${input.actor.userId}::uuid
                  and observer_assignment.assignment_role = 'management_observer'
                  and entity.status = 'active'
                order by entity_name, entity_id
                limit ${this.maxScopedEntities + 1}
              `.execute(transaction);
        assertResultRowLimit(entityResult.rows.length, this.maxScopedEntities);
        const entities = entityResult.rows;
        const entityIds = entities.map((entity) => entity.entity_id);
        const requestHash = managementQueryRequestHash(input, {
          scopeKind: scope.scope_kind,
          entityIds,
        });
        const replay = await beginIdempotentManagementQuery(transaction, {
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          startedAt: input.queryNow,
        });
        if (replay) return replay;
        const queryId = this.queryIdFactory();
        const aggregates = new Map<string, EntityAggregate>(
          entities.map((entity) => [
            entity.entity_id,
            createAggregate(entity.entity_id, entity.entity_name),
          ]),
        );

        if (entityIds.length > 0) {
          const followups = await transaction
            .selectFrom("app.followups")
            .select(["id", "entity_id", "occurred_at", "summary"])
            .where("tenant_id", "=", input.actor.tenantId)
            .where("entity_id", "in", entityIds)
            .where(
              "occurred_at",
              ">=",
              sql<Date>`${input.periodStart}::timestamptz`,
            )
            .where(
              "occurred_at",
              "<",
              sql<Date>`${input.periodEnd}::timestamptz`,
            )
            .where(
              "occurred_at",
              "<=",
              sql<Date>`${input.dataCutoffAt}::timestamptz`,
            )
            .limit(this.maxEventRowsPerKind + 1)
            .execute();
          assertResultRowLimit(followups.length, this.maxEventRowsPerKind);
          for (const row of followups) {
            const aggregate = aggregates.get(row.entity_id);
            if (!aggregate) continue;
            aggregate.confirmedFollowupCount += 1;
            addEvidence(aggregate, {
              kind: "followup",
              evidenceId: row.id,
              occurredAt: toIsoString(row.occurred_at),
              label: evidenceLabel(row.summary),
              deepLink: `/battle-map?entityId=${row.entity_id}`,
            });
          }

          const facts = await transaction
            .selectFrom("app.business_facts")
            .select(["id", "entity_id", "occurred_at", "fact_value"])
            .where("tenant_id", "=", input.actor.tenantId)
            .where("entity_id", "in", entityIds)
            .where("valid_status", "=", "valid")
            .where(
              "occurred_at",
              ">=",
              sql<Date>`${input.periodStart}::timestamptz`,
            )
            .where(
              "occurred_at",
              "<",
              sql<Date>`${input.periodEnd}::timestamptz`,
            )
            .where(
              "occurred_at",
              "<=",
              sql<Date>`${input.dataCutoffAt}::timestamptz`,
            )
            .limit(this.maxEventRowsPerKind + 1)
            .execute();
          assertResultRowLimit(facts.length, this.maxEventRowsPerKind);
          for (const row of facts) {
            const aggregate = aggregates.get(row.entity_id);
            if (!aggregate) continue;
            aggregate.validFactCount += 1;
            addEvidence(aggregate, {
              kind: "fact",
              evidenceId: row.id,
              occurredAt: toIsoString(row.occurred_at),
              label: evidenceLabel(row.fact_value),
              deepLink: `/battle-map?entityId=${row.entity_id}`,
            });
          }

          const stageChanges = await transaction
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
            .where("history.tenant_id", "=", input.actor.tenantId)
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
            .limit(this.maxEventRowsPerKind + 1)
            .execute();
          assertResultRowLimit(stageChanges.length, this.maxEventRowsPerKind);
          for (const row of stageChanges) {
            const aggregate = aggregates.get(row.entity_id);
            if (!aggregate) continue;
            aggregate.stageChangeCount += 1;
            addEvidence(aggregate, {
              kind: "stage_change",
              evidenceId: row.id,
              occurredAt: toIsoString(row.changed_at),
              label: evidenceLabel(
                `${row.from_stage_code ?? "未设置"} → ${row.to_stage_code}`,
              ),
              deepLink: `/battle-map?entityId=${row.entity_id}`,
            });
          }

          const completedActions = await transaction
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
            .where("history.tenant_id", "=", input.actor.tenantId)
            .where("action.entity_id", "in", entityIds)
            .where("action.owner_user_id", "=", input.subjectUserId)
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
            .limit(this.maxEventRowsPerKind + 1)
            .execute();
          assertResultRowLimit(
            completedActions.length,
            this.maxEventRowsPerKind,
          );
          for (const row of completedActions) {
            const aggregate = aggregates.get(row.entity_id);
            if (!aggregate) continue;
            aggregate.completedActionCount += 1;
            addEvidence(aggregate, {
              kind: "action",
              evidenceId: row.id,
              occurredAt: toIsoString(row.changed_at),
              label: evidenceLabel(row.title),
              deepLink: `/actions?actionId=${row.id}`,
            });
          }

          const openActions = await sql<OpenActionRow>`
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
            where action.tenant_id = ${input.actor.tenantId}::uuid
              and action.entity_id in (
                ${sql.join(entityIds.map((id) => sql`${id}::uuid`))}
              )
              and action.owner_user_id = ${input.subjectUserId}::uuid
              and action.confirmed_at < ${input.periodEnd}::timestamptz
              and action.confirmed_at <= ${input.dataCutoffAt}::timestamptz
              and cutoff_status.to_status in ('planned', 'in_progress')
            limit ${this.maxEventRowsPerKind - completedActions.length + 1}
          `.execute(transaction);
          assertResultRowLimit(
            completedActions.length + openActions.rows.length,
            this.maxEventRowsPerKind,
          );
          for (const row of openActions.rows) {
            const aggregate = aggregates.get(row.entity_id);
            if (!aggregate) continue;
            aggregate.openActionCount += 1;
            if (
              new Date(row.planned_at).getTime() <=
              Date.parse(input.dataCutoffAt)
            ) {
              aggregate.overdueActionCount += 1;
            }
            addEvidence(aggregate, {
              kind: "action",
              evidenceId: row.id,
              occurredAt: toIsoString(row.confirmed_at),
              label: evidenceLabel(row.title),
              deepLink: `/actions?actionId=${row.id}`,
            });
          }

          const states = await sql<BattleStateRow>`
            select distinct on (state.entity_id)
              state.id::text as id,
              state.entity_id::text as entity_id,
              state.summary,
              state.effective_at
            from app.battle_state_versions as state
            where state.tenant_id = ${input.actor.tenantId}::uuid
              and state.entity_id in (
                ${sql.join(entityIds.map((id) => sql`${id}::uuid`))}
              )
              and state.effective_at < ${input.periodEnd}::timestamptz
              and state.effective_at <= ${input.dataCutoffAt}::timestamptz
            order by state.entity_id, state.effective_at desc, state.version_no desc
          `.execute(transaction);
          for (const row of states.rows) {
            const aggregate = aggregates.get(row.entity_id);
            if (!aggregate) continue;
            aggregate.hasBattleState = true;
            addEvidence(aggregate, {
              kind: "battle_state",
              evidenceId: row.id,
              occurredAt: toIsoString(row.effective_at),
              label: evidenceLabel(row.summary),
              deepLink: `/battle-map?entityId=${row.entity_id}&stateVersion=${row.id}`,
            });
          }
        }

        const metrics = emptyMetrics();
        const highlights: ManagementQueryHighlight[] = [];
        const dataGaps: ManagementQueryDataGap[] = [];
        for (const aggregate of aggregates.values()) {
          addMetrics(metrics, aggregate);
          aggregate.evidence.sort(compareEvidence);
          aggregate.evidence = aggregate.evidence.slice(0, 20);
          aggregate.latestActivityAt =
            aggregate.evidence[0]?.occurredAt ?? null;
          if (hasActivity(aggregate) || aggregate.hasBattleState) {
            const { hasBattleState: _, ...highlight } = aggregate;
            highlights.push(highlight);
          }
          if (!aggregate.hasBattleState) {
            dataGaps.push({
              entityId: aggregate.entityId,
              entityName: aggregate.entityName,
              code: "missing_battle_state",
              message: "当前没有已发布作战状态，不能据此判断风险高低。",
            });
          }
        }
        highlights.sort((left, right) => {
          const byActivity = (right.latestActivityAt ?? "").localeCompare(
            left.latestActivityAt ?? "",
          );
          return byActivity || left.entityId.localeCompare(right.entityId);
        });
        dataGaps.sort(
          (left, right) =>
            left.entityName.localeCompare(right.entityName) ||
            left.entityId.localeCompare(right.entityId),
        );
        const limitedHighlights = highlights.slice(0, 50);
        const limitedDataGaps = dataGaps.slice(0, 50);

        const result: ManagementQueryResult = {
          queryId,
          capability: "sales_weekly_progress",
          subject: {
            userId: scope.user_id,
            displayName: scope.display_name,
          },
          period: { start: input.periodStart, end: input.periodEnd },
          dataCutoffAt: input.dataCutoffAt,
          scope: { kind: scope.scope_kind, entityCount: entities.length },
          metrics,
          highlights: limitedHighlights,
          dataGaps: limitedDataGaps,
        };

        await transaction
          .insertInto("app.audit_entries")
          .values({
            tenant_id: input.actor.tenantId,
            aggregate_type: "management_query",
            aggregate_id: queryId,
            action: "management_query.executed",
            actor_user_id: input.actor.userId,
            request_id: requestId,
            before_payload: null,
            after_payload: JSON.stringify({
              capability: "sales_weekly_progress",
              subjectUserId: input.subjectUserId,
              periodStart: input.periodStart,
              periodEnd: input.periodEnd,
              dataCutoffAt: input.dataCutoffAt,
              scopeKind: scope.scope_kind,
              entityCount: entities.length,
              metrics,
              highlightCount: limitedHighlights.length,
              dataGapCount: limitedDataGaps.length,
            }),
            reason: null,
            occurred_at: input.queryNow,
          })
          .executeTakeFirstOrThrow();
        await completeIdempotentManagementQuery(transaction, {
          tenantId: input.actor.tenantId,
          idempotencyKey: input.idempotencyKey,
          completedAt: input.queryNow,
          queryId,
          result,
        });
        return result;
      },
    );
  }
}

function createAggregate(
  entityId: string,
  entityName: string,
): EntityAggregate {
  return {
    entityId,
    entityName,
    latestActivityAt: null,
    evidence: [],
    ...emptyMetrics(),
    hasBattleState: false,
  };
}

function emptyMetrics(): ManagementQueryMetrics {
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
  target: ManagementQueryMetrics,
  source: ManagementQueryMetrics,
): void {
  target.confirmedFollowupCount += source.confirmedFollowupCount;
  target.validFactCount += source.validFactCount;
  target.stageChangeCount += source.stageChangeCount;
  target.completedActionCount += source.completedActionCount;
  target.openActionCount += source.openActionCount;
  target.overdueActionCount += source.overdueActionCount;
}

function hasActivity(metrics: ManagementQueryMetrics): boolean {
  return (
    metrics.confirmedFollowupCount > 0 ||
    metrics.validFactCount > 0 ||
    metrics.stageChangeCount > 0 ||
    metrics.completedActionCount > 0 ||
    metrics.openActionCount > 0
  );
}

function addEvidence(
  aggregate: EntityAggregate,
  evidence: ManagementQueryEvidence,
): void {
  if (
    !aggregate.evidence.some(
      (candidate) =>
        candidate.kind === evidence.kind &&
        candidate.evidenceId === evidence.evidenceId,
    )
  ) {
    aggregate.evidence.push(evidence);
  }
}

function compareEvidence(
  left: ManagementQueryEvidence,
  right: ManagementQueryEvidence,
): number {
  return (
    right.occurredAt.localeCompare(left.occurredAt) ||
    left.kind.localeCompare(right.kind) ||
    left.evidenceId.localeCompare(right.evidenceId)
  );
}

async function beginIdempotentManagementQuery(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    requestHash: string;
    startedAt: string;
  },
): Promise<ManagementQueryResult | null> {
  let existing = await readManagementQueryIdempotency(transaction, input);
  if (!existing) {
    const inserted = await transaction
      .insertInto("app.idempotency_records")
      .values({
        tenant_id: input.tenantId,
        id: randomUUID(),
        operation: "management_query.sales_weekly_progress",
        idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash,
        status: "in_progress",
        response_payload: null,
        resource_type: null,
        resource_id: null,
        created_by: input.userId,
        created_at: input.startedAt,
        completed_at: null,
        expires_at: null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["tenant_id", "operation", "idempotency_key"])
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    if (inserted) return null;
    existing = await readManagementQueryIdempotency(transaction, input);
  }
  if (
    !existing ||
    existing.request_hash !== input.requestHash ||
    existing.status !== "completed" ||
    !existing.response_payload
  ) {
    throw new ManagementQueryIdempotencyConflictError();
  }
  return existing.response_payload as unknown as ManagementQueryResult;
}

function readManagementQueryIdempotency(
  transaction: DatabaseTransaction,
  input: { tenantId: string; idempotencyKey: string },
): Promise<IdempotencyRow | undefined> {
  return transaction
    .selectFrom("app.idempotency_records")
    .select(["request_hash", "status", "response_payload"])
    .where("tenant_id", "=", input.tenantId)
    .where("operation", "=", "management_query.sales_weekly_progress")
    .where("idempotency_key", "=", input.idempotencyKey)
    .forUpdate()
    .executeTakeFirst() as Promise<IdempotencyRow | undefined>;
}

async function completeIdempotentManagementQuery(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    idempotencyKey: string;
    completedAt: string;
    queryId: string;
    result: ManagementQueryResult;
  },
): Promise<void> {
  await transaction
    .updateTable("app.idempotency_records")
    .set({
      status: "completed",
      response_payload: jsonObject(input.result),
      resource_type: "management_query",
      resource_id: input.queryId,
      completed_at: input.completedAt,
    })
    .where("tenant_id", "=", input.tenantId)
    .where("operation", "=", "management_query.sales_weekly_progress")
    .where("idempotency_key", "=", input.idempotencyKey)
    .executeTakeFirstOrThrow();
}

function managementQueryRequestHash(
  input: Parameters<ManagementQueryRepository["runSalesWeeklyProgress"]>[0],
  authorization: {
    scopeKind: "self" | "observed_portfolio";
    entityIds: string[];
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorTenantId: input.actor.tenantId,
        actorUserId: input.actor.userId,
        capability: "sales_weekly_progress",
        periodEnd: input.periodEnd,
        periodStart: input.periodStart,
        scopeEntityIds: [...authorization.entityIds].sort(),
        scopeKind: authorization.scopeKind,
        subjectUserId: input.subjectUserId,
      }),
    )
    .digest("hex");
}

function jsonObject(value: object) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::jsonb`;
}

function activeAssignmentsSql(tenantId: string, activeAt: RawBuilder<unknown>) {
  return sql`
    select tenant_id, entity_id, user_id, assignment_role
    from app.entity_assignments
    where tenant_id = ${tenantId}::uuid
      and valid_from <= ${activeAt}
      and (valid_to is null or valid_to > ${activeAt})
  `;
}

function evidenceLabel(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_EVIDENCE_LABEL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_EVIDENCE_LABEL_LENGTH - 1)}…`;
}

function assertResultRowLimit(actual: number, maximum: number): void {
  if (actual > maximum) {
    throw new ManagementQueryResultLimitExceededError();
  }
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "Management-query processing limits must be positive integers.",
    );
  }
  return value;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidManagementQueryCursorError();
  }
}

function encodeCursor(value: SubjectCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): SubjectCursor {
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
    return candidate as unknown as SubjectCursor;
  } catch (error) {
    throw new InvalidManagementQueryCursorError({ cause: error });
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
