import { randomUUID } from "node:crypto";

import { createPostgresDatabase } from "../database-factory.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const SALES_USER_ID = "30000000-0000-4000-8000-000000000001";
const LEADER_USER_ID = "30000000-0000-4000-8000-000000000072";
const DEPARTMENT_ID = "31000000-0000-4000-8000-000000000001";
const ENTITY_ID = "50000000-0000-4000-8000-000000000001";
const FALLBACK_OPPORTUNITY_ID = "51000000-0000-4000-8000-000000000001";
const SALES_MEMBERSHIP_ID = "32000000-0000-4000-8000-000000000001";
const LEADER_MEMBERSHIP_ID = "32000000-0000-4000-8000-000000000002";
const OWNER_ASSIGNMENT_ID = "61000000-0000-4000-8000-000000000001";
const LEADER_ASSIGNMENT_ID = "61000000-0000-4000-8000-000000000072";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed the V1 scenario.");
}

const database = createPostgresDatabase<BattlefieldDatabase>(databaseUrl, {
  applicationName: "ai-customer-battlefield-v1-seed",
  maxConnections: 2,
});

try {
  const result = await withTenantTransaction(
    database.db,
    {
      tenantId: TENANT_ID,
      userId: SALES_USER_ID,
      requestId: randomUUID(),
    },
    async (transaction) => {
      await transaction
        .updateTable("app.tenants")
        .set({ name: "商汤企业 AI 商业化团队", updated_at: new Date() })
        .where("id", "=", TENANT_ID)
        .returning("id")
        .executeTakeFirstOrThrow();

      await transaction
        .updateTable("app.users")
        .set({
          display_name: "销售1",
          status: "active",
          updated_at: new Date(),
        })
        .where("tenant_id", "=", TENANT_ID)
        .where("id", "=", SALES_USER_ID)
        .returning("id")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("app.users")
        .set({
          display_name: "领导A",
          status: "active",
          updated_at: new Date(),
        })
        .where("tenant_id", "=", TENANT_ID)
        .where("id", "=", LEADER_USER_ID)
        .returning("id")
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto("app.org_units")
        .values({
          tenant_id: TENANT_ID,
          id: DEPARTMENT_ID,
          parent_id: null,
          code: "commercial-one",
          name: "商业化一部",
          unit_type: "department",
          status: "active",
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "id"]).doUpdateSet({
            name: "商业化一部",
            status: "active",
            updated_at: new Date(),
          }),
        )
        .executeTakeFirst();

      for (const membership of [
        {
          id: SALES_MEMBERSHIP_ID,
          userId: SALES_USER_ID,
          roleCode: "sales",
        },
        {
          id: LEADER_MEMBERSHIP_ID,
          userId: LEADER_USER_ID,
          roleCode: "department_leader",
        },
      ]) {
        const active = await transaction
          .selectFrom("app.user_memberships")
          .select("id")
          .where("tenant_id", "=", TENANT_ID)
          .where("user_id", "=", membership.userId)
          .where("org_unit_id", "=", DEPARTMENT_ID)
          .where("role_code", "=", membership.roleCode)
          .where("valid_to", "is", null)
          .executeTakeFirst();
        if (!active) {
          await transaction
            .insertInto("app.user_memberships")
            .values({
              tenant_id: TENANT_ID,
              id: membership.id,
              user_id: membership.userId,
              org_unit_id: DEPARTMENT_ID,
              role_code: membership.roleCode,
              valid_from: new Date(),
              valid_to: null,
              created_at: new Date(),
            })
            .executeTakeFirstOrThrow();
        }
      }

      await transaction
        .updateTable("app.business_entities")
        .set({
          name: "云岭新能源汽车股份有限公司",
          short_name: "云岭汽车",
          status: "active",
          is_t0: true,
          updated_at: new Date(),
        })
        .where("tenant_id", "=", TENANT_ID)
        .where("id", "=", ENTITY_ID)
        .returning("id")
        .executeTakeFirstOrThrow();

      for (const assignment of [
        {
          id: OWNER_ASSIGNMENT_ID,
          userId: SALES_USER_ID,
          role: "owner" as const,
          isPrimary: true,
        },
        {
          id: LEADER_ASSIGNMENT_ID,
          userId: LEADER_USER_ID,
          role: "management_observer" as const,
          isPrimary: false,
        },
      ]) {
        const active = await transaction
          .selectFrom("app.entity_assignments")
          .select("id")
          .where("tenant_id", "=", TENANT_ID)
          .where("entity_id", "=", ENTITY_ID)
          .where("user_id", "=", assignment.userId)
          .where("assignment_role", "=", assignment.role)
          .where("valid_to", "is", null)
          .executeTakeFirst();
        if (!active) {
          await transaction
            .insertInto("app.entity_assignments")
            .values({
              tenant_id: TENANT_ID,
              id: assignment.id,
              entity_id: ENTITY_ID,
              user_id: assignment.userId,
              assignment_role: assignment.role,
              is_primary: assignment.isPrimary,
              valid_from: new Date(),
              valid_to: null,
              created_at: new Date(),
            })
            .executeTakeFirstOrThrow();
        }
      }

      const existingOpportunity = await transaction
        .selectFrom("app.opportunities")
        .select("id")
        .where("tenant_id", "=", TENANT_ID)
        .where("entity_id", "=", ENTITY_ID)
        .where("status", "=", "open")
        .where("is_primary", "=", true)
        .executeTakeFirst();
      const opportunityId = existingOpportunity?.id ?? FALLBACK_OPPORTUNITY_ID;

      if (existingOpportunity) {
        await transaction
          .updateTable("app.opportunities")
          .set({
            name: "智能座舱语音交互平台一期",
            need_summary:
              "在新车型量产前完成车载语音交互平台验证，覆盖多音区、弱网与方言场景。",
            estimated_amount: 3_800_000,
            currency: "CNY",
            stage_code: "solution_validation",
            stage_progress: 45,
            expected_close_at: "2026-11-30",
            updated_at: new Date(),
          })
          .where("tenant_id", "=", TENANT_ID)
          .where("id", "=", opportunityId)
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .insertInto("app.opportunities")
          .values({
            tenant_id: TENANT_ID,
            id: opportunityId,
            entity_id: ENTITY_ID,
            name: "智能座舱语音交互平台一期",
            need_summary:
              "在新车型量产前完成车载语音交互平台验证，覆盖多音区、弱网与方言场景。",
            estimated_amount: 3_800_000,
            currency: "CNY",
            stage_code: "solution_validation",
            stage_progress: 45,
            status: "open",
            is_primary: true,
            expected_close_at: "2026-11-30",
            version_no: 1,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .executeTakeFirstOrThrow();
      }

      return { opportunityId };
    },
  );

  console.info(
    `V1 scenario is ready for entity ${ENTITY_ID} and opportunity ${result.opportunityId}.`,
  );
} finally {
  await database.close();
}
