import { type RawBuilder, sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";

export type EntityAccessScope =
  | "owner"
  | "collaborator"
  | "management_observer";

export function entityAccessExistsSql(input: {
  tenantId: string;
  userId: string;
  entityId: RawBuilder<unknown>;
  at?: RawBuilder<unknown>;
  allowedScopes?: readonly EntityAccessScope[];
}): RawBuilder<boolean> {
  const activeAt = input.at ?? sql`current_timestamp`;
  const scopeFilter = input.allowedScopes
    ? sql`and visible_assignment.assignment_role in (${sql.join(
        input.allowedScopes.map((scope) => sql`${scope}`),
      )})`
    : sql``;

  return sql<boolean>`
    exists (
      select 1
      from app.entity_assignments as visible_assignment
      where visible_assignment.tenant_id = ${input.tenantId}::uuid
        and visible_assignment.entity_id = ${input.entityId}
        and visible_assignment.user_id = ${input.userId}::uuid
        and visible_assignment.valid_from <= ${activeAt}
        and (
          visible_assignment.valid_to is null
          or visible_assignment.valid_to > ${activeAt}
        )
        ${scopeFilter}
    )
  `;
}

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
