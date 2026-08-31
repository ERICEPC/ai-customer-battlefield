import { sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";

export type EntityAccessScope =
  | "owner"
  | "collaborator"
  | "management_observer";

export async function resolveEntityAccessScope(
  transaction: Transaction<BattlefieldDatabase>,
  input: {
    tenantId: string;
    userId: string;
    entityId: string;
    at: string;
  },
): Promise<EntityAccessScope | null> {
  const row = await transaction
    .selectFrom("app.entity_assignments")
    .select("assignment_role")
    .where("tenant_id", "=", input.tenantId)
    .where("entity_id", "=", input.entityId)
    .where("user_id", "=", input.userId)
    .where("valid_from", "<=", sql<Date>`${input.at}::timestamptz`)
    .where((expression) =>
      expression.or([
        expression("valid_to", "is", null),
        expression("valid_to", ">", sql<Date>`${input.at}::timestamptz`),
      ]),
    )
    .orderBy((expression) =>
      expression
        .case()
        .when("assignment_role", "=", "owner")
        .then(0)
        .when("assignment_role", "=", "collaborator")
        .then(1)
        .else(2)
        .end(),
    )
    .limit(1)
    .executeTakeFirst();

  return row?.assignment_role ?? null;
}
