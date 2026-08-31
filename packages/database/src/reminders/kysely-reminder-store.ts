import { randomUUID } from "node:crypto";
import type {
  ExternalNotificationChannel,
  ReminderPolicyNode,
  ReminderSchedulingContext,
  ReminderStore,
} from "@battlefield/core";
import { type Kysely, sql } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

export class ReminderClaimLostError extends Error {
  constructor() {
    super("The reminder claim is no longer active.");
    this.name = "ReminderClaimLostError";
  }
}

export class InvalidPersistedReminderPolicyError extends Error {
  constructor() {
    super("The persisted reminder policy is invalid.");
    this.name = "InvalidPersistedReminderPolicyError";
  }
}

export class KyselyReminderStore implements ReminderStore {
  private readonly enabledExternalChannels: ReadonlySet<ExternalNotificationChannel>;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: {
      enabledExternalChannels?: ExternalNotificationChannel[];
    } = {},
  ) {
    this.enabledExternalChannels = new Set(
      options.enabledExternalChannels ?? ["feishu", "email"],
    );
  }

  async loadSchedulingContext(
    input: Parameters<ReminderStore["loadSchedulingContext"]>[0],
  ): Promise<ReminderSchedulingContext | null> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const action = await transaction
          .selectFrom("app.business_actions")
          .select(["id", "owner_user_id", "planned_at", "status", "version_no"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.actionId)
          .executeTakeFirst();
        if (!action) {
          return null;
        }
        const policy = await transaction
          .selectFrom("app.reminder_policy_versions")
          .select(["id", "version_no", "nodes"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("policy_key", "=", "default_action_due")
          .where("status", "=", "published")
          .where("effective_at", "<=", new Date(input.occurredAt))
          .orderBy("effective_at", "desc")
          .orderBy("version_no", "desc")
          .executeTakeFirst();
        if (!policy) {
          return null;
        }
        return {
          action: {
            actionId: action.id,
            ownerUserId: action.owner_user_id,
            plannedAt: toIso(action.planned_at),
            status: action.status,
            versionNo: String(action.version_no),
          },
          policy: {
            policyVersionId: policy.id,
            versionNo: String(policy.version_no),
            nodes: decodePolicyNodes(policy.nodes),
          },
        };
      },
    );
  }

  async schedule(
    input: Parameters<ReminderStore["schedule"]>[0],
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        await transaction
          .insertInto("app.reminder_instances")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            action_id: input.actionId,
            recipient_user_id: input.recipientUserId,
            policy_version_id: input.policyVersionId,
            action_version_no: input.actionVersionNo,
            kind: input.kind,
            remind_at: input.remindAt,
            channels: input.channels,
            status: "scheduled",
            available_at: input.remindAt,
            attempt_count: 0,
            claim_token: null,
            claimed_at: null,
            notification_event_id: null,
            dedupe_key: input.dedupeKey,
            last_error_code: null,
            last_error_message: null,
            cancelled_at: null,
            created_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "dedupe_key"]).doNothing(),
          )
          .executeTakeFirst();
      },
    );
  }

  async cancelOpenForAction(
    input: Parameters<ReminderStore["cancelOpenForAction"]>[0],
  ): Promise<number> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const result = await transaction
          .updateTable("app.reminder_instances")
          .set({
            status: "cancelled",
            cancelled_at: input.cancelledAt,
            claim_token: null,
            claimed_at: null,
            last_error_code: null,
            last_error_message: null,
            updated_at: sql`greatest(updated_at, ${input.cancelledAt}::timestamptz)`,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("action_id", "=", input.actionId)
          .where("status", "in", ["scheduled", "failed"])
          .executeTakeFirst();
        return Number(result.numUpdatedRows);
      },
    );
  }

  async claimDueBatch(
    input: Parameters<ReminderStore["claimDueBatch"]>[0],
  ): ReturnType<ReminderStore["claimDueBatch"]> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const candidates = await transaction
          .selectFrom("app.reminder_instances")
          .select("id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("status", "in", ["scheduled", "failed"])
          .where("available_at", "<=", new Date(input.now))
          .orderBy("available_at", "asc")
          .orderBy("id", "asc")
          .limit(input.limit)
          .forUpdate()
          .skipLocked()
          .execute();
        const claims = [];
        for (const candidate of candidates) {
          const claimToken = randomUUID();
          const row = await transaction
            .updateTable("app.reminder_instances")
            .set({
              status: "processing",
              claim_token: claimToken,
              claimed_at: input.now,
              attempt_count: sql`attempt_count + 1`,
              last_error_code: null,
              last_error_message: null,
              updated_at: input.now,
            })
            .where("tenant_id", "=", input.actor.tenantId)
            .where("id", "=", candidate.id)
            .returning(["id", "attempt_count"])
            .executeTakeFirstOrThrow();
          claims.push({
            reminderId: row.id,
            attemptCount: row.attempt_count,
            claimToken,
          });
        }
        return claims;
      },
    );
  }

  async materializeDueReminder(
    input: Parameters<ReminderStore["materializeDueReminder"]>[0],
  ): Promise<"notified" | "cancelled"> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const reminder = await transaction
          .selectFrom("app.reminder_instances")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.reminderId)
          .where("status", "=", "processing")
          .where("claim_token", "=", input.claimToken)
          .forUpdate()
          .executeTakeFirst();
        if (!reminder) {
          throw new ReminderClaimLostError();
        }
        const action = await transaction
          .selectFrom("app.business_actions")
          .select(["id", "title", "owner_user_id", "status", "planned_at"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", reminder.action_id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !action ||
          !["planned", "in_progress"].includes(action.status) ||
          toIso(action.planned_at) !== toIso(reminder.remind_at) ||
          action.owner_user_id !== reminder.recipient_user_id
        ) {
          await transaction
            .updateTable("app.reminder_instances")
            .set({
              status: "cancelled",
              cancelled_at: input.notifiedAt,
              claim_token: null,
              claimed_at: null,
              updated_at: input.notifiedAt,
            })
            .where("tenant_id", "=", input.actor.tenantId)
            .where("id", "=", input.reminderId)
            .executeTakeFirstOrThrow();
          return "cancelled";
        }
        const template = await transaction
          .selectFrom("app.notification_template_versions")
          .select([
            "title_template",
            "body_template",
            "deep_link_template",
            "priority",
          ])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("template_key", "=", "action_due")
          .where("channel", "=", "in_app")
          .where("status", "=", "published")
          .where("effective_at", "<=", new Date(input.notifiedAt))
          .orderBy("version_no", "desc")
          .executeTakeFirstOrThrow();
        const content = renderTemplate(template, {
          actionId: action.id,
          actionTitle: action.title,
        });
        const proposedEventId = randomUUID();
        const inserted = await transaction
          .insertInto("app.notification_events")
          .values({
            tenant_id: input.actor.tenantId,
            id: proposedEventId,
            recipient_user_id: reminder.recipient_user_id,
            reminder_id: reminder.id,
            event_type: "action_due",
            title: content.title,
            body: content.body,
            deep_link: content.deepLink,
            priority: template.priority,
            read_at: null,
            dedupe_key: `reminder:${reminder.id}:action_due`,
            created_at: input.notifiedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "dedupe_key"]).doNothing(),
          )
          .returning("id")
          .executeTakeFirst();
        const eventId =
          inserted?.id ??
          (
            await transaction
              .selectFrom("app.notification_events")
              .select("id")
              .where("tenant_id", "=", input.actor.tenantId)
              .where("dedupe_key", "=", `reminder:${reminder.id}:action_due`)
              .executeTakeFirstOrThrow()
          ).id;
        await transaction
          .insertInto("app.notification_deliveries")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            notification_event_id: eventId,
            recipient_user_id: reminder.recipient_user_id,
            channel: "in_app",
            address_id: null,
            status: "delivered",
            dedupe_key: `notification:${eventId}:channel:in_app`,
            available_at: input.notifiedAt,
            attempt_count: 0,
            claim_token: null,
            claimed_at: null,
            delivered_at: input.notifiedAt,
            provider_message_id: null,
            provider_request_id: null,
            last_error_code: null,
            last_error_message: null,
            created_at: input.notifiedAt,
            updated_at: input.notifiedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "dedupe_key"]).doNothing(),
          )
          .executeTakeFirst();
        const channels = decodeChannels(reminder.channels);
        if (
          channels.includes("feishu") &&
          this.enabledExternalChannels.has("feishu")
        ) {
          const address = await transaction
            .selectFrom("app.channel_addresses")
            .select("id")
            .where("tenant_id", "=", input.actor.tenantId)
            .where("user_id", "=", reminder.recipient_user_id)
            .where("channel", "=", "feishu")
            .where("status", "=", "active")
            .executeTakeFirst();
          if (address) {
            await transaction
              .insertInto("app.notification_deliveries")
              .values({
                tenant_id: input.actor.tenantId,
                id: randomUUID(),
                notification_event_id: eventId,
                recipient_user_id: reminder.recipient_user_id,
                channel: "feishu",
                address_id: address.id,
                status: "pending",
                dedupe_key: `feishu:${eventId}`,
                available_at: input.notifiedAt,
                attempt_count: 0,
                claim_token: null,
                claimed_at: null,
                delivered_at: null,
                provider_message_id: null,
                provider_request_id: null,
                last_error_code: null,
                last_error_message: null,
                created_at: input.notifiedAt,
                updated_at: input.notifiedAt,
              })
              .onConflict((conflict) =>
                conflict.columns(["tenant_id", "dedupe_key"]).doNothing(),
              )
              .executeTakeFirst();
          }
        }
        const completed = await transaction
          .updateTable("app.reminder_instances")
          .set({
            status: "notified",
            notification_event_id: eventId,
            claim_token: null,
            claimed_at: null,
            last_error_code: null,
            last_error_message: null,
            updated_at: input.notifiedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", reminder.id)
          .where("status", "=", "processing")
          .where("claim_token", "=", input.claimToken)
          .executeTakeFirst();
        if (completed.numUpdatedRows !== 1n) {
          throw new ReminderClaimLostError();
        }
        return "notified";
      },
    );
  }

  async reschedule(
    input: Parameters<ReminderStore["reschedule"]>[0],
  ): Promise<void> {
    await this.completeFailure(input, "failed");
  }

  async deadLetter(
    input: Parameters<ReminderStore["deadLetter"]>[0],
  ): Promise<void> {
    await this.completeFailure(input, "dead_lettered");
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
          .updateTable("app.reminder_instances")
          .set({
            status: "failed",
            available_at: input.availableAt,
            claim_token: null,
            claimed_at: null,
            last_error_code: "REMINDER_LEASE_EXPIRED",
            last_error_message: "Reminder processing lease expired.",
            updated_at: sql`greatest(updated_at, ${input.availableAt}::timestamptz)`,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("status", "=", "processing")
          .where("claimed_at", "<=", new Date(input.expiredBefore))
          .executeTakeFirst();
        return { recovered: Number(result.numUpdatedRows) };
      },
    );
  }

  private async completeFailure(
    input:
      | Parameters<ReminderStore["reschedule"]>[0]
      | Parameters<ReminderStore["deadLetter"]>[0],
    status: "failed" | "dead_lettered",
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const result = await transaction
          .updateTable("app.reminder_instances")
          .set({
            status,
            ...(status === "failed" && "availableAt" in input
              ? { available_at: input.availableAt }
              : {}),
            claim_token: null,
            claimed_at: null,
            last_error_code: input.errorCode,
            last_error_message: input.errorMessage,
            updated_at: sql`now()`,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.reminderId)
          .where("status", "=", "processing")
          .where("claim_token", "=", input.claimToken)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw new ReminderClaimLostError();
        }
      },
    );
  }
}

