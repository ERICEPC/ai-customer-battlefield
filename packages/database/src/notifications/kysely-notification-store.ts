import { randomUUID } from "node:crypto";
import type {
  ExternalNotificationChannel,
  NotificationDeliveryClaim,
  NotificationStore,
  WeeklyReportPublicationNotificationInput,
  WeeklyReportPublicationNotificationStore,
} from "@battlefield/core";
import { type Kysely, sql, type UpdateObject } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

interface InboxCursor {
  createdAt: string;
  notificationId: string;
}

export interface InboxPage {
  items: Array<{
    notificationId: string;
    eventType: "action_due" | "weekly_report_published";
    title: string;
    body: string;
    deepLink: string;
    priority: "low" | "medium" | "high" | "urgent";
    createdAt: string;
    readAt: string | null;
  }>;
  nextCursor: string | null;
}

export class NotificationClaimLostError extends Error {
  constructor() {
    super("The notification delivery claim is no longer active.");
    this.name = "NotificationClaimLostError";
  }
}

export class NotificationNotFoundError extends Error {
  constructor() {
    super("The notification was not found.");
    this.name = "NotificationNotFoundError";
  }
}

export class InvalidInboxCursorError extends Error {
  constructor() {
    super("The inbox cursor is invalid.");
    this.name = "InvalidInboxCursorError";
  }
}

export interface KyselyNotificationStoreOptions {
  enabledExternalChannels?: ExternalNotificationChannel[];
}

