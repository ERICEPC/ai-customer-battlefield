import { createHash, randomUUID } from "node:crypto";
import {
  type FollowupAgentExecutionReceipt,
  type FollowupConfirmationResult,
  type FollowupConfirmationStore,
  FollowupDraftExpiredError,
  FollowupDraftNotFoundError,
  FollowupDraftNotPendingError,
  FollowupDraftVersionConflictError,
  FollowupIdempotencyConflictError,
  FollowupNotFoundError,
  FollowupRelatedRecordNotFoundError,
  InvalidFollowupDraftCandidateError,
  type PersistentFollowupDraft,
  type PersistentFollowupDraftCandidate,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface DraftRow {
  draft_id: string;
  status: PersistentFollowupDraft["status"];
  raw_input: string;
  candidate_payload: unknown;
  version_no: string | bigint | number;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
  confirmed_at: Date | string | null;
  confirmed_by: string | null;
  cancelled_at: Date | string | null;
  followup_id: string | null;
}

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed";
  response_payload: unknown;
}

export class KyselyFollowupConfirmationStore
  implements FollowupConfirmationStore
{
  constructor(private readonly database: Kysely<BattlefieldDatabase>) {}

  async create(
    input: Parameters<FollowupConfirmationStore["create"]>[0],
  ): Promise<PersistentFollowupDraft> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.draftId },
      async (transaction) => {
        await validateCandidateReferences(
          transaction,
          input.actor.tenantId,
          input.candidate,
        );
        const sourceInputId = randomUUID();
        await transaction
          .insertInto("app.source_inputs")
          .values({
            tenant_id: input.actor.tenantId,
            id: sourceInputId,
            source_type: "web",
            submitted_by: input.actor.userId,
            raw_content: input.rawInput,
            content_hash: sha256(input.rawInput),
            received_at: input.createdAt,
            created_at: input.createdAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.followup_drafts")
          .values({
            tenant_id: input.actor.tenantId,
            id: input.draftId,
            source_input_id: sourceInputId,
            entity_id: input.candidate.entityId,
            status: "pending_confirmation",
            candidate_payload: jsonObject(
              encodeDraftPayload(input.candidate, input.agentExecution),
            ),
            created_by: input.actor.userId,
            expires_at: input.expiresAt,
            created_at: input.createdAt,
            updated_at: input.createdAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.draft_revisions")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            draft_id: input.draftId,
            revision_no: 1,
            candidate_payload: jsonObject(
              encodeDraftPayload(input.candidate, input.agentExecution),
            ),
            changed_by: input.actor.userId,
            changed_at: input.createdAt,
          })
          .executeTakeFirstOrThrow();

        return loadDraft(transaction, input.actor.tenantId, input.draftId);
      },
    );
  }

  async get(
    input: Parameters<FollowupConfirmationStore["get"]>[0],
  ): Promise<PersistentFollowupDraft> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.draftId },
      (transaction) =>
        loadDraft(transaction, input.actor.tenantId, input.draftId),
    );
  }

  async getFollowup(
    input: Parameters<FollowupConfirmationStore["getFollowup"]>[0],
  ) {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.followupId },
      async (transaction) => {
        const followup = await transaction
          .selectFrom("app.followups")
          .select([
            "id",
            "source_draft_id",
            "entity_id",
            "occurred_at",
            "followup_type",
            "summary",
            "submitted_by",
            "confirmed_by",
            "confirmed_at",
          ])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.followupId)
          .executeTakeFirst();
        if (!followup) {
          throw new FollowupNotFoundError();
        }
        const opportunities = await transaction
          .selectFrom("app.followup_opportunities")
          .select(["opportunity_id", "is_primary"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("followup_id", "=", input.followupId)
          .orderBy("is_primary", "desc")
          .orderBy("opportunity_id")
          .execute();
        const facts = await transaction
          .selectFrom("app.business_facts")
          .select(["fact_type", "fact_value", "opportunity_id"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("followup_id", "=", input.followupId)
          .orderBy("created_at")
          .orderBy("id")
          .execute();

        return {
          followupId: followup.id,
          sourceDraftId: followup.source_draft_id,
          entityId: followup.entity_id,
          occurredAt: toIsoString(followup.occurred_at),
          followupType: followup.followup_type,
          summary: followup.summary,
          submittedBy: followup.submitted_by,
          confirmedBy: followup.confirmed_by,
          confirmedAt: toIsoString(followup.confirmed_at),
          relatedOpportunityIds: opportunities.map(
            (opportunity) => opportunity.opportunity_id,
          ),
          primaryOpportunityId:
            opportunities.find((opportunity) => opportunity.is_primary)
              ?.opportunity_id ?? null,
          facts: facts.map((fact) => ({
            factType: fact.fact_type,
            factValue: fact.fact_value,
            opportunityId: fact.opportunity_id,
          })),
        };
      },
    );
  }

  async revise(
    input: Parameters<FollowupConfirmationStore["revise"]>[0],
  ): Promise<PersistentFollowupDraft> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.draftId },
      async (transaction) => {
        const draft = await lockDraft(
          transaction,
          input.actor.tenantId,
          input.draftId,
        );
        assertPendingDraft(draft, input.versionNo, input.changedAt);
        await validateCandidateReferences(
          transaction,
          input.actor.tenantId,
          input.candidate,
        );
        const nextVersion = Number(draft.version_no) + 1;
        const agentExecution = decodeAgentExecution(draft.candidate_payload);
        const nextPayload = encodeDraftPayload(input.candidate, agentExecution);
        await transaction
          .updateTable("app.followup_drafts")
          .set({
            entity_id: input.candidate.entityId,
            candidate_payload: jsonObject(nextPayload),
            version_no: nextVersion,
            updated_at: input.changedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.draftId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.draft_revisions")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            draft_id: input.draftId,
            revision_no: nextVersion,
            candidate_payload: jsonObject(nextPayload),
            changed_by: input.actor.userId,
            changed_at: input.changedAt,
          })
          .executeTakeFirstOrThrow();

        return loadDraft(transaction, input.actor.tenantId, input.draftId);
      },
    );
  }

  async cancel(
    input: Parameters<FollowupConfirmationStore["cancel"]>[0],
  ): Promise<PersistentFollowupDraft> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.draftId },
      async (transaction) => {
        const draft = await lockDraft(
          transaction,
          input.actor.tenantId,
          input.draftId,
        );
        const requestHash = sha256(
          stableJson({
            draftId: input.draftId,
            versionNo: input.versionNo,
          }),
        );
        const existing = await beginIdempotentOperation(transaction, {
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          operation: "followup.cancel",
          idempotencyKey: input.idempotencyKey,
          requestHash,
          startedAt: input.cancelledAt,
        });
        if (existing) {
          return decodePersistentDraft(existing);
        }
        assertPendingDraft(draft, input.versionNo, input.cancelledAt);
        const nextVersion = String(Number(draft.version_no) + 1);
        await transaction
          .updateTable("app.followup_drafts")
          .set({
            status: "cancelled",
            cancelled_at: input.cancelledAt,
            version_no: nextVersion,
            updated_at: input.cancelledAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.draftId)
          .executeTakeFirstOrThrow();
        const cancelled = await loadDraft(
          transaction,
          input.actor.tenantId,
          input.draftId,
        );
        await insertAuditEntry(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "followup_draft",
          aggregateId: input.draftId,
          action: "cancelled",
          occurredAt: input.cancelledAt,
          afterPayload: {
            draftId: input.draftId,
            status: "cancelled",
            versionNo: nextVersion,
          },
        });
        await completeIdempotentOperation(transaction, {
          tenantId: input.actor.tenantId,
          operation: "followup.cancel",
          idempotencyKey: input.idempotencyKey,
          completedAt: input.cancelledAt,
          resourceType: "followup_draft",
          resourceId: input.draftId,
          response: cancelled,
        });
        return cancelled;
      },
    );
  }

  async confirm(
    input: Parameters<FollowupConfirmationStore["confirm"]>[0],
  ): Promise<FollowupConfirmationResult> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.draftId },
      async (transaction) => {
        const draft = await lockDraft(
          transaction,
          input.actor.tenantId,
          input.draftId,
        );
        const requestHash = sha256(
          stableJson({
            draftId: input.draftId,
            versionNo: input.versionNo,
          }),
        );
        const existing = await beginIdempotentOperation(transaction, {
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          operation: "followup.confirm",
          idempotencyKey: input.idempotencyKey,
          requestHash,
          startedAt: input.confirmedAt,
        });
        if (existing) {
          return decodeConfirmationResult(existing);
        }
        assertPendingDraft(draft, input.versionNo, input.confirmedAt);
        const candidate = decodeCandidate(draft.candidate_payload);
        await lockAndValidateCandidateReferences(
          transaction,
          input.actor.tenantId,
          candidate,
        );

        const source = await transaction
          .selectFrom("app.source_inputs")
          .innerJoin("app.followup_drafts", (join) =>
            join
              .onRef(
                "app.followup_drafts.tenant_id",
                "=",
                "app.source_inputs.tenant_id",
              )
              .onRef(
                "app.followup_drafts.source_input_id",
                "=",
                "app.source_inputs.id",
              ),
          )
          .select([
            "app.source_inputs.id as source_input_id",
            "app.source_inputs.raw_content",
            "app.source_inputs.content_hash",
          ])
          .where("app.followup_drafts.tenant_id", "=", input.actor.tenantId)
          .where("app.followup_drafts.id", "=", input.draftId)
          .executeTakeFirstOrThrow();
        const followupId = randomUUID();
        const eventId = randomUUID();
        const nextVersion = String(Number(draft.version_no) + 1);

        await transaction
          .insertInto("app.followups")
          .values({
            tenant_id: input.actor.tenantId,
            id: followupId,
            entity_id: candidate.entityId,
            source_input_id: source.source_input_id,
            source_draft_id: input.draftId,
            occurred_at: candidate.occurredAt,
            followup_type: candidate.followupType,
            summary: candidate.summary,
            submitted_by: input.actor.userId,
            confirmed_by: input.actor.userId,
            confirmed_at: input.confirmedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.followup_participants")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            followup_id: followupId,
            user_id: input.actor.userId,
            contact_id: null,
            participant_role: "sales_owner",
          })
          .executeTakeFirstOrThrow();
        if (candidate.relatedOpportunityIds.length > 0) {
          await transaction
            .insertInto("app.followup_opportunities")
            .values(
              candidate.relatedOpportunityIds.map((opportunityId) => ({
                tenant_id: input.actor.tenantId,
                followup_id: followupId,
                opportunity_id: opportunityId,
                is_primary: opportunityId === candidate.primaryOpportunityId,
              })),
            )
            .execute();
        }

        const evidenceId = randomUUID();
        await transaction
          .insertInto("app.source_evidence")
          .values({
            tenant_id: input.actor.tenantId,
            id: evidenceId,
            source_input_id: source.source_input_id,
            source_type: "web",
            excerpt: source.raw_content.slice(0, 500),
            content_hash: source.content_hash,
            sensitivity: "internal",
            captured_at: input.confirmedAt,
          })
          .executeTakeFirstOrThrow();
        for (const fact of candidate.facts) {
          const factId = randomUUID();
          await transaction
            .insertInto("app.business_facts")
            .values({
              tenant_id: input.actor.tenantId,
              id: factId,
              entity_id: candidate.entityId,
              opportunity_id: candidate.primaryOpportunityId,
              followup_id: followupId,
              fact_type: fact.factType,
              fact_value: fact.factValue,
              occurred_at: candidate.occurredAt,
              confirmed_at: input.confirmedAt,
              confirmed_by: input.actor.userId,
              supersedes_fact_id: null,
            })
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("app.fact_evidence_links")
            .values({
              tenant_id: input.actor.tenantId,
              fact_id: factId,
              evidence_id: evidenceId,
              relation_type: "supports",
            })
            .executeTakeFirstOrThrow();
        }

        await transaction
          .updateTable("app.followup_drafts")
          .set({
            status: "confirmed",
            confirmed_at: input.confirmedAt,
            confirmed_by: input.actor.userId,
            version_no: nextVersion,
            updated_at: input.confirmedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.draftId)
          .executeTakeFirstOrThrow();
        await insertAuditEntry(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "followup",
          aggregateId: followupId,
          action: "confirmed",
          occurredAt: input.confirmedAt,
          afterPayload: {
            followupId,
            draftId: input.draftId,
            entityId: candidate.entityId,
            versionNo: "1",
          },
        });
        const eventPayload = {
          followupId,
          draftId: input.draftId,
          entityId: candidate.entityId,
          versionNo: "1",
        };
        await transaction
          .insertInto("app.domain_events")
          .values({
            tenant_id: input.actor.tenantId,
            id: eventId,
            aggregate_type: "followup",
            aggregate_id: followupId,
            event_type: "followup.confirmed.v1",
            event_version: 1,
            payload: jsonObject(eventPayload),
            occurred_at: input.confirmedAt,
          })
          .executeTakeFirstOrThrow();
        const result: FollowupConfirmationResult = {
          draftId: input.draftId,
          status: "confirmed",
          followupId,
          eventId,
          versionNo: nextVersion,
          confirmedAt: input.confirmedAt,
        };
        await completeIdempotentOperation(transaction, {
          tenantId: input.actor.tenantId,
          operation: "followup.confirm",
          idempotencyKey: input.idempotencyKey,
          completedAt: input.confirmedAt,
          resourceType: "followup",
          resourceId: followupId,
          response: result,
        });
        await transaction
          .insertInto("app.outbox_messages")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            event_id: eventId,
            topic: "followup.confirmed.v1",
            payload: jsonObject(eventPayload),
            status: "pending",
            dedupe_key: `followup.confirmed:${input.draftId}`,
            available_at: input.confirmedAt,
          })
          .executeTakeFirstOrThrow();

        return result;
      },
    );
  }
}

