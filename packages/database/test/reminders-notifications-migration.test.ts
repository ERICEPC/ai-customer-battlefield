import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ALPHA = "10000000-0000-4000-8000-000000000001";
const TENANT_BETA = "20000000-0000-4000-8000-000000000001";
const USER_ALPHA = "30000000-0000-4000-8000-000000000001";
const USER_ALPHA_SECOND = "30000000-0000-4000-8000-000000000003";
const USER_BETA = "30000000-0000-4000-8000-000000000002";
const ACTION_ALPHA = "d0000000-0000-4000-8000-000000000001";
const ACTION_BETA = "d0000000-0000-4000-8000-000000000002";
const POLICY_ALPHA = "71000000-0000-4000-8000-000000000001";
const TEMPLATE_ALPHA = "71100000-0000-4000-8000-000000000001";
const REMINDER_ALPHA = "72000000-0000-4000-8000-000000000001";
const NOTIFICATION_ALPHA = "f0000000-0000-4000-8000-000000000001";
const ADDRESS_ALPHA = "60000000-0000-4000-8000-000000000001";

describe("0005_reminders_notifications migration", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates and force-protects every reminder and notification table", async () => {
    const tables = [
      "notification_deliveries",
      "notification_events",
      "notification_template_versions",
      "reminder_instances",
      "reminder_policy_versions",
    ];
    const result = await sql<{ protected_count: number; total_count: number }>`
      select
        count(*) filter (where class.relrowsecurity and class.relforcerowsecurity)::int
          as protected_count,
        count(*)::int as total_count
      from pg_class as class
      inner join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'app'
        and class.relkind = 'r'
        and class.relname in (${sql.join(tables)})
    `.execute(database.db);

    expect(result.rows[0]).toEqual({ protected_count: 5, total_count: 5 });
  });

  test("seeds one published due policy and two channel templates for existing tenants", async () => {
    const stagedDatabase = await createPgliteDatabase<BattlefieldDatabase>();
    const stagedDirectory = await mkdtemp(
      join(tmpdir(), "battlefield-migrations-"),
    );
    try {
      for (const name of [
        "0001_foundation.sql",
        "0002_customer_operations.sql",
        "0003_followup_confirmation.sql",
        "0004_battle_analysis_actions.sql",
      ]) {
        await copyFile(
          join(MIGRATION_DIRECTORY, name),
          join(stagedDirectory, name),
        );
      }
      await migrateDatabase(stagedDatabase.migrations, stagedDirectory);
      await sql`
        insert into app.tenants (id, slug, name)
        values (${TENANT_ALPHA}::uuid, 'seed-alpha', 'seed-alpha')
      `.execute(stagedDatabase.db);
      await sql`
        insert into app.users (tenant_id, id, display_name)
        values (${TENANT_ALPHA}::uuid, ${USER_ALPHA}::uuid, 'alpha-user')
      `.execute(stagedDatabase.db);

      await migrateDatabase(stagedDatabase.migrations, MIGRATION_DIRECTORY);
      const seeded = await sql<{
        policy_count: number;
        template_count: number;
        nodes: unknown;
      }>`
        select
          (select count(*)::int from app.reminder_policy_versions
            where tenant_id = ${TENANT_ALPHA}::uuid and status = 'published') as policy_count,
          (select count(*)::int from app.notification_template_versions
            where tenant_id = ${TENANT_ALPHA}::uuid and status = 'published') as template_count,
          (select nodes from app.reminder_policy_versions
            where tenant_id = ${TENANT_ALPHA}::uuid and policy_key = 'default_action_due') as nodes
      `.execute(stagedDatabase.db);

      expect(seeded.rows[0]).toEqual({
        policy_count: 1,
        template_count: 2,
        nodes: [
          {
            kind: "due",
            offsetMinutes: 0,
            recipient: "owner",
            channels: ["in_app", "feishu"],
          },
        ],
      });
    } finally {
      await stagedDatabase.close();
      await rm(stagedDirectory, { recursive: true, force: true });
    }
  });

  test("keeps published policy and template versions immutable and unique", async () => {
    await seedAction(database, "alpha");
    await insertPolicy(database);
    await insertTemplate(database);

    await expect(
      insertPolicy(database, {
        policyId: "71000000-0000-4000-8000-000000000002",
        versionNo: 2,
      }),
    ).rejects.toThrow();
    await expect(
      sql`
        update app.reminder_policy_versions set name = 'tampered'
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${POLICY_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      sql`
        update app.notification_template_versions set title_template = 'tampered'
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${TEMPLATE_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      insertPolicy(database, {
        policyId: "71000000-0000-4000-8000-000000000003",
        policyKey: "invalid_nodes",
        nodes: {},
      }),
    ).rejects.toThrow();
  });

  test("rejects cross-tenant actions, recipients, policies, and addresses", async () => {
    await seedAction(database, "alpha");
    await seedAction(database, "beta");
    await insertPolicy(database);

    await expect(
      insertReminder(database, { actionId: ACTION_BETA }),
    ).rejects.toThrow();
    await expect(
      insertReminder(database, { recipientUserId: USER_BETA }),
    ).rejects.toThrow();
    await insertReminder(database);
    await insertNotification(database);
    await insertAddress(database, "alpha");
    await insertAddress(database, "beta");
    await expect(
      insertDelivery(database, {
        deliveryId: "73000000-0000-4000-8000-000000000002",
        channel: "feishu",
        addressId: "60000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow();
    await sql`
      insert into app.users (tenant_id, id, display_name)
      values (${TENANT_ALPHA}::uuid, ${USER_ALPHA_SECOND}::uuid, 'alpha-second')
    `.execute(database.db);
    await sql`
      insert into app.channel_addresses (
        tenant_id, id, user_id, channel, external_user_id
      ) values (
        ${TENANT_ALPHA}::uuid,
        '60000000-0000-4000-8000-000000000003'::uuid,
        ${USER_ALPHA_SECOND}::uuid, 'feishu', 'ou_alpha_second_synthetic'
      )
    `.execute(database.db);
    await expect(
      insertDelivery(database, {
        deliveryId: "73000000-0000-4000-8000-000000000003",
        channel: "feishu",
        addressId: "60000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toThrow();
  });

  test("deduplicates reminder and notification facts and constrains lifecycle metadata", async () => {
    await seedAction(database, "alpha");
    await insertPolicy(database);
    await insertReminder(database);

    await expect(
      insertReminder(database, {
        reminderId: "72000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow();
    await expect(
      sql`
        update app.reminder_instances
        set status = 'processing', claimed_at = now()
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${REMINDER_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await insertNotification(database);
    await expect(
      insertNotification(database, {
        notificationId: "f0000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow();
    await expect(
      insertNotification(database, {
        notificationId: "f0000000-0000-4000-8000-000000000003",
        dedupeKey: "notification:other",
        deepLink: "https://unsafe.example/path",
      }),
    ).rejects.toThrow();
    await expect(
      insertNotification(database, {
        notificationId: "f0000000-0000-4000-8000-000000000004",
        dedupeKey: "notification:future-read",
        readAt: "2026-08-31T23:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  test("requires coherent in-app and external delivery states", async () => {
    await seedAction(database, "alpha");
    await insertPolicy(database);
    await insertReminder(database);
    await insertNotification(database);
    await insertAddress(database, "alpha");

    await insertDelivery(database);
    await expect(
      insertDelivery(database, {
        deliveryId: "73000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow();
    await expect(
      insertDelivery(database, {
        deliveryId: "73000000-0000-4000-8000-000000000003",
        channel: "feishu",
        addressId: null,
      }),
    ).rejects.toThrow();
    await expect(
      insertDelivery(database, {
        deliveryId: "73000000-0000-4000-8000-000000000004",
        channel: "email",
        addressId: ADDRESS_ALPHA,
      }),
    ).rejects.toThrow();
    await insertDelivery(database, {
      deliveryId: "73000000-0000-4000-8000-000000000005",
      channel: "feishu",
      addressId: ADDRESS_ALPHA,
      status: "pending",
    });
    await expect(
      sql`
        update app.notification_deliveries
        set status = 'delivered', delivered_at = now()
        where tenant_id = ${TENANT_ALPHA}::uuid
          and id = '73000000-0000-4000-8000-000000000005'::uuid
      `.execute(database.db),
    ).rejects.toThrow();
  });

  test("extends Outbox with claim tokens and terminal dead letters outside the claim index", async () => {
    await seedAction(database, "alpha");
    const eventId = "74000000-0000-4000-8000-000000000001";
    const messageId = "74100000-0000-4000-8000-000000000001";
    await sql`
      insert into app.domain_events (
        tenant_id, id, aggregate_type, aggregate_id, event_type,
        event_version, payload, occurred_at
      ) values (
        ${TENANT_ALPHA}::uuid, ${eventId}::uuid, 'business_action',
        ${ACTION_ALPHA}::uuid, 'action.tested', 1, '{}'::jsonb,
        '2026-09-01T00:00:00.000Z'::timestamptz
      )
    `.execute(database.db);
    await sql`
      insert into app.outbox_messages (
        tenant_id, id, event_id, topic, payload, dedupe_key, available_at
      ) values (
        ${TENANT_ALPHA}::uuid, ${messageId}::uuid, ${eventId}::uuid,
        'action.tested.v1', '{}'::jsonb, 'action-tested',
        '2026-09-01T00:00:00.000Z'::timestamptz
      )
    `.execute(database.db);
    await expect(
      sql`
        update app.outbox_messages
        set status = 'processing', claimed_at = now()
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${messageId}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await sql`
      update app.outbox_messages
      set status = 'dead_lettered', last_error_code = 'UNKNOWN_TOPIC',
          last_error = 'No handler is registered.'
      where tenant_id = ${TENANT_ALPHA}::uuid and id = ${messageId}::uuid
    `.execute(database.db);
    const indexes = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes
      where schemaname = 'app' and indexname = 'outbox_messages_claim_idx'
    `.execute(database.db);

    expect(indexes.rows[0]?.indexdef).toContain(
      "'pending'::text, 'failed'::text",
    );
    expect(indexes.rows[0]?.indexdef).not.toContain("dead_lettered");
  });
});

async function seedAction(
  database: DatabaseHandle<BattlefieldDatabase>,
  scope: "alpha" | "beta",
): Promise<void> {
  const isAlpha = scope === "alpha";
  const tenantId = isAlpha ? TENANT_ALPHA : TENANT_BETA;
  const userId = isAlpha ? USER_ALPHA : USER_BETA;
  const actionId = isAlpha ? ACTION_ALPHA : ACTION_BETA;
  const suffix = isAlpha ? "1" : "2";
  const typeId = `40000000-0000-4000-8000-00000000000${suffix}`;
  const entityId = `50000000-0000-4000-8000-00000000000${suffix}`;
  const runId = `a0000000-0000-4000-8000-00000000000${suffix}`;
  const stateId = `b0000000-0000-4000-8000-00000000000${suffix}`;
  const proposalId = `c0000000-0000-4000-8000-00000000000${suffix}`;

  await sql`
    insert into app.tenants (id, slug, name)
    values (${tenantId}::uuid, ${scope}, ${scope})
  `.execute(database.db);
  await sql`
    insert into app.users (tenant_id, id, display_name)
    values (${tenantId}::uuid, ${userId}::uuid, ${`${scope}-user`})
  `.execute(database.db);
  await sql`
    insert into app.business_entity_types (tenant_id, id, code, name)
    values (${tenantId}::uuid, ${typeId}::uuid, 'customer', '客户')
  `.execute(database.db);
  await sql`
    insert into app.business_entities (tenant_id, id, type_id, name)
    values (${tenantId}::uuid, ${entityId}::uuid, ${typeId}::uuid, ${`${scope}-entity`})
  `.execute(database.db);
  await sql`
    insert into app.analysis_runs (
      tenant_id, id, entity_id, rule_version, analyzer_config_version,
      input_version, status, started_at, finished_at, created_by
    ) values (
      ${tenantId}::uuid, ${runId}::uuid, ${entityId}::uuid, 'rules-v1',
      'deterministic-v1', repeat(${suffix}, 64), 'completed',
      '2026-08-31T23:00:00.000Z'::timestamptz,
      '2026-08-31T23:01:00.000Z'::timestamptz, ${userId}::uuid
    )
  `.execute(database.db);
  await sql`
    insert into app.battle_state_versions (
      tenant_id, id, entity_id, version_no, input_version,
      relationship_score, potential_score, quadrant_code, risk_level,
      data_sufficiency, data_gaps, summary, analysis_run_id, effective_at
    ) values (
      ${tenantId}::uuid, ${stateId}::uuid, ${entityId}::uuid, 1,
      repeat(${suffix}, 64), 50, 50, 'develop', 'medium', 'partial', '[]'::jsonb,
      'Synthetic state', ${runId}::uuid,
      '2026-08-31T23:01:00.000Z'::timestamptz
    )
  `.execute(database.db);
  await database.db.transaction().execute(async (transaction) => {
    await sql`
      insert into app.action_proposals (
        tenant_id, id, entity_id, title, description, suggested_owner_id,
        suggested_priority, suggested_planned_at, source_battle_state_version_id,
        status, proposed_at, expires_at, decided_at, decided_by
      ) values (
        ${tenantId}::uuid, ${proposalId}::uuid, ${entityId}::uuid, '推进方案',
        '在计划时间推进', ${userId}::uuid, 'high',
        '2026-09-01T01:00:00.000Z'::timestamptz, ${stateId}::uuid, 'accepted',
        '2026-08-31T23:02:00.000Z'::timestamptz,
        '2026-09-07T23:02:00.000Z'::timestamptz,
        '2026-08-31T23:03:00.000Z'::timestamptz, ${userId}::uuid
      )
    `.execute(transaction);
    await sql`
      insert into app.business_actions (
        tenant_id, id, entity_id, title, description, owner_user_id, priority,
        planned_at, source_proposal_id, confirmed_by, confirmed_at
      ) values (
        ${tenantId}::uuid, ${actionId}::uuid, ${entityId}::uuid, '推进方案',
        '在计划时间推进', ${userId}::uuid, 'high',
        '2026-09-01T01:00:00.000Z'::timestamptz, ${proposalId}::uuid,
        ${userId}::uuid, '2026-08-31T23:03:00.000Z'::timestamptz
      )
    `.execute(transaction);
    await sql`
      insert into app.action_status_history (
        tenant_id, action_id, from_status, to_status, changed_by,
        changed_at, version_no
      ) values (
        ${tenantId}::uuid, ${actionId}::uuid, null, 'planned', ${userId}::uuid,
        '2026-08-31T23:03:00.000Z'::timestamptz, 1
      )
    `.execute(transaction);
  });
}

async function insertPolicy(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    policyId?: string;
    policyKey?: string;
    versionNo?: number;
    nodes?: unknown;
  } = {},
): Promise<void> {
  await sql`
    insert into app.reminder_policy_versions (
      tenant_id, id, policy_key, version_no, name, status, nodes,
      effective_at, published_by
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.policyId ?? POLICY_ALPHA}::uuid,
      ${input.policyKey ?? "default_action_due"}, ${input.versionNo ?? 1},
      '默认动作到期提醒', 'published',
      ${JSON.stringify(
        input.nodes ?? [
          {
            kind: "due",
            offsetMinutes: 0,
            recipient: "owner",
            channels: ["in_app", "feishu"],
          },
        ],
      )}::jsonb,
      '2026-08-31T23:00:00.000Z'::timestamptz, ${USER_ALPHA}::uuid
    )
  `.execute(database.db);
}

async function insertTemplate(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`
    insert into app.notification_template_versions (
      tenant_id, id, template_key, channel, version_no, name, status,
      title_template, body_template, deep_link_template, priority,
      effective_at, published_by
    ) values (
      ${TENANT_ALPHA}::uuid, ${TEMPLATE_ALPHA}::uuid, 'action_due', 'in_app',
      1, '动作到期站内通知', 'published', '经营动作已到计划时间',
      '{{action_title}} 已到计划时间，请及时推进。',
      '/actions?actionId={{action_id}}', 'high',
      '2026-08-31T23:00:00.000Z'::timestamptz, ${USER_ALPHA}::uuid
    )
  `.execute(database.db);
}

async function insertReminder(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    reminderId?: string;
    actionId?: string;
    recipientUserId?: string;
  } = {},
): Promise<void> {
  await sql`
    insert into app.reminder_instances (
      tenant_id, id, action_id, recipient_user_id, policy_version_id,
      action_version_no, kind, remind_at, channels, status, available_at,
      dedupe_key
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.reminderId ?? REMINDER_ALPHA}::uuid,
      ${input.actionId ?? ACTION_ALPHA}::uuid,
      ${input.recipientUserId ?? USER_ALPHA}::uuid, ${POLICY_ALPHA}::uuid,
      1, 'due', '2026-09-01T01:00:00.000Z'::timestamptz,
      '["in_app","feishu"]'::jsonb, 'scheduled',
      '2026-09-01T01:00:00.000Z'::timestamptz,
      'action:d0000000-0000-4000-8000-000000000001:policy:1:due:owner:30000000-0000-4000-8000-000000000001'
    )
  `.execute(database.db);
}

async function insertNotification(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    notificationId?: string;
    dedupeKey?: string;
    deepLink?: string;
    readAt?: string | null;
  } = {},
): Promise<void> {
  await sql`
    insert into app.notification_events (
      tenant_id, id, recipient_user_id, reminder_id, event_type, title, body,
      deep_link, priority, read_at, dedupe_key, created_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.notificationId ?? NOTIFICATION_ALPHA}::uuid,
      ${USER_ALPHA}::uuid, ${REMINDER_ALPHA}::uuid, 'action_due',
      '经营动作已到计划时间', '确认下一步客户经营动作',
      ${input.deepLink ?? `/actions?actionId=${ACTION_ALPHA}`}, 'high',
      ${input.readAt ?? null}::timestamptz,
      ${input.dedupeKey ?? `reminder:${REMINDER_ALPHA}:action_due`},
      '2026-09-01T01:00:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertAddress(
  database: DatabaseHandle<BattlefieldDatabase>,
  scope: "alpha" | "beta",
): Promise<void> {
  const isAlpha = scope === "alpha";
  await sql`
    insert into app.channel_addresses (
      tenant_id, id, user_id, channel, external_user_id
    ) values (
      ${isAlpha ? TENANT_ALPHA : TENANT_BETA}::uuid,
      ${isAlpha ? ADDRESS_ALPHA : "60000000-0000-4000-8000-000000000002"}::uuid,
      ${isAlpha ? USER_ALPHA : USER_BETA}::uuid, 'feishu',
      ${isAlpha ? "ou_alpha_synthetic" : "ou_beta_synthetic"}
    )
  `.execute(database.db);
}

async function insertDelivery(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    deliveryId?: string;
    channel?: "in_app" | "feishu" | "email";
    addressId?: string | null;
    recipientUserId?: string;
    status?: "pending" | "delivered";
  } = {},
): Promise<void> {
  const channel = input.channel ?? "in_app";
  const status = input.status ?? "delivered";
  await sql`
    insert into app.notification_deliveries (
      tenant_id, id, notification_event_id, recipient_user_id, channel,
      address_id, status, dedupe_key, available_at, delivered_at
    ) values (
      ${TENANT_ALPHA}::uuid,
      ${input.deliveryId ?? "73000000-0000-4000-8000-000000000001"}::uuid,
      ${NOTIFICATION_ALPHA}::uuid, ${input.recipientUserId ?? USER_ALPHA}::uuid,
      ${channel}, ${input.addressId ?? null}::uuid,
      ${status}, ${`notification:${NOTIFICATION_ALPHA}:channel:${channel}`},
      '2026-09-01T01:00:00.000Z'::timestamptz,
      ${status === "delivered" ? "2026-09-01T01:00:00.000Z" : null}::timestamptz
    )
  `.execute(database.db);
}
