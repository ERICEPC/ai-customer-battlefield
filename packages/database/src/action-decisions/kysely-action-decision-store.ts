import { createHash, randomUUID } from "node:crypto";
import {
  type ActionDecisionResult,
  type ActionDecisionStore,
  ActionIdempotencyConflictError,
  ActionOwnerNotFoundError,
  ActionProposalExpiredError,
  ActionProposalNotFoundError,
  ActionProposalNotPendingError,
  ActionProposalVersionConflictError,
  type ActionTransitionResult,
  BusinessActionNotFoundError,
  BusinessActionVersionConflictError,
  InvalidBusinessActionTransitionError,
  isAllowedActionTransition,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed";
  response_payload: unknown;
}

export class KyselyActionDecisionStore implements ActionDecisionStore {
  constructor(private readonly database: Kysely<BattlefieldDatabase>) {}

  async accept(
    input: Parameters<ActionDecisionStore["accept"]>[0],
  ): Promise<ActionDecisionResult> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.proposalId },
      async (transaction) => {
        const requestHash = hashDecisionRequest({
          proposalId: input.proposalId,
          versionNo: input.versionNo,
          title: input.title,
          description: input.description,
          ownerUserId: input.ownerUserId,
          priority: input.priority,
          plannedAt: input.plannedAt,
        });
        const existing = await beginIdempotentDecision(transaction, {
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          operation: "action_proposal.accept",
          idempotencyKey: input.idempotencyKey,
          requestHash,
          startedAt: input.decidedAt,
        });
        if (existing) {
          return decodeDecisionResult(existing, "accepted");
        }

        const proposal = await lockProposal(
          transaction,
          input.actor.tenantId,
          input.proposalId,
        );
        assertPendingProposal(proposal, input.versionNo, input.decidedAt);
        if (Date.parse(input.plannedAt) <= Date.parse(input.decidedAt)) {
          throw new RangeError(
            "A formal action must be planned in the future.",
          );
        }
        const owner = await transaction
          .selectFrom("app.users")
          .select("id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.ownerUserId)
          .where("status", "=", "active")
          .forUpdate()
          .executeTakeFirst();
        if (!owner) {
          throw new ActionOwnerNotFoundError();
        }
        if (proposal.opportunity_id) {
          const opportunity = await transaction
            .selectFrom("app.opportunities")
            .select("id")
            .where("tenant_id", "=", input.actor.tenantId)
            .where("id", "=", proposal.opportunity_id)
            .where("entity_id", "=", proposal.entity_id)
            .forUpdate()
            .executeTakeFirst();
          if (!opportunity) {
            throw new ActionProposalNotFoundError();
          }
        }

        const nextVersion = String(BigInt(proposal.version_no) + 1n);
        await transaction
          .updateTable("app.action_proposals")
          .set({
            status: "accepted",
            decided_at: input.decidedAt,
            decided_by: input.actor.userId,
            decision_reason: null,
            version_no: nextVersion,
            updated_at: input.decidedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.proposalId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.business_actions")
          .values({
            tenant_id: input.actor.tenantId,
            id: input.actionId,
            entity_id: proposal.entity_id,
            opportunity_id: proposal.opportunity_id,
            title: input.title,
            description: input.description,
            owner_user_id: input.ownerUserId,
            priority: input.priority,
            status: "planned",
            planned_at: input.plannedAt,
            completed_at: null,
            source_proposal_id: input.proposalId,
            confirmed_by: input.actor.userId,
            confirmed_at: input.decidedAt,
            version_no: 1,
            created_at: input.decidedAt,
            updated_at: input.decidedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.action_status_history")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            action_id: input.actionId,
            from_status: null,
            to_status: "planned",
            changed_by: input.actor.userId,
            reason: "Accepted AI action proposal.",
            changed_at: input.decidedAt,
            version_no: 1,
          })
          .executeTakeFirstOrThrow();

        const result: ActionDecisionResult = {
          proposalId: input.proposalId,
          status: "accepted",
          actionId: input.actionId,
          versionNo: nextVersion,
          decidedAt: input.decidedAt,
        };
        await insertAudit(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "business_action",
          aggregateId: input.actionId,
          action: "created_from_proposal",
          occurredAt: input.decidedAt,
          afterPayload: result,
          reason: null,
        });
        const eventId = randomUUID();
        await insertEvent(transaction, {
          tenantId: input.actor.tenantId,
          eventId,
          aggregateType: "action_proposal",
          aggregateId: input.proposalId,
          eventType: "action_proposal.accepted.v1",
          eventVersion: nextVersion,
          payload: result,
          occurredAt: input.decidedAt,
        });
        await completeIdempotentDecision(transaction, {
          tenantId: input.actor.tenantId,
          operation: "action_proposal.accept",
          idempotencyKey: input.idempotencyKey,
          completedAt: input.decidedAt,
          resourceType: "business_action",
          resourceId: input.actionId,
          response: result,
        });
        await insertOutbox(transaction, {
          tenantId: input.actor.tenantId,
          eventId,
          topic: "action_proposal.accepted.v1",
          dedupeKey: `action_proposal.accepted:${input.proposalId}`,
          payload: result,
          availableAt: input.decidedAt,
        });
        return result;
      },
    );
  }

  async reject(
    input: Parameters<ActionDecisionStore["reject"]>[0],
  ): Promise<ActionDecisionResult> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.proposalId },
      async (transaction) => {
        const requestHash = hashDecisionRequest({
          proposalId: input.proposalId,
          versionNo: input.versionNo,
          reason: input.reason,
        });
        const existing = await beginIdempotentDecision(transaction, {
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          operation: "action_proposal.reject",
          idempotencyKey: input.idempotencyKey,
          requestHash,
          startedAt: input.decidedAt,
        });
        if (existing) {
          return decodeDecisionResult(existing, "rejected");
        }

        const proposal = await lockProposal(
          transaction,
          input.actor.tenantId,
          input.proposalId,
        );
        assertPendingProposal(proposal, input.versionNo, input.decidedAt);
        const nextVersion = String(BigInt(proposal.version_no) + 1n);
        await transaction
          .updateTable("app.action_proposals")
          .set({
            status: "rejected",
            decided_at: input.decidedAt,
            decided_by: input.actor.userId,
            decision_reason: input.reason,
            version_no: nextVersion,
            updated_at: input.decidedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.proposalId)
          .executeTakeFirstOrThrow();

        const result: ActionDecisionResult = {
          proposalId: input.proposalId,
          status: "rejected",
          actionId: null,
          versionNo: nextVersion,
          decidedAt: input.decidedAt,
        };
        await insertAudit(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "action_proposal",
          aggregateId: input.proposalId,
          action: "rejected",
          occurredAt: input.decidedAt,
          afterPayload: result,
          reason: input.reason,
        });
        const eventId = randomUUID();
        await insertEvent(transaction, {
          tenantId: input.actor.tenantId,
          eventId,
          aggregateType: "action_proposal",
          aggregateId: input.proposalId,
          eventType: "action_proposal.rejected.v1",
          eventVersion: nextVersion,
          payload: { ...result, reason: input.reason },
          occurredAt: input.decidedAt,
        });
        await completeIdempotentDecision(transaction, {
          tenantId: input.actor.tenantId,
          operation: "action_proposal.reject",
          idempotencyKey: input.idempotencyKey,
          completedAt: input.decidedAt,
          resourceType: "action_proposal",
          resourceId: input.proposalId,
          response: result,
        });
        await insertOutbox(transaction, {
          tenantId: input.actor.tenantId,
          eventId,
          topic: "action_proposal.rejected.v1",
          dedupeKey: `action_proposal.rejected:${input.proposalId}`,
          payload: { ...result, reason: input.reason },
          availableAt: input.decidedAt,
        });
        return result;
      },
    );
  }

  async transition(
    input: Parameters<ActionDecisionStore["transition"]>[0],
  ): Promise<ActionTransitionResult> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: input.actionId },
      async (transaction) => {
        const action = await transaction
          .selectFrom("app.business_actions")
          .select(["id", "status", "version_no"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.actionId)
          .forUpdate()
          .executeTakeFirst();
        if (!action) {
          throw new BusinessActionNotFoundError();
        }
        const currentVersion = String(action.version_no);
        if (currentVersion !== input.versionNo) {
          throw new BusinessActionVersionConflictError(currentVersion);
        }
        if (!isAllowedActionTransition(action.status, input.toStatus)) {
          throw new InvalidBusinessActionTransitionError(
            action.status,
            input.toStatus,
          );
        }

        const nextVersion = String(BigInt(action.version_no) + 1n);
        await transaction
          .updateTable("app.business_actions")
          .set({
            status: input.toStatus,
            completed_at:
              input.toStatus === "completed" ? input.changedAt : null,
            version_no: nextVersion,
            updated_at: input.changedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.actionId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.action_status_history")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            action_id: input.actionId,
            from_status: action.status,
            to_status: input.toStatus,
            changed_by: input.actor.userId,
            reason: input.reason ?? null,
            changed_at: input.changedAt,
            version_no: nextVersion,
          })
          .executeTakeFirstOrThrow();

        const result: ActionTransitionResult = {
          actionId: input.actionId,
          status: input.toStatus,
          versionNo: nextVersion,
          changedAt: input.changedAt,
        };
        await insertAudit(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "business_action",
          aggregateId: input.actionId,
          action: "status_changed",
          occurredAt: input.changedAt,
          afterPayload: result,
          reason: input.reason ?? null,
        });
        const eventId = randomUUID();
        await insertEvent(transaction, {
          tenantId: input.actor.tenantId,
          eventId,
          aggregateType: "business_action",
          aggregateId: input.actionId,
          eventType: "business_action.status_changed.v1",
          eventVersion: nextVersion,
          payload: { ...result, fromStatus: action.status },
          occurredAt: input.changedAt,
        });
        await insertOutbox(transaction, {
          tenantId: input.actor.tenantId,
          eventId,
          topic: "business_action.status_changed.v1",
          dedupeKey: `business_action.status_changed:${input.actionId}:${nextVersion}`,
          payload: { ...result, fromStatus: action.status },
          availableAt: input.changedAt,
        });
        return result;
      },
    );
  }
}