async function loadDraft(
  transaction: DatabaseTransaction,
  tenantId: string,
  draftId: string,
): Promise<PersistentFollowupDraft> {
  const row = await transaction
    .selectFrom("app.followup_drafts as draft")
    .innerJoin("app.source_inputs as source", (join) =>
      join
        .onRef("source.tenant_id", "=", "draft.tenant_id")
        .onRef("source.id", "=", "draft.source_input_id"),
    )
    .leftJoin("app.followups as followup", (join) =>
      join
        .onRef("followup.tenant_id", "=", "draft.tenant_id")
        .onRef("followup.source_draft_id", "=", "draft.id"),
    )
    .select([
      "draft.id as draft_id",
      "draft.status",
      "source.raw_content as raw_input",
      "draft.candidate_payload",
      "draft.version_no",
      "draft.created_at",
      "draft.updated_at",
      "draft.expires_at",
      "draft.confirmed_at",
      "draft.confirmed_by",
      "draft.cancelled_at",
      "followup.id as followup_id",
    ])
    .where("draft.tenant_id", "=", tenantId)
    .where("draft.id", "=", draftId)
    .executeTakeFirst();
  if (!row) {
    throw new FollowupDraftNotFoundError();
  }
  return mapDraft(row as DraftRow);
}

async function lockDraft(
  transaction: DatabaseTransaction,
  tenantId: string,
  draftId: string,
) {
  const row = await transaction
    .selectFrom("app.followup_drafts")
    .select(["id", "status", "candidate_payload", "version_no", "expires_at"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", draftId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) {
    throw new FollowupDraftNotFoundError();
  }
  return row;
}

function assertPendingDraft(
  draft: Awaited<ReturnType<typeof lockDraft>>,
  versionNo: string,
  actionAt: string,
): void {
  if (draft.status !== "pending_confirmation") {
    throw new FollowupDraftNotPendingError(draft.status);
  }
  const currentVersion = String(draft.version_no);
  if (currentVersion !== versionNo) {
    throw new FollowupDraftVersionConflictError(currentVersion);
  }
  if (new Date(actionAt).getTime() >= new Date(draft.expires_at).getTime()) {
    throw new FollowupDraftExpiredError();
  }
}

async function validateCandidateReferences(
  transaction: DatabaseTransaction,
  tenantId: string,
  candidate: PersistentFollowupDraftCandidate,
): Promise<void> {
  assertCandidateShape(candidate);
  const entity = await transaction
    .selectFrom("app.business_entities")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", candidate.entityId)
    .executeTakeFirst();
  if (!entity) {
    throw new FollowupRelatedRecordNotFoundError("entity");
  }
  if (candidate.relatedOpportunityIds.length === 0) {
    return;
  }
  const opportunities = await transaction
    .selectFrom("app.opportunities")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("entity_id", "=", candidate.entityId)
    .where("id", "in", candidate.relatedOpportunityIds)
    .execute();
  if (opportunities.length !== candidate.relatedOpportunityIds.length) {
    throw new FollowupRelatedRecordNotFoundError("opportunity");
  }
}

async function lockAndValidateCandidateReferences(
  transaction: DatabaseTransaction,
  tenantId: string,
  candidate: PersistentFollowupDraftCandidate,
): Promise<void> {
  assertCandidateShape(candidate);
  const entity = await transaction
    .selectFrom("app.business_entities")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", candidate.entityId)
    .forUpdate()
    .executeTakeFirst();
  if (!entity) {
    throw new FollowupRelatedRecordNotFoundError("entity");
  }
  if (candidate.relatedOpportunityIds.length === 0) {
    return;
  }
  const opportunities = await transaction
    .selectFrom("app.opportunities")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("entity_id", "=", candidate.entityId)
    .where("id", "in", [...candidate.relatedOpportunityIds].sort())
    .orderBy("id")
    .forUpdate()
    .execute();
  if (opportunities.length !== candidate.relatedOpportunityIds.length) {
    throw new FollowupRelatedRecordNotFoundError("opportunity");
  }
}

function assertCandidateShape(
  candidate: PersistentFollowupDraftCandidate,
): void {
  if (
    candidate.relatedOpportunityIds.length !==
      new Set(candidate.relatedOpportunityIds).size ||
    (candidate.primaryOpportunityId !== null &&
      !candidate.relatedOpportunityIds.includes(
        candidate.primaryOpportunityId,
      )) ||
    (candidate.relatedOpportunityIds.length > 1 &&
      !candidate.primaryOpportunityId)
  ) {
    throw new InvalidFollowupDraftCandidateError();
  }
}

async function beginIdempotentOperation(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    userId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    startedAt: string;
  },
): Promise<unknown | null> {
  let existing = await readIdempotencyRecord(transaction, input);
  if (!existing) {
    const inserted = await transaction
      .insertInto("app.idempotency_records")
      .values({
        tenant_id: input.tenantId,
        id: randomUUID(),
        operation: input.operation,
        idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash,
        status: "in_progress",
        created_by: input.userId,
        created_at: input.startedAt,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["tenant_id", "operation", "idempotency_key"])
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    if (inserted) {
      return null;
    }
    existing = await readIdempotencyRecord(transaction, input);
  }
  if (!existing || existing.request_hash !== input.requestHash) {
    throw new FollowupIdempotencyConflictError();
  }
  if (existing.status !== "completed" || !existing.response_payload) {
    throw new FollowupIdempotencyConflictError();
  }
  return existing.response_payload;
}

async function readIdempotencyRecord(
  transaction: DatabaseTransaction,
  input: { tenantId: string; operation: string; idempotencyKey: string },
): Promise<IdempotencyRow | undefined> {
  return transaction
    .selectFrom("app.idempotency_records")
    .select(["request_hash", "status", "response_payload"])
    .where("tenant_id", "=", input.tenantId)
    .where("operation", "=", input.operation)
    .where("idempotency_key", "=", input.idempotencyKey)
    .forUpdate()
    .executeTakeFirst() as Promise<IdempotencyRow | undefined>;
}

async function completeIdempotentOperation(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    operation: string;
    idempotencyKey: string;
    completedAt: string;
    resourceType: string;
    resourceId: string;
    response: object;
  },
): Promise<void> {
  await transaction
    .updateTable("app.idempotency_records")
    .set({
      status: "completed",
      response_payload: jsonObject(input.response),
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      completed_at: input.completedAt,
    })
    .where("tenant_id", "=", input.tenantId)
    .where("operation", "=", input.operation)
    .where("idempotency_key", "=", input.idempotencyKey)
    .executeTakeFirstOrThrow();
}

