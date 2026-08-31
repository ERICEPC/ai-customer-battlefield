import type { ManagementCapability } from "@battlefield/core";
import { sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";

export async function actorHasManagementCapability(
  transaction: Transaction<BattlefieldDatabase>,
  actor: { tenantId: string; userId: string },
  capability: ManagementCapability,
): Promise<boolean> {
  const match = await transaction
    .selectFrom("app.user_memberships as membership")
    .innerJoin("app.role_capability_grants as capability_grant", (join) =>
      join
        .onRef("capability_grant.tenant_id", "=", "membership.tenant_id")
        .onRef("capability_grant.role_code", "=", "membership.role_code"),
    )
    .select("membership.id")
    .where("membership.tenant_id", "=", actor.tenantId)
    .where("membership.user_id", "=", actor.userId)
    .where("membership.valid_from", "<=", sql<Date>`current_timestamp`)
    .where((expression) =>
      expression.or([
        expression("membership.valid_to", "is", null),
        expression("membership.valid_to", ">", sql<Date>`current_timestamp`),
      ]),
    )
    .where("capability_grant.capability_code", "=", capability)
    .executeTakeFirst();
  return match !== undefined;
}
