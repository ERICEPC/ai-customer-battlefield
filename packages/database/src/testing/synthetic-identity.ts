import { hashPassword } from "@battlefield/core";

import type { DatabaseHandle } from "../database-handle.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";
import {
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
} from "./synthetic-directory.js";
import { SYNTHETIC_MANAGER_USER_ID } from "./synthetic-reminders.js";

export const SYNTHETIC_DEPARTMENT_ID = "31000000-0000-4000-8000-000000000001";
export const SYNTHETIC_SALES_EMAIL = "sales1@demo.local";
export const SYNTHETIC_LEADER_EMAIL = "leader.a@demo.local";
export const SYNTHETIC_DEMO_PASSWORD = "Demo@2026";

const REQUEST_ID = "90000000-0000-4000-8000-000000000083";
const SALES_MEMBERSHIP_ID = "32000000-0000-4000-8000-000000000001";
const LEADER_MEMBERSHIP_ID = "32000000-0000-4000-8000-000000000002";
const SEEDED_AT = "2026-08-31T00:00:00.000Z";

export async function seedSyntheticTwoLevelIdentity(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  const passwordHash = await hashPassword(SYNTHETIC_DEMO_PASSWORD, {
    salt: Buffer.alloc(16, 11),
  });
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: REQUEST_ID,
    },
    async (transaction) => {
      await transaction
        .insertInto("app.org_units")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: SYNTHETIC_DEPARTMENT_ID,
          parent_id: null,
          code: "commercial-one",
          name: "商业化一部",
          unit_type: "department",
          status: "active",
          created_at: SEEDED_AT,
          updated_at: SEEDED_AT,
        })
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "id"]).doUpdateSet({
            name: "商业化一部",
            status: "active",
            updated_at: SEEDED_AT,
          }),
        )
        .executeTakeFirst();
      await transaction
        .updateTable("app.users")
        .set({
          display_name: "销售1",
          email: SYNTHETIC_SALES_EMAIL,
          status: "active",
          updated_at: SEEDED_AT,
        })
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("id", "=", SYNTHETIC_USER_ID)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("app.users")
        .set({
          display_name: "领导A",
          email: SYNTHETIC_LEADER_EMAIL,
          status: "active",
          updated_at: SEEDED_AT,
        })
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("id", "=", SYNTHETIC_MANAGER_USER_ID)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.user_memberships")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: SALES_MEMBERSHIP_ID,
            user_id: SYNTHETIC_USER_ID,
            org_unit_id: SYNTHETIC_DEPARTMENT_ID,
            role_code: "sales",
            valid_from: SEEDED_AT,
            valid_to: null,
            created_at: SEEDED_AT,
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            id: LEADER_MEMBERSHIP_ID,
            user_id: SYNTHETIC_MANAGER_USER_ID,
            org_unit_id: SYNTHETIC_DEPARTMENT_ID,
            role_code: "department_leader",
            valid_from: SEEDED_AT,
            valid_to: null,
            created_at: SEEDED_AT,
          },
        ])
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "id"]).doNothing(),
        )
        .execute();
      await transaction
        .insertInto("app.user_credentials")
        .values([
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            user_id: SYNTHETIC_USER_ID,
            password_hash: passwordHash,
            password_updated_at: SEEDED_AT,
            failed_attempt_count: 0,
            locked_until: null,
            created_at: SEEDED_AT,
            updated_at: SEEDED_AT,
          },
          {
            tenant_id: SYNTHETIC_TENANT_ID,
            user_id: SYNTHETIC_MANAGER_USER_ID,
            password_hash: passwordHash,
            password_updated_at: SEEDED_AT,
            failed_attempt_count: 0,
            locked_until: null,
            created_at: SEEDED_AT,
            updated_at: SEEDED_AT,
          },
        ])
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "user_id"]).doUpdateSet({
            password_hash: passwordHash,
            password_updated_at: SEEDED_AT,
            failed_attempt_count: 0,
            locked_until: null,
            updated_at: SEEDED_AT,
          }),
        )
        .execute();
    },
  );
}