async function insertAuditEntry(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    actorUserId: string;
    aggregateType: string;
    aggregateId: string;
    action: string;
    occurredAt: string;
    afterPayload: object;
  },
): Promise<void> {
  await transaction
    .insertInto("app.audit_entries")
    .values({
      tenant_id: input.tenantId,
      id: randomUUID(),
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      action: input.action,
      actor_user_id: input.actorUserId,
      request_id: null,
      before_payload: null,
      after_payload: jsonObject(input.afterPayload),
      reason: null,
      occurred_at: input.occurredAt,
    })
    .executeTakeFirstOrThrow();
}

function mapDraft(row: DraftRow): PersistentFollowupDraft {
  const agentExecution = decodeAgentExecution(row.candidate_payload);
  return {
    draftId: row.draft_id,
    status: row.status,
    rawInput: row.raw_input,
    candidate: decodeCandidate(row.candidate_payload),
    versionNo: String(row.version_no),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    expiresAt: toIsoString(row.expires_at),
    confirmedAt: toNullableIsoString(row.confirmed_at),
    confirmedBy: row.confirmed_by,
    cancelledAt: toNullableIsoString(row.cancelled_at),
    followupId: row.followup_id,
    ...(agentExecution ? { agentExecution } : {}),
  };
}

function encodeDraftPayload(
  candidate: PersistentFollowupDraftCandidate,
  agentExecution?: FollowupAgentExecutionReceipt,
): PersistentFollowupDraftCandidate & {
  agentExecution?: FollowupAgentExecutionReceipt;
} {
  return {
    ...candidate,
    ...(agentExecution ? { agentExecution } : {}),
  };
}

