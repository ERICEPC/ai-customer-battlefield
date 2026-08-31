import type { DatabaseHandle } from "../database-handle.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";
import {
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
} from "./synthetic-directory.js";

const REQUEST_ID = "90000000-0000-4000-8000-000000000071";
const SYNTHETIC_ACTION_ID = "d0000000-0000-4000-8000-000000000071";
const SYNTHETIC_POLICY_ID = "71000000-0000-4000-8000-000000000071";
export const SYNTHETIC_MANAGER_USER_ID = "30000000-0000-4000-8000-000000000072";

export async function seedSyntheticManagementObserver(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: REQUEST_ID,
    },
    async (transaction) => {
      await transaction
        .insertInto("app.users")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: SYNTHETIC_MANAGER_USER_ID,
          display_name: "demo-manager",
          email: null,
          mobile: null,
          status: "active",
        })
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "id"]).doNothing(),
        )
        .executeTakeFirst();
      await transaction
        .insertInto("app.entity_assignments")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: "61000000-0000-4000-8000-000000000072",
          entity_id: "50000000-0000-4000-8000-000000000001",
          user_id: SYNTHETIC_MANAGER_USER_ID,
          assignment_role: "management_observer",
          is_primary: false,
          valid_from: "2026-08-31T00:00:00.000Z",
          valid_to: null,
        })
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "id"]).doNothing(),
        )
        .executeTakeFirst();
    },
  );
}

export async function seedSyntheticReminderConfiguration(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: REQUEST_ID,
    },
    async (transaction) => {
      await transaction
        .insertInto("app.reminder_policy_versions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: "71000000-0000-4000-8000-000000000071",
          policy_key: "default_action_due",
          version_no: 1,
          name: "默认动作到期提醒",
          status: "published",
          // Serialize JSONB explicitly so both PGlite and node-postgres use the
          // same wire representation. node-postgres otherwise encodes a plain
          // JavaScript array as a PostgreSQL array literal, which JSONB rejects.
          nodes: JSON.stringify([
            {
              kind: "due",
              offsetMinutes: 0,
              recipient: "owner",
              channels: ["in_app", "feishu"],
            },
          ]),
          effective_at: "2026-08-31T00:00:00.000Z",
          published_by: SYNTHETIC_USER_ID,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["tenant_id", "policy_key", "version_no"])
            .doNothing(),
        )
        .executeTakeFirst();
      await transaction
        .insertInto("app.notification_template_versions")
        .values(
          (["in_app", "feishu"] as const).map((channel) => ({
            tenant_id: SYNTHETIC_TENANT_ID,
            template_key: "action_due",
            channel,
            version_no: 1,
            name: `动作到期${channel}通知`,
            status: "published" as const,
            title_template: "经营动作已到计划时间",
            body_template: "{{action_title}} 已到计划时间，请及时推进。",
            deep_link_template: "/actions?actionId={{action_id}}",
            priority: "high" as const,
            effective_at: "2026-08-31T00:00:00.000Z",
            published_by: SYNTHETIC_USER_ID,
          })),
        )
        .onConflict((conflict) =>
          conflict
            .columns(["tenant_id", "template_key", "channel", "version_no"])
            .doNothing(),
        )
        .executeTakeFirst();
      await transaction
        .insertInto("app.channel_addresses")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: "60000000-0000-4000-8000-000000000071",
          user_id: SYNTHETIC_USER_ID,
          channel: "feishu",
          external_user_id: "ou_synthetic_demo_owner",
          status: "active",
        })
        .onConflict((conflict) =>
          conflict
            .columns(["tenant_id", "channel", "external_user_id"])
            .doNothing(),
        )
        .executeTakeFirst();
    },
  );
}

