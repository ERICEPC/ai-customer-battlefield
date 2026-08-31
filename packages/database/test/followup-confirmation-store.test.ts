import { fileURLToPath } from "node:url";
import {
  type FollowupAgentExecutionReceipt,
  FollowupDraftExpiredError,
  FollowupDraftNotFoundError,
  type FollowupDraftNotPendingError,
  type FollowupDraftVersionConflictError,
  FollowupIdempotencyConflictError,
  FollowupNotFoundError,
  type FollowupRelatedRecordNotFoundError,
  type PersistentFollowupDraftCandidate,
} from "@battlefield/core";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { KyselyFollowupConfirmationStore } from "../src/followup-confirmation/kysely-followup-confirmation-store.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";
import {
  SYNTHETIC_OTHER_TENANT_ID,
  SYNTHETIC_OTHER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "../src/testing/synthetic-directory.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const ENTITY_ID = "50000000-0000-4000-8000-000000000001";
const DRAFT_ID = "70000000-0000-4000-8000-000000000001";
const OTHER_DRAFT_ID = "70000000-0000-4000-8000-000000000002";
const REQUEST_ID = "90000000-0000-4000-8000-000000000001";
const OBSERVER_USER_ID = "30000000-0000-4000-8000-000000000071";
const UNASSIGNED_USER_ID = "30000000-0000-4000-8000-000000000072";
const CREATED_AT = "2026-08-31T02:30:00.000Z";
const EXPIRES_AT = "2026-09-07T02:30:00.000Z";
const actor = { tenantId: SYNTHETIC_TENANT_ID, userId: SYNTHETIC_USER_ID };
const agentExecution: FollowupAgentExecutionReceipt = {
  provider: "senseaudio",
  model: "senseaudio-s2-flash",
  promptVersion: "followup-extraction-v1",
  status: "succeeded",
  providerRequestId: "resp-demo",
  durationMs: 1234,
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
};
const otherActor = {
  tenantId: SYNTHETIC_OTHER_TENANT_ID,
  userId: SYNTHETIC_OTHER_USER_ID,
};

describe("KyselyFollowupConfirmationStore", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let store: KyselyFollowupConfirmationStore;
  let opportunityId: string;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    opportunityId = await withTenantTransaction(
      database.db,
      { ...actor, requestId: REQUEST_ID },
      async (transaction) => {
        const result = await transaction
          .selectFrom("app.opportunities")
          .select("id")
          .where("tenant_id", "=", actor.tenantId)
          .where("entity_id", "=", ENTITY_ID)
          .executeTakeFirstOrThrow();
        return result.id;
      },
    );
    store = new KyselyFollowupConfirmationStore(database.db);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates and reads a tenant-scoped source, draft, and initial revision", async () => {
    const created = await createDraft(store, candidate(), { agentExecution });

    expect(created).toMatchObject({
      draftId: DRAFT_ID,
      status: "pending_confirmation",
      versionNo: "1",
      rawInput: "客户确认预算",
      candidate: candidate(),
      agentExecution,
    });
    expect(await store.get({ actor, draftId: DRAFT_ID })).toEqual(created);
    await expect(
      store.get({ actor: otherActor, draftId: DRAFT_ID }),
    ).rejects.toBeInstanceOf(FollowupDraftNotFoundError);

    const counts = await tableCounts(database, [
      "source_inputs",
      "followup_drafts",
      "draft_revisions",
    ]);
    expect(counts).toEqual({
      source_inputs: 1,
      followup_drafts: 1,
      draft_revisions: 1,
    });
  });

  test("rejects an entity or opportunity outside the actor's tenant", async () => {
    await expect(
      createDraft(store, {
        ...candidate(),
        entityId: "50000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toMatchObject<Partial<FollowupRelatedRecordNotFoundError>>({
      recordType: "entity",
    });

    await expect(
      createDraft(store, {
        ...candidate(),
        relatedOpportunityIds: ["70000000-0000-4000-8000-000000000099"],
        primaryOpportunityId: "70000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject<Partial<FollowupRelatedRecordNotFoundError>>({
      recordType: "opportunity",
    });
  });

  test("revises with optimistic locking and preserves every revision", async () => {
    await createDraft(store, candidate(), { agentExecution });
    const revisedCandidate = {
      ...candidate(),
      summary: "客户确认预算并要求下周提交方案",
      facts: [{ factType: "budget_status", factValue: "预算已确认" }],
    };

    const revised = await store.revise({
      actor,
      draftId: DRAFT_ID,
      versionNo: "1",
      candidate: revisedCandidate,
      changedAt: "2026-08-31T02:32:00.000Z",
    });
    expect(revised).toMatchObject({
      candidate: revisedCandidate,
      agentExecution,
      versionNo: "2",
    });
    await expect(
      store.revise({
        actor,
        draftId: DRAFT_ID,
        versionNo: "1",
        candidate: revisedCandidate,
        changedAt: "2026-08-31T02:33:00.000Z",
      }),
    ).rejects.toMatchObject<Partial<FollowupDraftVersionConflictError>>({
      latestVersionNo: "2",
    });

    const counts = await tableCounts(database, ["draft_revisions"]);
    expect(counts.draft_revisions).toBe(2);
  });

  test("cancels idempotently and rejects later terminal mutations", async () => {
    await createDraft(store, candidate());
    const input = {
      actor,
      draftId: DRAFT_ID,
      versionNo: "1",
      idempotencyKey: "cancel-draft-001",
      cancelledAt: "2026-08-31T02:34:00.000Z",
    };

    const cancelled = await store.cancel(input);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      versionNo: "2",
      cancelledAt: input.cancelledAt,
    });
    expect(await store.cancel(input)).toEqual(cancelled);
    await expect(
      store.confirm({
        actor,
        draftId: DRAFT_ID,
        versionNo: "2",
        idempotencyKey: "confirm-cancelled-draft",
        confirmedAt: "2026-08-31T02:35:00.000Z",
      }),
    ).rejects.toMatchObject<Partial<FollowupDraftNotPendingError>>({
      status: "cancelled",
    });
  });

  test("confirms once and atomically writes fact, evidence, audit, event, and Outbox", async () => {
    const draftCandidate = candidate({
      relatedOpportunityIds: [opportunityId],
      primaryOpportunityId: opportunityId,
      facts: [{ factType: "budget_status", factValue: "预算已确认" }],
    });
    await createDraft(store, draftCandidate);
    const input = {
      actor,
      draftId: DRAFT_ID,
      versionNo: "1",
      idempotencyKey: "confirm-draft-001",
      confirmedAt: "2026-08-31T02:35:00.000Z",
    };

    const confirmed = await store.confirm(input);
    expect(confirmed).toMatchObject({
      draftId: DRAFT_ID,
      status: "confirmed",
      versionNo: "2",
      confirmedAt: input.confirmedAt,
    });
    expect(await store.confirm(input)).toEqual(confirmed);
    expect(await store.get({ actor, draftId: DRAFT_ID })).toMatchObject({
      status: "confirmed",
      versionNo: "2",
      followupId: confirmed.followupId,
      confirmedBy: actor.userId,
    });
    expect(
      await store.getFollowup({ actor, followupId: confirmed.followupId }),
    ).toMatchObject({
      followupId: confirmed.followupId,
      sourceDraftId: DRAFT_ID,
      entityId: ENTITY_ID,
      facts: [
        {
          factType: "budget_status",
          factValue: "预算已确认",
          opportunityId,
        },
      ],
    });

    const counts = await tableCounts(database, [
      "followups",
      "followup_participants",
      "followup_opportunities",
      "business_facts",
      "source_evidence",
      "fact_evidence_links",
      "audit_entries",
      "domain_events",
      "outbox_messages",
      "idempotency_records",
    ]);
    expect(counts).toEqual({
      followups: 1,
      followup_participants: 1,
      followup_opportunities: 1,
      business_facts: 1,
      source_evidence: 1,
      fact_evidence_links: 1,
      audit_entries: 2,
      domain_events: 1,
      outbox_messages: 1,
      idempotency_records: 1,
    });
    expect(await readConfirmedOutboxPayload(database)).toMatchObject({
      eventId: confirmed.eventId,
      followupId: confirmed.followupId,
      draftId: DRAFT_ID,
      entityId: ENTITY_ID,
      versionNo: "1",
    });
    expect(
      await readFollowupAccessAudits(database, confirmed.followupId),
    ).toEqual([
      expect.objectContaining({
        action: "followup.viewed",
        actor_user_id: actor.userId,
        after_payload: expect.objectContaining({ accessScope: "owner" }),
      }),
    ]);
  });

  test("authorizes formal follow-up reads by current responsibility and audits allowed or denied access", async () => {
    await createDraft(store, candidate());
    const confirmed = await store.confirm({
      actor,
      draftId: DRAFT_ID,
      versionNo: "1",
      idempotencyKey: "confirm-access-controlled-followup",
      confirmedAt: "2026-08-31T02:35:00.000Z",
    });
    await seedFollowupAccessActors(database);

    await expect(
      store.getFollowup({
        actor: { tenantId: actor.tenantId, userId: OBSERVER_USER_ID },
        followupId: confirmed.followupId,
      }),
    ).resolves.toMatchObject({ followupId: confirmed.followupId });
    await expect(
      store.getFollowup({
        actor: { tenantId: actor.tenantId, userId: UNASSIGNED_USER_ID },
        followupId: confirmed.followupId,
      }),
    ).rejects.toBeInstanceOf(FollowupNotFoundError);

    expect(
      await readFollowupAccessAudits(database, confirmed.followupId),
    ).toEqual([
      expect.objectContaining({
        action: "followup.viewed",
        actor_user_id: OBSERVER_USER_ID,
        after_payload: expect.objectContaining({
          accessScope: "management_observer",
          outcome: "allowed",
        }),
      }),
      expect.objectContaining({
        action: "followup.view_denied",
        actor_user_id: UNASSIGNED_USER_ID,
        after_payload: expect.objectContaining({ outcome: "denied" }),
        reason: "outside_authorized_scope_or_missing",
      }),
    ]);
  });

  test("rejects reuse of an idempotency key for a different confirmation", async () => {
    await createDraft(store, candidate());
    await store.confirm({
      actor,
      draftId: DRAFT_ID,
      versionNo: "1",
      idempotencyKey: "confirm-draft-001",
      confirmedAt: "2026-08-31T02:35:00.000Z",
    });

    await expect(
      store.confirm({
        actor,
        draftId: DRAFT_ID,
        versionNo: "2",
        idempotencyKey: "confirm-draft-001",
        confirmedAt: "2026-08-31T02:35:00.000Z",
      }),
    ).rejects.toBeInstanceOf(FollowupIdempotencyConflictError);
  });

  test("rejects confirmation after expiry without creating formal rows", async () => {
    await createDraft(store, candidate(), {
      expiresAt: "2026-08-31T02:31:00.000Z",
    });

    await expect(
      store.confirm({
        actor,
        draftId: DRAFT_ID,
        versionNo: "1",
        idempotencyKey: "confirm-expired-draft",
        confirmedAt: "2026-08-31T02:35:00.000Z",
      }),
    ).rejects.toBeInstanceOf(FollowupDraftExpiredError);
    expect((await tableCounts(database, ["followups"])).followups).toBe(0);
  });

  test("rolls back the whole confirmation when the final Outbox write conflicts", async () => {
    await createDraft(
      store,
      candidate({
        facts: [{ factType: "budget_status", factValue: "预算已确认" }],
      }),
    );
    await reserveOutboxDedupeKey(database);

    await expect(
      store.confirm({
        actor,
        draftId: DRAFT_ID,
        versionNo: "1",
        idempotencyKey: "confirm-with-outbox-conflict",
        confirmedAt: "2026-08-31T02:35:00.000Z",
      }),
    ).rejects.toThrow();
    expect(await store.get({ actor, draftId: DRAFT_ID })).toMatchObject({
      status: "pending_confirmation",
      versionNo: "1",
    });
    const counts = await tableCounts(database, [
      "followups",
      "business_facts",
      "audit_entries",
      "idempotency_records",
    ]);
    expect(counts).toEqual({
      followups: 0,
      business_facts: 0,
      audit_entries: 0,
      idempotency_records: 0,
    });
  });

  test("reports not found for a draft that does not exist", async () => {
    await expect(
      store.get({ actor, draftId: OTHER_DRAFT_ID }),
    ).rejects.toBeInstanceOf(FollowupDraftNotFoundError);
  });
});