async function lockProposal(
  transaction: DatabaseTransaction,
  tenantId: string,
  proposalId: string,
) {
  const row = await transaction
    .selectFrom("app.action_proposals")
    .select([
      "id",
      "entity_id",
      "opportunity_id",
      "status",
      "version_no",
      "expires_at",
    ])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", proposalId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) {
    throw new ActionProposalNotFoundError();
  }
  return row;
}

function assertPendingProposal(
  proposal: Awaited<ReturnType<typeof lockProposal>>,
  versionNo: string,
  decidedAt: string,
): void {
  if (proposal.status !== "pending_confirmation") {
    throw new ActionProposalNotPendingError(proposal.status);
  }
  const currentVersion = String(proposal.version_no);
  if (currentVersion !== versionNo) {
    throw new ActionProposalVersionConflictError(currentVersion);
  }
  if (Date.parse(decidedAt) >= new Date(proposal.expires_at).getTime()) {
    throw new ActionProposalExpiredError();
  }
}

async function beginIdempotentDecision(
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
    if (inserted) {
      return null;
    }
    existing = await readIdempotencyRecord(transaction, input);
  }
  if (!existing || existing.request_hash !== input.requestHash) {
    throw new ActionIdempotencyConflictError();
  }
  if (existing.status !== "completed" || !existing.response_payload) {
    throw new ActionIdempotencyConflictError();
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

async function completeIdempotentDecision(
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

async function insertAudit(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    actorUserId: string;
    aggregateType: string;
    aggregateId: string;
    action: string;
    occurredAt: string;
    afterPayload: object;
    reason: string | null;
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
      reason: input.reason,
      occurred_at: input.occurredAt,
    })
    .executeTakeFirstOrThrow();
}

