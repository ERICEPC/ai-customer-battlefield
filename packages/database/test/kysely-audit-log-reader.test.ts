import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { appendAuditEntry } from "../src/audit/append-audit-entry.js";
import { KyselyAuditLogReader } from "../src/audit/kysely-audit-log-reader.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { KyselyFollowupConfirmationStore } from "../src/followup-confirmation/kysely-followup-confirmation-store.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import {
  createPgliteDatabase,
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_MANAGER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticManagementObserver,
} from "../src/testing/index.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const VISIBLE_DRAFT_ID = "70000000-0000-4000-8000-000000000181";
const HIDDEN_DRAFT_ID = "70000000-0000-4000-8000-000000000182";
const HIDDEN_ENTITY_ID = "50000000-0000-4000-8000-000000000181";
const HIDDEN_OWNER_ID = "30000000-0000-4000-8000-000000000181";
const MANAGER_QUERY_ID = "80000000-0000-4000-8000-000000000181";
const SEED_REQUEST_ID = "90000000-0000-4000-8000-000000000181";
const LIST_REQUEST_ID = "90000000-0000-4000-8000-000000000182";
const ownerActor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_USER_ID,
};
const managerActor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_MANAGER_USER_ID,
};

describe("KyselyAuditLogReader", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let reader: KyselyAuditLogReader;
  let visibleFollowupId: string;
  let hiddenFollowupId: string;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    const followups = new KyselyFollowupConfirmationStore(database.db);
    visibleFollowupId = await createConfirmedFollowup(followups, {
      actor: ownerActor,
      draftId: VISIBLE_DRAFT_ID,
      entityId: SYNTHETIC_ENTITY_ID,
      confirmedAt: "2026-09-01T02:00:00.000Z",
    });
    hiddenFollowupId = await seedHiddenSameTenantFollowup(database, followups);
    await withTenantTransaction(
      database.db,
      { ...managerActor, requestId: SEED_REQUEST_ID },
      async (transaction) => {
        await appendAuditEntry(transaction, {
          tenantId: SYNTHETIC_TENANT_ID,
          actorUserId: SYNTHETIC_USER_ID,
          aggregateType: "followup",
          aggregateId: visibleFollowupId,
          action: "followup.viewed",
          occurredAt: "2026-09-01T03:00:00.000Z",
        });
        await appendAuditEntry(transaction, {
          tenantId: SYNTHETIC_TENANT_ID,
          actorUserId: SYNTHETIC_MANAGER_USER_ID,
          aggregateType: "management_query",
          aggregateId: MANAGER_QUERY_ID,
          action: "management_query.executed",
          occurredAt: "2026-09-01T04:00:00.000Z",
          requestId: "manager-query-request",
        });
      },
    );
    reader = new KyselyAuditLogReader(database.db, {
      requestIdFactory: () => LIST_REQUEST_ID,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("returns only self or currently observed object audits with stable pagination", async () => {
    const first = await reader.list({ actor: managerActor, limit: 2 });
    expect(first.items).toEqual([
      expect.objectContaining({
        aggregateType: "management_query",
        aggregateId: MANAGER_QUERY_ID,
        action: "management_query.executed",
        actor: expect.objectContaining({
          userId: SYNTHETIC_MANAGER_USER_ID,
        }),
        occurredAt: "2026-09-01T04:00:00.000Z",
      }),
      expect.objectContaining({
        aggregateType: "followup",
        aggregateId: visibleFollowupId,
        action: "followup.viewed",
        actor: expect.objectContaining({ userId: SYNTHETIC_USER_ID }),
        requestId: SEED_REQUEST_ID,
        occurredAt: "2026-09-01T03:00:00.000Z",
      }),
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await reader.list({
      actor: managerActor,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items).toEqual([
      expect.objectContaining({
        aggregateType: "followup",
        aggregateId: visibleFollowupId,
        action: "confirmed",
        occurredAt: "2026-09-01T02:00:00.000Z",
      }),
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      [...first.items, ...second.items].some(
        (item) => item.aggregateId === hiddenFollowupId,
      ),
    ).toBe(false);
  });

  test("applies actor, object, action, and half-open time filters", async () => {
    await expect(
      reader.list({
        actor: managerActor,
        limit: 20,
        actorUserId: SYNTHETIC_USER_ID,
        aggregateType: "followup",
        aggregateId: visibleFollowupId,
        action: "followup.viewed",
        occurredFrom: "2026-09-01T02:30:00.000Z",
        occurredBefore: "2026-09-01T04:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      items: [
        {
          aggregateType: "followup",
          aggregateId: visibleFollowupId,
          action: "followup.viewed",
          occurredAt: "2026-09-01T03:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
  });
});

async function createConfirmedFollowup(
  followups: KyselyFollowupConfirmationStore,
  input: {
    actor: typeof ownerActor;
    draftId: string;
    entityId: string;
    confirmedAt: string;
  },
): Promise<string> {
  await followups.create({
    actor: input.actor,
    draftId: input.draftId,
    rawInput: "客户确认预算",
    candidate: {
      entityId: input.entityId,
      summary: "客户确认预算",
      occurredAt: input.confirmedAt,
      followupType: "meeting",
      relatedOpportunityIds: [],
      primaryOpportunityId: null,
      facts: [],
    },
    createdAt: input.confirmedAt,
    expiresAt: "2026-09-08T02:00:00.000Z",
  });
  const result = await followups.confirm({
    actor: input.actor,
    draftId: input.draftId,
    versionNo: "1",
    idempotencyKey: `confirm:${input.draftId}`,
    confirmedAt: input.confirmedAt,
  });
  return result.followupId;
}

async function seedHiddenSameTenantFollowup(
  database: DatabaseHandle<BattlefieldDatabase>,
  followups: KyselyFollowupConfirmationStore,
): Promise<string> {
  await withTenantTransaction(
    database.db,
    { ...ownerActor, requestId: SEED_REQUEST_ID },
    async (transaction) => {
      const type = await transaction
        .selectFrom("app.business_entity_types")
        .select("id")
        .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.users")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: HIDDEN_OWNER_ID,
          display_name: "其他部门销售",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.business_entities")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          id: HIDDEN_ENTITY_ID,
          type_id: type.id,
          name: "其他部门客户",
          is_t0: false,
          updated_at: "2026-09-01T01:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.entity_assignments")
        .values({
          tenant_id: SYNTHETIC_TENANT_ID,
          entity_id: HIDDEN_ENTITY_ID,
          user_id: HIDDEN_OWNER_ID,
          assignment_role: "owner",
          is_primary: true,
          valid_from: "2026-08-31T00:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
    },
  );
  return createConfirmedFollowup(followups, {
    actor: { tenantId: SYNTHETIC_TENANT_ID, userId: HIDDEN_OWNER_ID },
    draftId: HIDDEN_DRAFT_ID,
    entityId: HIDDEN_ENTITY_ID,
    confirmedAt: "2026-09-01T02:30:00.000Z",
  });
}
