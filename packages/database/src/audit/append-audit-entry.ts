import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";

export async function appendAuditEntry(
  transaction: Transaction<BattlefieldDatabase>,
  input: {
    tenantId: string;
    actorUserId: string;
    aggregateType: string;
    aggregateId: string;
    action: string;
    occurredAt: string;
    requestId?: string | null;
    beforePayload?: object | null;
    afterPayload?: object | null;
    reason?: string | null;
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
      request_id:
        input.requestId === undefined
          ? sql<
              string | null
            >`nullif(current_setting('app.request_id', true), '')`
          : input.requestId,
      before_payload: input.beforePayload
        ? jsonObject(input.beforePayload)
        : null,
      after_payload: input.afterPayload ? jsonObject(input.afterPayload) : null,
      reason: input.reason ?? null,
      occurred_at: input.occurredAt,
    })
    .executeTakeFirstOrThrow();
}

function jsonObject(value: object) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::jsonb`;
}