export async function seedSyntheticAcceptedAction(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: REQUEST_ID,
    },
    async (transaction) => {
      const analysisRunId = "a0000000-0000-4000-8000-000000000071";
      const stateVersionId = "b0000000-0000-4000-8000-000000000071";
      const proposalId = "c0000000-0000-4000-8000-000000000071";
      await transaction
        .insertInto("app.analysis_runs")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: analysisRunId,
          entity_id: "50000000-0000-4000-8000-000000000001",
          trigger_event_id: null,
          rule_version: "rules-v1",
          analyzer_config_version: "deterministic-v1",
          input_version: "a".repeat(64),
          status: "completed",
          error_code: null,
          error_message: null,
          started_at: "2026-08-31T00:00:00.000Z",
          finished_at: "2026-08-31T00:00:30.000Z",
          created_by: SYNTHETIC_USER_ID,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.battle_state_versions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: stateVersionId,
          entity_id: "50000000-0000-4000-8000-000000000001",
          version_no: 1,
          input_version: "a".repeat(64),
          relationship_score: 50,
          potential_score: 50,
          quadrant_code: "develop",
          primary_opportunity_id: null,
          risk_level: "medium",
          data_sufficiency: "partial",
          data_gaps: JSON.stringify([]),
          summary: "Synthetic notification state",
          analysis_run_id: analysisRunId,
          effective_at: "2026-08-31T00:00:30.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.battle_state_current")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          entity_id: "50000000-0000-4000-8000-000000000001",
          battle_state_version_id: stateVersionId,
          version_no: 1,
          input_version: "a".repeat(64),
          updated_at: "2026-08-31T00:00:30.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_proposals")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: proposalId,
          entity_id: "50000000-0000-4000-8000-000000000001",
          opportunity_id: null,
          title: "推进正式方案",
          description: "在计划时间推进",
          suggested_owner_id: SYNTHETIC_USER_ID,
          suggested_priority: "high",
          suggested_planned_at: "2026-09-01T01:00:00.000Z",
          source_battle_state_version_id: stateVersionId,
          status: "accepted",
          version_no: 1,
          proposed_at: "2026-08-31T00:01:00.000Z",
          expires_at: "2026-09-07T00:01:00.000Z",
          decided_at: "2026-08-31T00:02:00.000Z",
          decided_by: SYNTHETIC_USER_ID,
          decision_reason: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.business_actions")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: SYNTHETIC_ACTION_ID,
          entity_id: "50000000-0000-4000-8000-000000000001",
          opportunity_id: null,
          title: "推进正式方案",
          description: "在计划时间推进",
          owner_user_id: SYNTHETIC_USER_ID,
          priority: "high",
          status: "planned",
          planned_at: "2026-09-01T01:00:00.000Z",
          completed_at: null,
          source_proposal_id: proposalId,
          confirmed_by: SYNTHETIC_USER_ID,
          confirmed_at: "2026-08-31T00:02:00.000Z",
          version_no: 1,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.action_status_history")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          action_id: SYNTHETIC_ACTION_ID,
          from_status: null,
          to_status: "planned",
          changed_by: SYNTHETIC_USER_ID,
          reason: "Accepted synthetic notification action.",
          changed_at: "2026-08-31T00:02:00.000Z",
          version_no: 1,
        })
        .executeTakeFirstOrThrow();
    },
  );
}

export async function seedSyntheticInboxNotification(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    reminderId: string;
    notificationId: string;
    recipientUserId: string;
    createdAt: string;
    readAt?: string;
  },
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      requestId: REQUEST_ID,
    },
    async (transaction) => {
      await transaction
        .insertInto("app.reminder_instances")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: input.reminderId,
          action_id: SYNTHETIC_ACTION_ID,
          recipient_user_id: input.recipientUserId,
          policy_version_id: SYNTHETIC_POLICY_ID,
          action_version_no: 1,
          kind: "due",
          remind_at: input.createdAt,
          channels: JSON.stringify(["in_app"]),
          status: "scheduled",
          available_at: input.createdAt,
          dedupe_key: `synthetic-reminder:${input.reminderId}`,
          created_at: input.createdAt,
          updated_at: input.createdAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.notification_events")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: input.notificationId,
          recipient_user_id: input.recipientUserId,
          reminder_id: input.reminderId,
          event_type: "action_due",
          title: "经营动作已到计划时间",
          body: "推进正式方案 已到计划时间，请及时推进。",
          deep_link: `/actions?actionId=${SYNTHETIC_ACTION_ID}`,
          priority: "high",
          read_at: input.readAt ?? null,
          dedupe_key: `synthetic-notification:${input.notificationId}`,
          created_at: input.createdAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.notification_deliveries")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          notification_event_id: input.notificationId,
          recipient_user_id: input.recipientUserId,
          channel: "in_app",
          address_id: null,
          status: "delivered",
          dedupe_key: `synthetic-delivery:${input.notificationId}:in_app`,
          available_at: input.createdAt,
          delivered_at: input.createdAt,
          created_at: input.createdAt,
          updated_at: input.createdAt,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("app.reminder_instances")
        .set({
          status: "notified",
          notification_event_id: input.notificationId,
          updated_at: input.createdAt,
        })
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .where("id", "=", input.reminderId)
        .executeTakeFirstOrThrow();
    },
  );
}
