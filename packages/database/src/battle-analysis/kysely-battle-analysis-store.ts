import { createHash, randomUUID } from "node:crypto";
import {
  BattleAnalysisNotFoundError,
  type BattleAnalysisResult,
  BattleAnalysisStaleError,
  type BattleAnalysisStore,
  type ConfirmedFactSnapshot,
  type ConfirmedFactSnapshotReader,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface AnalysisRunRow {
  id: string;
  entity_id: string;
  input_version: string;
  status: "running" | "completed" | "failed" | "superseded";
  started_at: Date | string;
}

export interface KyselyBattleAnalysisStoreOptions {
  proposalLifetimeMs?: number;
  idGenerator?: () => string;
}

const DEFAULT_PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export class KyselyConfirmedFactSnapshotReader
  implements ConfirmedFactSnapshotReader
{
  constructor(private readonly database: Kysely<BattlefieldDatabase>) {}

  async read(
    input: Parameters<ConfirmedFactSnapshotReader["read"]>[0],
  ): Promise<ConfirmedFactSnapshot> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.entityId },
      (transaction) =>
        readConfirmedFactSnapshot(
          transaction,
          input.actor.tenantId,
          input.entityId,
        ),
    );
  }
}

export class KyselyBattleAnalysisStore implements BattleAnalysisStore {
  private readonly proposalLifetimeMs: number;
  private readonly idGenerator: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyBattleAnalysisStoreOptions = {},
  ) {
    this.proposalLifetimeMs =
      options.proposalLifetimeMs ?? DEFAULT_PROPOSAL_LIFETIME_MS;
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  async findByTriggerEvent(
    input: Parameters<BattleAnalysisStore["findByTriggerEvent"]>[0],
  ): Promise<BattleAnalysisResult | null> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.triggerEventId },
      async (transaction) => {
        const run = await transaction
          .selectFrom("app.analysis_runs")
          .select([
            "id",
            "entity_id",
            "input_version",
            "status",
            "started_at",
            "finished_at",
          ])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("trigger_event_id", "=", input.triggerEventId)
          .where("entity_id", "=", input.entityId)
          .where("status", "in", ["completed", "superseded"])
          .orderBy("finished_at", "desc")
          .executeTakeFirst();
        if (!run?.finished_at) return null;
        if (run.status === "superseded") {
          return {
            analysisRunId: run.id,
            entityId: run.entity_id,
            status: "superseded",
            inputVersion: run.input_version,
            battleStateVersionId: null,
            battleStateVersionNo: null,
            proposalIds: [],
            startedAt: toIsoString(run.started_at),
            finishedAt: toIsoString(run.finished_at),
          };
        }
        const state = await transaction
          .selectFrom("app.battle_state_versions")
          .select(["id", "version_no"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("analysis_run_id", "=", run.id)
          .executeTakeFirstOrThrow();
        const proposals = await transaction
          .selectFrom("app.action_proposals")
          .select("id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("source_battle_state_version_id", "=", state.id)
          .orderBy("id")
          .execute();
        return {
          analysisRunId: run.id,
          entityId: run.entity_id,
          status: "completed",
          inputVersion: run.input_version,
          battleStateVersionId: state.id,
          battleStateVersionNo: String(state.version_no),
          proposalIds: proposals.map((proposal) => proposal.id),
          startedAt: toIsoString(run.started_at),
          finishedAt: toIsoString(run.finished_at),
        };
      },
    );
  }

  async start(
    input: Parameters<BattleAnalysisStore["start"]>[0],
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.analysisRunId },
      async (transaction) => {
        const entity = await transaction
          .selectFrom("app.business_entities")
          .select("id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.entityId)
          .executeTakeFirst();
        if (!entity) {
          throw new BattleAnalysisNotFoundError();
        }
        await transaction
          .insertInto("app.analysis_runs")
          .values({
            tenant_id: input.actor.tenantId,
            id: input.analysisRunId,
            entity_id: input.entityId,
            trigger_event_id: input.triggerEventId ?? null,
            rule_version: input.ruleVersion,
            analyzer_config_version: input.analyzerConfigVersion,
            input_version: input.inputVersion,
            status: "running",
            error_code: null,
            error_message: null,
            started_at: input.startedAt,
            finished_at: null,
            created_by: input.actor.userId,
            created_at: input.startedAt,
          })
          .executeTakeFirstOrThrow();
      },
    );
  }

  async complete(
    input: Parameters<BattleAnalysisStore["complete"]>[0],
  ): Promise<BattleAnalysisResult> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.analysisRunId },
      async (transaction) => {
        const run = await lockAnalysisRun(
          transaction,
          input.actor.tenantId,
          input.analysisRunId,
        );
        if (run.status !== "running") {
          throw new BattleAnalysisNotFoundError();
        }
        if (run.input_version !== input.inputVersion) {
          throw new BattleAnalysisStaleError(run.input_version);
        }

        await lockEntity(transaction, input.actor.tenantId, run.entity_id);
        const latestSnapshot = await readConfirmedFactSnapshot(
          transaction,
          input.actor.tenantId,
          run.entity_id,
        );
        if (latestSnapshot.inputVersion !== run.input_version) {
          await transaction
            .updateTable("app.analysis_runs")
            .set({ status: "superseded", finished_at: input.finishedAt })
            .where("tenant_id", "=", input.actor.tenantId)
            .where("id", "=", input.analysisRunId)
            .executeTakeFirstOrThrow();
          return {
            analysisRunId: run.id,
            entityId: run.entity_id,
            status: "superseded",
            inputVersion: run.input_version,
            battleStateVersionId: null,
            battleStateVersionNo: null,
            proposalIds: [],
            startedAt: toIsoString(run.started_at),
            finishedAt: input.finishedAt,
          };
        }

        const evidenceFacts = new Set(input.candidate.evidenceFactIds);
        const currentFacts = new Set(
          latestSnapshot.facts.map((fact) => fact.factId),
        );
        if ([...evidenceFacts].some((factId) => !currentFacts.has(factId))) {
          throw new BattleAnalysisStaleError(latestSnapshot.inputVersion);
        }

        const versionNo = await nextBattleStateVersion(
          transaction,
          input.actor.tenantId,
          run.entity_id,
        );
        const stateId = this.idGenerator();
        const signalRows = input.candidate.signals.map((signal) => ({
          id: this.idGenerator(),
          signal,
        }));

        await transaction
          .updateTable("app.analysis_runs")
          .set({ status: "completed", finished_at: input.finishedAt })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.analysisRunId)
          .executeTakeFirstOrThrow();
        if (signalRows.length > 0) {
          await transaction
            .insertInto("app.business_signals")
            .values(
              signalRows.map(({ id, signal }) => ({
                tenant_id: input.actor.tenantId,
                id,
                entity_id: run.entity_id,
                fact_id: signal.factId,
                analysis_run_id: run.id,
                dimension: signal.dimension,
                direction: signal.direction,
                strength: signal.strength,
                reason: signal.reason,
                created_at: input.finishedAt,
              })),
            )
            .execute();
        }
        await transaction
          .insertInto("app.battle_state_versions")
          .values({
            tenant_id: input.actor.tenantId,
            id: stateId,
            entity_id: run.entity_id,
            version_no: versionNo,
            input_version: run.input_version,
            relationship_score: input.candidate.relationshipScore,
            potential_score: input.candidate.potentialScore,
            quadrant_code: input.candidate.quadrantCode,
            primary_opportunity_id: input.candidate.primaryOpportunityId,
            risk_level: input.candidate.riskLevel,
            data_sufficiency: input.candidate.dataSufficiency,
            data_gaps: jsonStringArray(input.candidate.dataGaps),
            summary: input.candidate.summary,
            analysis_run_id: run.id,
            effective_at: input.finishedAt,
            created_at: input.finishedAt,
          })
          .executeTakeFirstOrThrow();

        const evidenceRows = [
          ...input.candidate.evidenceFactIds.map((factId) => ({
            tenant_id: input.actor.tenantId,
            id: this.idGenerator(),
            entity_id: run.entity_id,
            battle_state_version_id: stateId,
            fact_id: factId,
            signal_id: null,
            contribution: "confirmed_fact",
            created_at: input.finishedAt,
          })),
          ...signalRows.map(({ id, signal }) => ({
            tenant_id: input.actor.tenantId,
            id: this.idGenerator(),
            entity_id: run.entity_id,
            battle_state_version_id: stateId,
            fact_id: null,
            signal_id: id,
            contribution: signal.reason,
            created_at: input.finishedAt,
          })),
        ];
        if (evidenceRows.length > 0) {
          await transaction
            .insertInto("app.battle_state_evidence_links")
            .values(evidenceRows)
            .execute();
        }

        await transaction
          .insertInto("app.battle_state_current")
          .values({
            tenant_id: input.actor.tenantId,
            entity_id: run.entity_id,
            battle_state_version_id: stateId,
            version_no: versionNo,
            input_version: run.input_version,
            updated_at: input.finishedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "entity_id"]).doUpdateSet({
              battle_state_version_id: stateId,
              version_no: versionNo,
              input_version: run.input_version,
              updated_at: input.finishedAt,
            }),
          )
          .executeTakeFirstOrThrow();

        const proposalIds = input.candidate.actionProposals.map(() =>
          this.idGenerator(),
        );
        if (proposalIds.length > 0) {
          const expiresAt = new Date(
            Date.parse(input.finishedAt) + this.proposalLifetimeMs,
          ).toISOString();
          await transaction
            .insertInto("app.action_proposals")
            .values(
              input.candidate.actionProposals.map((proposal, index) => ({
                tenant_id: input.actor.tenantId,
                id: proposalIds[index] ?? this.idGenerator(),
                entity_id: run.entity_id,
                opportunity_id: input.candidate.primaryOpportunityId,
                title: proposal.title,
                description: proposal.description,
                suggested_owner_id: proposal.suggestedOwnerId,
                suggested_priority: proposal.suggestedPriority,
                suggested_planned_at: proposal.suggestedPlannedAt,
                source_battle_state_version_id: stateId,
                status: "pending_confirmation",
                version_no: 1,
                proposed_at: input.finishedAt,
                expires_at: expiresAt,
                decided_at: null,
                decided_by: null,
                decision_reason: null,
                created_at: input.finishedAt,
                updated_at: input.finishedAt,
              })),
            )
            .execute();
        }

        return {
          analysisRunId: run.id,
          entityId: run.entity_id,
          status: "completed",
          inputVersion: run.input_version,
          battleStateVersionId: stateId,
          battleStateVersionNo: String(versionNo),
          proposalIds,
          startedAt: toIsoString(run.started_at),
          finishedAt: input.finishedAt,
        };
      },
    );
  }

  async fail(input: Parameters<BattleAnalysisStore["fail"]>[0]): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.analysisRunId },
      async (transaction) => {
        const run = await lockAnalysisRun(
          transaction,
          input.actor.tenantId,
          input.analysisRunId,
        );
        if (run.status !== "running") {
          throw new BattleAnalysisNotFoundError();
        }
        await transaction
          .updateTable("app.analysis_runs")
          .set({
            status: "failed",
            error_code: input.errorCode,
            error_message:
              input.errorCode === "ANALYZER_FAILED"
                ? "Analyzer execution failed."
                : "Analyzer output failed validation.",
            finished_at: input.finishedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.analysisRunId)
          .executeTakeFirstOrThrow();
      },
    );
  }
}