export class KyselyNotificationStore
  implements NotificationStore, WeeklyReportPublicationNotificationStore
{
  private readonly enabledExternalChannels: Set<ExternalNotificationChannel>;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyNotificationStoreOptions = {},
  ) {
    this.enabledExternalChannels = new Set(
      options.enabledExternalChannels ?? [],
    );
  }

  async materialize(
    input: WeeklyReportPublicationNotificationInput,
  ): Promise<boolean> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const report = await transaction
          .selectFrom("app.weekly_report_versions as version")
          .innerJoin("app.weekly_reports as report", (join) =>
            join
              .onRef("report.tenant_id", "=", "version.tenant_id")
              .onRef("report.id", "=", "version.report_id"),
          )
          .innerJoin("app.weekly_report_audiences as audience", (join) =>
            join
              .onRef("audience.tenant_id", "=", "version.tenant_id")
              .onRef("audience.report_version_id", "=", "version.id"),
          )
          .select(["version.title"])
          .where("version.tenant_id", "=", input.actor.tenantId)
          .where("version.id", "=", input.reportVersionId)
          .where("version.report_id", "=", input.reportId)
          .where("version.status", "=", "published")
          .where("report.report_type", "=", input.reportType)
          .where("audience.user_id", "=", input.recipientUserId)
          .where("audience.audience_role", "=", "recipient")
          .executeTakeFirst();
        if (!report) return false;

        const template = await transaction
          .selectFrom("app.notification_template_versions")
          .select([
            "title_template",
            "body_template",
            "deep_link_template",
            "priority",
          ])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("template_key", "=", "weekly_report_published")
          .where("channel", "=", "in_app")
          .where("status", "=", "published")
          .where("effective_at", "<=", new Date(input.publishedAt))
          .orderBy("version_no", "desc")
          .executeTakeFirst();
        const content = renderWeeklyReportTemplate(
          template ?? {
            title_template: "周报已发布",
            body_template: "《{{report_title}}》已发布，可查看正式版本。",
            deep_link_template:
              "/reports?reportId={{report_id}}&versionId={{report_version_id}}",
            priority: "medium" as const,
          },
          {
            reportId: input.reportId,
            reportVersionId: input.reportVersionId,
            reportTitle: report.title,
          },
        );
        const dedupeKey = `weekly-report:${input.reportVersionId}:published`;
        const inserted = await transaction
          .insertInto("app.notification_events")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            recipient_user_id: input.recipientUserId,
            reminder_id: null,
            report_version_id: input.reportVersionId,
            event_type: "weekly_report_published",
            title: content.title,
            body: content.body,
            deep_link: content.deepLink,
            priority: template?.priority ?? "medium",
            read_at: null,
            dedupe_key: dedupeKey,
            created_at: input.publishedAt,
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
              .where("report_version_id", "=", input.reportVersionId)
              .where("recipient_user_id", "=", input.recipientUserId)
              .executeTakeFirstOrThrow()
          ).id;
        await transaction
          .insertInto("app.notification_deliveries")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            notification_event_id: eventId,
            recipient_user_id: input.recipientUserId,
            channel: "in_app",
            address_id: null,
            status: "delivered",
            dedupe_key: `notification:${eventId}:channel:in_app`,
            available_at: input.publishedAt,
            attempt_count: 0,
            claim_token: null,
            claimed_at: null,
            delivered_at: input.publishedAt,
            provider_message_id: null,
            provider_request_id: null,
            last_error_code: null,
            last_error_message: null,
            created_at: input.publishedAt,
            updated_at: input.publishedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "dedupe_key"]).doNothing(),
          )
          .executeTakeFirst();

        for (const channel of this.enabledExternalChannels) {
          const address = await transaction
            .selectFrom("app.channel_addresses")
            .select("id")
            .where("tenant_id", "=", input.actor.tenantId)
            .where("user_id", "=", input.recipientUserId)
            .where("channel", "=", channel)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (!address) continue;
          await transaction
            .insertInto("app.notification_deliveries")
            .values({
              tenant_id: input.actor.tenantId,
              id: randomUUID(),
              notification_event_id: eventId,
              recipient_user_id: input.recipientUserId,
              channel,
              address_id: address.id,
              status: "pending",
              dedupe_key: `${channel}:${eventId}`,
              available_at: input.publishedAt,
              attempt_count: 0,
              claim_token: null,
              claimed_at: null,
              delivered_at: null,
              provider_message_id: null,
              provider_request_id: null,
              last_error_code: null,
              last_error_message: null,
              created_at: input.publishedAt,
              updated_at: input.publishedAt,
            })
            .onConflict((conflict) =>
              conflict.columns(["tenant_id", "dedupe_key"]).doNothing(),
            )
            .executeTakeFirst();
        }
        return true;
      },
    );
  }

  async claimDelivery(
    input: Parameters<NotificationStore["claimDelivery"]>[0],
  ): Promise<NotificationDeliveryClaim | null> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const delivery = await transaction
          .selectFrom("app.notification_deliveries")
          .select(["id", "channel", "address_id"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.deliveryId)
          .where("status", "in", ["pending", "failed"])
          .where("available_at", "<=", new Date(input.now))
          .where("channel", "in", ["feishu", "email"])
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!delivery?.address_id) {
          return null;
        }
        const address = await transaction
          .selectFrom("app.channel_addresses")
          .select("external_user_id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", delivery.address_id)
          .where("channel", "=", delivery.channel)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (!address) {
          await transaction
            .updateTable("app.notification_deliveries")
            .set({
              status: "dead_lettered",
              last_error_code: "NOTIFICATION_ADDRESS_UNAVAILABLE",
              last_error_message:
                "Notification recipient address is unavailable.",
              updated_at: input.now,
            })
            .where("tenant_id", "=", input.actor.tenantId)
            .where("id", "=", delivery.id)
            .executeTakeFirstOrThrow();
          return null;
        }
        const claimToken = randomUUID();
        const claimed = await transaction
          .updateTable("app.notification_deliveries")
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
          .where("id", "=", delivery.id)
          .returning([
            "id",
            "notification_event_id",
            "channel",
            "dedupe_key",
            "attempt_count",
          ])
          .executeTakeFirstOrThrow();
        const event = await transaction
          .selectFrom("app.notification_events")
          .select(["title", "body", "deep_link", "priority", "created_at"])
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", claimed.notification_event_id)
          .executeTakeFirstOrThrow();
        return {
          deliveryId: claimed.id,
          notificationId: claimed.notification_event_id,
          channel: claimed.channel as "feishu" | "email",
          recipientAddress: address.external_user_id,
          title: event.title,
          body: event.body,
          deepLink: event.deep_link,
          priority: event.priority,
          createdAt: toIso(event.created_at),
          dedupeKey: claimed.dedupe_key,
          attemptCount: claimed.attempt_count,
          claimToken,
        };
      },
    );
  }

  async markDelivered(
    input: Parameters<NotificationStore["markDelivered"]>[0],
  ): Promise<void> {
    await this.completeClaim(input, {
      status: "delivered",
      claim_token: null,
      claimed_at: null,
      delivered_at: input.deliveredAt,
      provider_message_id: input.providerMessageId,
      provider_request_id: input.providerRequestId,
      last_error_code: null,
      last_error_message: null,
      updated_at: input.deliveredAt,
    });
  }

  async reschedule(
    input: Parameters<NotificationStore["reschedule"]>[0],
  ): Promise<void> {
    await this.completeClaim(input, {
      status: "failed",
      available_at: input.availableAt,
      claim_token: null,
      claimed_at: null,
      delivered_at: null,
      provider_message_id: null,
      provider_request_id: null,
      last_error_code: input.errorCode,
      last_error_message: input.errorMessage,
      updated_at: sql`now()`,
    });
  }

  async deadLetter(
    input: Parameters<NotificationStore["deadLetter"]>[0],
  ): Promise<void> {
    await this.completeClaim(input, {
      status: "dead_lettered",
      claim_token: null,
      claimed_at: null,
      delivered_at: null,
      provider_message_id: null,
      provider_request_id: null,
      last_error_code: input.errorCode,
      last_error_message: input.errorMessage,
      updated_at: sql`now()`,
    });
  }

  async listInbox(input: {
    actor: { tenantId: string; userId: string };
    unreadOnly?: boolean;
    cursor?: string;
    limit: number;
  }): Promise<InboxPage> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        let query = transaction
          .selectFrom("app.notification_events")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("recipient_user_id", "=", input.actor.userId);
        if (input.unreadOnly) {
          query = query.where("read_at", "is", null);
        }
        if (cursor) {
          query = query.where((expression) =>
            expression.or([
              expression("created_at", "<", new Date(cursor.createdAt)),
              expression.and([
                expression("created_at", "=", new Date(cursor.createdAt)),
                expression("id", "<", cursor.notificationId),
              ]),
            ]),
          );
        }
        const rows = await query
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(input.limit + 1)
          .execute();
        const hasMore = rows.length > input.limit;
        const pageRows = rows.slice(0, input.limit);
        const items = pageRows.map((row) => ({
          notificationId: row.id,
          eventType: row.event_type,
          title: row.title,
          body: row.body,
          deepLink: row.deep_link,
          priority: row.priority,
          createdAt: toIso(row.created_at),
          readAt: row.read_at ? toIso(row.read_at) : null,
        }));
        const last = pageRows.at(-1);
        return {
          items,
          nextCursor:
            hasMore && last
              ? encodeCursor({
                  createdAt: toIso(last.created_at),
                  notificationId: last.id,
                })
              : null,
        };
      },
    );
  }

  async markRead(input: {
    actor: { tenantId: string; userId: string };
    notificationId: string;
    readAt: string;
  }): Promise<{ notificationId: string; readAt: string }> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const row = await transaction
          .updateTable("app.notification_events")
          .set({
            read_at: sql`coalesce(read_at, ${input.readAt}::timestamptz)`,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("recipient_user_id", "=", input.actor.userId)
          .where("id", "=", input.notificationId)
          .returning(["id", "read_at"])
          .executeTakeFirst();
        if (!row?.read_at) {
          throw new NotificationNotFoundError();
        }
        return { notificationId: row.id, readAt: toIso(row.read_at) };
      },
    );
  }

  async listAvailableDeliveryIds(input: {
    actor: { tenantId: string; userId: string };
    now: string;
    limit: number;
  }): Promise<string[]> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const rows = await transaction
          .selectFrom("app.notification_deliveries")
          .select("id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("channel", "in", ["feishu", "email"])
          .where("status", "in", ["pending", "failed"])
          .where("available_at", "<=", new Date(input.now))
          .orderBy("available_at", "asc")
          .orderBy("id", "asc")
          .limit(input.limit)
          .execute();
        return rows.map((row) => row.id);
      },
    );
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
          .updateTable("app.notification_deliveries")
          .set({
            status: "failed",
            available_at: input.availableAt,
            claim_token: null,
            claimed_at: null,
            last_error_code: "NOTIFICATION_LEASE_EXPIRED",
            last_error_message: "Notification delivery lease expired.",
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

  private async completeClaim(
    input: {
      actor: { tenantId: string; userId: string };
      deliveryId: string;
      claimToken: string;
    },
    values: UpdateObject<
      BattlefieldDatabase,
      "app.notification_deliveries",
      "app.notification_deliveries"
    >,
  ): Promise<void> {
    await withTenantTransaction(
      this.database,
      { ...input.actor, requestId: randomUUID() },
      async (transaction) => {
        const result = await transaction
          .updateTable("app.notification_deliveries")
          .set(values)
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.deliveryId)
          .where("status", "=", "processing")
          .where("claim_token", "=", input.claimToken)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw new NotificationClaimLostError();
        }
      },
    );
  }
}

