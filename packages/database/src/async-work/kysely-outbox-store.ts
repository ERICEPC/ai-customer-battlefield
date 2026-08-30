import { randomUUID } from "node:crypto";
import type { OutboxMessage, OutboxStore } from "@battlefield/core";
import { type Kysely, sql, type UpdateObject } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

export class OutboxClaimLostError extends Error {
  constructor() {
    super("The Outbox claim is no longer active.");
    this.name = "OutboxClaimLostError";
  }
}

export class KyselyOutboxStore implements OutboxStore {
  constructor(private readonly database: Kysely<BattlefieldDatabase>) {}

  async claimBatch(
    input: Parameters<OutboxStore["claimBatch"]>[0],
  ): Promise<OutboxMessage[]> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const candidates = await transaction
          .selectFrom("app.outbox_messages")
          .select("id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("status", "in", ["pending", "failed"])
          .where("available_at", "<=", new Date(input.now))
          .orderBy("available_at", "asc")
          .orderBy("id", "asc")
          .limit(input.limit)
          .forUpdate()
          .skipLocked()
          .execute();

        const claimed: OutboxMessage[] = [];
        for (const candidate of candidates) {
          const claimToken = randomUUID();
          const row = await transaction
            .updateTable("app.outbox_messages")
            .set({
              status: "processing",
              claim_token: claimToken,
              claimed_at: input.now,
              attempt_count: sql`attempt_count + 1`,
              last_error_code: null,
              last_error: null,
            })
            .where("tenant_id", "=", input.actor.tenantId)
            .where("id", "=", candidate.id)
            .where("status", "in", ["pending", "failed"])
            .returning(["id", "topic", "payload", "attempt_count"])
            .executeTakeFirstOrThrow();
          const event = await transaction
            .selectFrom("app.domain_events")
            .innerJoin("app.outbox_messages as message", (join) =>
              join
                .onRef("message.tenant_id", "=", "app.domain_events.tenant_id")
                .onRef("message.event_id", "=", "app.domain_events.id"),
            )
            .select([
              "app.domain_events.aggregate_type",
              "app.domain_events.aggregate_id",
              "app.domain_events.occurred_at",
            ])
            .where("message.tenant_id", "=", input.actor.tenantId)
            .where("message.id", "=", candidate.id)
            .executeTakeFirstOrThrow();
          claimed.push({
            messageId: row.id,
            topic: row.topic,
            aggregateType: event.aggregate_type,
            aggregateId: event.aggregate_id,
            payload: decodeJson(row.payload),
            occurredAt: toIso(event.occurred_at),
            attemptCount: row.attempt_count,
            claimToken,
          });
        }
        return claimed;
      },
    );
  }

  async markPublished(
    input: Parameters<OutboxStore["markPublished"]>[0],
  ): Promise<void> {
    await this.completeClaim(input, {
      status: "published",
      published_at: sql`now()`,
      claim_token: null,
      claimed_at: null,
      last_error_code: null,
      last_error: null,
    });
  }

  async reschedule(
    input: Parameters<OutboxStore["reschedule"]>[0],
  ): Promise<void> {
    await this.completeClaim(input, {
      status: "failed",
      available_at: input.availableAt,
      claim_token: null,
      claimed_at: null,
      last_error_code: input.errorCode,
      last_error: input.errorMessage,
      published_at: null,
    });
  }

  async deadLetter(
    input: Parameters<OutboxStore["deadLetter"]>[0],
  ): Promise<void> {
    await this.completeClaim(input, {
      status: "dead_lettered",
      claim_token: null,
      claimed_at: null,
      last_error_code: input.errorCode,
      last_error: input.errorMessage,
      published_at: null,
    });
  }

  async recoverExpiredClaims(input: {
    actor: { tenantId: string; userId: string };
    expiredBefore: string;
    availableAt: string;
  }): Promise<{ recovered: number }> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const result = await transaction
          .updateTable("app.outbox_messages")
          .set({
            status: "failed",
            available_at: input.availableAt,
            claim_token: null,
            claimed_at: null,
            last_error_code: "OUTBOX_LEASE_EXPIRED",
            last_error: "Outbox processing lease expired.",
            published_at: null,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("status", "=", "processing")
          .where("claimed_at", "<=", new Date(input.expiredBefore))
          .executeTakeFirst();
        return { recovered: Number(result.numUpdatedRows) };
      },
    );
  }

  private async completeClaim(
    input: {
      actor: { tenantId: string; userId: string };
      messageId: string;
      claimToken: string;
    },
    values: UpdateObject<
      BattlefieldDatabase,
      "app.outbox_messages",
      "app.outbox_messages"
    >,
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const result = await transaction
          .updateTable("app.outbox_messages")
          .set(values)
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.messageId)
          .where("status", "=", "processing")
          .where("claim_token", "=", input.claimToken)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw new OutboxClaimLostError();
        }
      },
    );
  }
}

function decodeJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
