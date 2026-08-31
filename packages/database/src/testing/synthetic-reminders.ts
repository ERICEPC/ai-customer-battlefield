import type { DatabaseHandle } from "../database-handle.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";
import {
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
} from "./synthetic-directory.js";

const REQUEST_ID = "90000000-0000-4000-8000-000000000071";

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
          nodes: [
            {
              kind: "due",
              offsetMinutes: 0,
              recipient: "owner",
              channels: ["in_app", "feishu"],
            },
          ],
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