function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): InboxCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof decoded.createdAt !== "string" ||
      !Number.isFinite(Date.parse(decoded.createdAt)) ||
      typeof decoded.notificationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(decoded.notificationId)
    ) {
      throw new InvalidInboxCursorError();
    }
    return decoded as InboxCursor;
  } catch (error) {
    if (error instanceof InvalidInboxCursorError) {
      throw error;
    }
    throw new InvalidInboxCursorError();
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function renderWeeklyReportTemplate(
  template: {
    title_template: string;
    body_template: string;
    deep_link_template: string;
  },
  values: {
    reportId: string;
    reportVersionId: string;
    reportTitle: string;
  },
): { title: string; body: string; deepLink: string } {
  const replace = (value: string) =>
    value
      .replaceAll("{{report_id}}", values.reportId)
      .replaceAll("{{report_version_id}}", values.reportVersionId)
      .replaceAll("{{report_title}}", values.reportTitle);
  const rendered = {
    title: replace(template.title_template),
    body: replace(template.body_template),
    deepLink: replace(template.deep_link_template),
  };
  const deepLink = new URL(rendered.deepLink, "https://battlefield.local");
  const reportIds = deepLink.searchParams.getAll("reportId");
  const versionIds = deepLink.searchParams.getAll("versionId");
  if (
    rendered.title.trim().length === 0 ||
    rendered.title.length > 200 ||
    rendered.body.trim().length === 0 ||
    rendered.body.length > 2_000 ||
    !/^\/(?!\/)[^\r\n]*$/.test(rendered.deepLink) ||
    rendered.deepLink.length > 2_000 ||
    deepLink.pathname !== "/reports" ||
    reportIds.length !== 1 ||
    reportIds[0] !== values.reportId ||
    versionIds.length !== 1 ||
    versionIds[0] !== values.reportVersionId
  ) {
    throw new Error(
      "The published weekly-report notification template is invalid.",
    );
  }
  return rendered;
}