async function readConfirmedFactSnapshot(
  transaction: DatabaseTransaction,
  tenantId: string,
  entityId: string,
): Promise<ConfirmedFactSnapshot> {
  const entity = await transaction
    .selectFrom("app.business_entities")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", entityId)
    .executeTakeFirst();
  if (!entity) {
    throw new BattleAnalysisNotFoundError();
  }
  const rows = await transaction
    .selectFrom("app.business_facts")
    .select(["id", "fact_type", "fact_value", "occurred_at", "opportunity_id"])
    .where("tenant_id", "=", tenantId)
    .where("entity_id", "=", entityId)
    .where("valid_status", "=", "valid")
    .orderBy("occurred_at")
    .orderBy("id")
    .execute();
  const facts = rows.map((row) => ({
    factId: row.id,
    factType: row.fact_type,
    factValue: row.fact_value,
    occurredAt: toIsoString(row.occurred_at),
    opportunityId: row.opportunity_id,
  }));
  return {
    entityId,
    inputVersion: sha256(JSON.stringify(facts)),
    facts,
  };
}

async function lockAnalysisRun(
  transaction: DatabaseTransaction,
  tenantId: string,
  analysisRunId: string,
): Promise<AnalysisRunRow> {
  const row = await transaction
    .selectFrom("app.analysis_runs")
    .select(["id", "entity_id", "input_version", "status", "started_at"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", analysisRunId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) {
    throw new BattleAnalysisNotFoundError();
  }
  return row;
}

async function lockEntity(
  transaction: DatabaseTransaction,
  tenantId: string,
  entityId: string,
): Promise<void> {
  const row = await transaction
    .selectFrom("app.business_entities")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", entityId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) {
    throw new BattleAnalysisNotFoundError();
  }
}

async function nextBattleStateVersion(
  transaction: DatabaseTransaction,
  tenantId: string,
  entityId: string,
): Promise<string> {
  const result = await transaction
    .selectFrom("app.battle_state_versions")
    .select((expression) =>
      expression.fn.max("version_no").as("maximum_version"),
    )
    .where("tenant_id", "=", tenantId)
    .where("entity_id", "=", entityId)
    .executeTakeFirstOrThrow();
  return String(BigInt(result.maximum_version ?? 0) + 1n);
}

function jsonStringArray(value: string[]) {
  return sql<string[]>`${JSON.stringify(value)}::jsonb`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