function decodePolicyNodes(value: unknown): ReminderPolicyNode[] {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(decoded) || decoded.length === 0) {
    throw new InvalidPersistedReminderPolicyError();
  }
  return decoded.map((item) => {
    if (!item || typeof item !== "object") {
      throw new InvalidPersistedReminderPolicyError();
    }
    const node = item as Record<string, unknown>;
    if (
      !["advance", "due", "overdue", "escalation"].includes(
        String(node.kind),
      ) ||
      !Number.isInteger(node.offsetMinutes) ||
      node.recipient !== "owner" ||
      !Array.isArray(node.channels) ||
      node.channels.length === 0 ||
      !node.channels.every((channel) =>
        ["in_app", "feishu", "email"].includes(String(channel)),
      )
    ) {
      throw new InvalidPersistedReminderPolicyError();
    }
    return node as unknown as ReminderPolicyNode;
  });
}

function decodeChannels(value: unknown): string[] {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(decoded)) {
    throw new InvalidPersistedReminderPolicyError();
  }
  return decoded.map(String);
}

function renderTemplate(
  template: {
    title_template: string;
    body_template: string;
    deep_link_template: string;
  },
  values: { actionId: string; actionTitle: string },
): { title: string; body: string; deepLink: string } {
  const replace = (value: string) =>
    value
      .replaceAll("{{action_id}}", values.actionId)
      .replaceAll("{{action_title}}", values.actionTitle);
  const rendered = {
    title: replace(template.title_template),
    body: replace(template.body_template),
    deepLink: replace(template.deep_link_template),
  };
  if (
    rendered.title.length === 0 ||
    rendered.title.length > 200 ||
    rendered.body.length === 0 ||
    rendered.body.length > 2_000 ||
    !/^\/(?!\/)[^\r\n]*$/.test(rendered.deepLink) ||
    rendered.deepLink.length > 2_000
  ) {
    throw new InvalidPersistedReminderPolicyError();
  }
  return rendered;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