function candidate(
  overrides: Partial<PersistentFollowupDraftCandidate> = {},
): PersistentFollowupDraftCandidate {
  return {
    entityId: ENTITY_ID,
    summary: "客户确认预算",
    occurredAt: CREATED_AT,
    followupType: "meeting",
    relatedOpportunityIds: [],
    primaryOpportunityId: null,
    facts: [],
    ...overrides,
  };
}

async function readConfirmedOutboxPayload(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<Record<string, unknown>> {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId: "90000000-0000-4000-8000-000000000092" },
    async (transaction) => {
      const row = await transaction
        .selectFrom("app.outbox_messages")
        .select("payload")
        .where("topic", "=", "followup.confirmed.v1")
        .executeTakeFirstOrThrow();
      return (
        typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
      ) as Record<string, unknown>;
    },
  );
}

async function seedFollowupAccessActors(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .insertInto("app.users")
        .values([
          {
            tenant_id: actor.tenantId,
            id: OBSERVER_USER_ID,
            display_name: "alpha-manager",
          },
          {
            tenant_id: actor.tenantId,
            id: UNASSIGNED_USER_ID,
            display_name: "alpha-unassigned",
          },
        ])
        .execute();
      await transaction
        .insertInto("app.entity_assignments")
        .values({
          tenant_id: actor.tenantId,
          entity_id: ENTITY_ID,
          user_id: OBSERVER_USER_ID,
          assignment_role: "management_observer",
          is_primary: false,
          valid_from: "2026-08-30T00:00:00.000Z",
          valid_to: null,
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function readFollowupAccessAudits(
  database: DatabaseHandle<BattlefieldDatabase>,
  followupId: string,
) {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    (transaction) =>
      transaction
        .selectFrom("app.audit_entries")
        .select(["action", "actor_user_id", "after_payload", "reason"])
        .where("tenant_id", "=", actor.tenantId)
        .where("aggregate_type", "=", "followup")
        .where("aggregate_id", "=", followupId)
        .where("action", "in", ["followup.viewed", "followup.view_denied"])
        .orderBy("occurred_at")
        .orderBy("id")
        .execute(),
  );
}

async function createDraft(
  targetStore: KyselyFollowupConfirmationStore,
  draftCandidate: PersistentFollowupDraftCandidate,
  overrides: {
    expiresAt?: string;
    agentExecution?: FollowupAgentExecutionReceipt;
  } = {},
) {
  return targetStore.create({
    actor,
    draftId: DRAFT_ID,
    rawInput: "客户确认预算",
    candidate: draftCandidate,
    ...(overrides.agentExecution
      ? { agentExecution: overrides.agentExecution }
      : {}),
    createdAt: CREATED_AT,
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
  });
}

async function tableCounts(
  database: DatabaseHandle<BattlefieldDatabase>,
  tables: string[],
): Promise<Record<string, number>> {
  return withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const result: Record<string, number> = {};
      for (const table of tables) {
        const count = await sql<{ count: number }>`
          select count(*)::int as count
          from ${sql.table(`app.${table}`)}
          where tenant_id = ${actor.tenantId}::uuid
        `.execute(transaction);
        result[table] = count.rows[0]?.count ?? 0;
      }
      return result;
    },
  );
}

async function reserveOutboxDedupeKey(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      const eventId = "91000000-0000-4000-8000-000000000001";
      await sql`
        insert into app.domain_events (
          tenant_id, id, aggregate_type, aggregate_id, event_type,
          event_version, payload, occurred_at
        ) values (
          ${actor.tenantId}::uuid,
          ${eventId}::uuid,
          'test',
          ${DRAFT_ID}::uuid,
          'test.reserved.v1',
          1,
          '{}'::jsonb,
          ${CREATED_AT}::timestamptz
        )
      `.execute(transaction);
      await sql`
        insert into app.outbox_messages (
          tenant_id, id, event_id, topic, payload, dedupe_key, available_at
        ) values (
          ${actor.tenantId}::uuid,
          '92000000-0000-4000-8000-000000000001'::uuid,
          ${eventId}::uuid,
          'test.reserved.v1',
          '{}'::jsonb,
          ${`followup.confirmed:${DRAFT_ID}`},
          ${CREATED_AT}::timestamptz
        )
      `.execute(transaction);
    },
  );
}