async function insertEvent(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    eventId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    eventVersion: string;
    payload: object;
    occurredAt: string;
  },
): Promise<void> {
  await transaction
    .insertInto("app.domain_events")
    .values({
      tenant_id: input.tenantId,
      id: input.eventId,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      event_version: input.eventVersion,
      payload: jsonObject(input.payload),
      occurred_at: input.occurredAt,
    })
    .executeTakeFirstOrThrow();
}

async function insertOutbox(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string;
    eventId: string;
    topic: string;
    dedupeKey: string;
    payload: object;
    availableAt: string;
  },
): Promise<void> {
  await transaction
    .insertInto("app.outbox_messages")
    .values({
      tenant_id: input.tenantId,
      id: randomUUID(),
      event_id: input.eventId,
      topic: input.topic,
      payload: jsonObject(input.payload),
      status: "pending",
      dedupe_key: input.dedupeKey,
      available_at: input.availableAt,
      attempt_count: 0,
      last_error: null,
      claimed_at: null,
      published_at: null,
      created_at: input.availableAt,
    })
    .executeTakeFirstOrThrow();
}

function decodeDecisionResult(
  value: unknown,
  expectedStatus: "accepted" | "rejected",
): ActionDecisionResult {
  const decoded = decodeJsonObject(value);
  if (
    decoded.status !== expectedStatus ||
    typeof decoded.proposalId !== "string" ||
    typeof decoded.versionNo !== "string" ||
    typeof decoded.decidedAt !== "string" ||
    (expectedStatus === "accepted" && typeof decoded.actionId !== "string") ||
    (expectedStatus === "rejected" && decoded.actionId !== null)
  ) {
    throw new ActionIdempotencyConflictError();
  }
  return decoded as ActionDecisionResult;
}

function decodeJsonObject(value: unknown): Record<string, unknown> {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ActionIdempotencyConflictError();
  }
  return decoded as Record<string, unknown>;
}

function hashDecisionRequest(value: Record<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ),
    )
    .digest("hex");
}

function jsonObject<T extends object>(value: T) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::jsonb`;
}