function decodeAgentExecution(
  value: unknown,
): FollowupAgentExecutionReceipt | undefined {
  const payload = decodeJsonObject(value);
  if (payload.agentExecution === undefined) return undefined;
  const execution = payload.agentExecution;
  if (
    !(execution && typeof execution === "object" && !Array.isArray(execution))
  ) {
    throw new InvalidFollowupDraftCandidateError();
  }
  const candidate = execution as Partial<FollowupAgentExecutionReceipt>;
  const usage = candidate.usage;
  if (
    typeof candidate.provider !== "string" ||
    !/^[a-z][a-z0-9_-]{0,99}$/.test(candidate.provider) ||
    typeof candidate.model !== "string" ||
    candidate.model.length === 0 ||
    candidate.model.length > 200 ||
    typeof candidate.promptVersion !== "string" ||
    candidate.promptVersion.length === 0 ||
    candidate.promptVersion.length > 200 ||
    candidate.status !== "succeeded" ||
    !(
      candidate.providerRequestId === null ||
      (typeof candidate.providerRequestId === "string" &&
        candidate.providerRequestId.length > 0 &&
        candidate.providerRequestId.length <= 500)
    ) ||
    !isBoundedInteger(candidate.durationMs, 0, 600_000) ||
    !(
      usage === null ||
      (usage &&
        isBoundedInteger(usage.inputTokens, 0, Number.MAX_SAFE_INTEGER) &&
        isBoundedInteger(usage.outputTokens, 0, Number.MAX_SAFE_INTEGER) &&
        isBoundedInteger(usage.totalTokens, 0, Number.MAX_SAFE_INTEGER))
    )
  ) {
    throw new InvalidFollowupDraftCandidateError();
  }
  return candidate as FollowupAgentExecutionReceipt;
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function decodeCandidate(value: unknown): PersistentFollowupDraftCandidate {
  const candidate = decodeJsonObject(
    value,
  ) as Partial<PersistentFollowupDraftCandidate>;
  if (
    typeof candidate.entityId !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.occurredAt !== "string" ||
    !["meeting", "call", "message", "email", "other"].includes(
      candidate.followupType ?? "",
    ) ||
    !Array.isArray(candidate.relatedOpportunityIds) ||
    !(
      candidate.primaryOpportunityId === null ||
      typeof candidate.primaryOpportunityId === "string"
    ) ||
    !Array.isArray(candidate.facts)
  ) {
    throw new InvalidFollowupDraftCandidateError();
  }
  const decoded: PersistentFollowupDraftCandidate = {
    entityId: candidate.entityId,
    summary: candidate.summary,
    occurredAt: candidate.occurredAt,
    followupType:
      candidate.followupType as PersistentFollowupDraftCandidate["followupType"],
    relatedOpportunityIds: candidate.relatedOpportunityIds as string[],
    primaryOpportunityId: candidate.primaryOpportunityId,
    facts: candidate.facts as PersistentFollowupDraftCandidate["facts"],
  };
  assertCandidateShape(decoded);
  return decoded;
}

function decodePersistentDraft(value: unknown): PersistentFollowupDraft {
  const draft = decodeJsonObject(value) as Partial<PersistentFollowupDraft>;
  if (
    typeof draft.draftId !== "string" ||
    typeof draft.rawInput !== "string" ||
    typeof draft.versionNo !== "string" ||
    typeof draft.createdAt !== "string" ||
    typeof draft.updatedAt !== "string" ||
    typeof draft.expiresAt !== "string" ||
    !draft.candidate ||
    !["pending_confirmation", "confirmed", "cancelled", "expired"].includes(
      draft.status ?? "",
    )
  ) {
    throw new FollowupIdempotencyConflictError();
  }
  return draft as PersistentFollowupDraft;
}

function decodeConfirmationResult(value: unknown): FollowupConfirmationResult {
  const result = decodeJsonObject(value) as Partial<FollowupConfirmationResult>;
  if (
    result.status !== "confirmed" ||
    typeof result.draftId !== "string" ||
    typeof result.followupId !== "string" ||
    typeof result.eventId !== "string" ||
    typeof result.versionNo !== "string" ||
    typeof result.confirmedAt !== "string"
  ) {
    throw new FollowupIdempotencyConflictError();
  }
  return result as FollowupConfirmationResult;
}

function decodeJsonObject(value: unknown): Record<string, unknown> {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new FollowupIdempotencyConflictError();
  }
  return decoded as Record<string, unknown>;
}

function jsonObject<T extends object>(value: T) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::jsonb`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function toIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toNullableIsoString(value: Date | string | null): string | null {
  return value === null ? null : toIsoString(value);
}
