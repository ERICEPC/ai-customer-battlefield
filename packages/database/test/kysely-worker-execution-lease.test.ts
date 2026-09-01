import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";
import { KyselyWorkerExecutionLeaseStore } from "../src/worker-operations/kysely-worker-execution-lease-store.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";
const INSTANCE_A = "d3000000-0000-4000-8000-000000000001";
const INSTANCE_B = "d3000000-0000-4000-8000-000000000002";
const actor = { tenantId: TENANT_ID, userId: USER_ID };

describe("KyselyWorkerExecutionLeaseStore", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let store: KyselyWorkerExecutionLeaseStore;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await database.db
      .insertInto("app.tenants")
      .values({ id: TENANT_ID, slug: "alpha", name: "Alpha" })
      .executeTakeFirstOrThrow();
    store = new KyselyWorkerExecutionLeaseStore(database.db);
  });

  afterEach(async () => {
    await database.close();
  });

  test("keeps one active instance, supports renewal, expiry takeover, and release", async () => {
    await expect(
      store.acquire({
        actor,
        workerKey: "reminder_worker",
        instanceId: INSTANCE_A,
        observedAt: "2026-09-01T09:00:00.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true);
    await expect(
      store.acquire({
        actor,
        workerKey: "reminder_worker",
        instanceId: INSTANCE_B,
        observedAt: "2026-09-01T09:00:30.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(false);
    await expect(
      store.renew({
        actor,
        workerKey: "reminder_worker",
        instanceId: INSTANCE_A,
        observedAt: "2026-09-01T09:00:40.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true);
    await expect(
      store.acquire({
        actor,
        workerKey: "reminder_worker",
        instanceId: INSTANCE_B,
        observedAt: "2026-09-01T09:01:20.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(false);
    await expect(
      store.acquire({
        actor,
        workerKey: "reminder_worker",
        instanceId: INSTANCE_B,
        observedAt: "2026-09-01T09:01:41.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true);
    await expect(
      store.renew({
        actor,
        workerKey: "reminder_worker",
        instanceId: INSTANCE_A,
        observedAt: "2026-09-01T09:01:42.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(false);

    await store.release({
      actor,
      workerKey: "reminder_worker",
      instanceId: INSTANCE_A,
    });
    await expect(
      store.renew({
        actor,
        workerKey: "reminder_worker",
        instanceId: INSTANCE_B,
        observedAt: "2026-09-01T09:01:43.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true);
    await store.release({
      actor,
      workerKey: "reminder_worker",
      instanceId: INSTANCE_B,
    });
    await expect(
      store.acquire({
        actor,
        workerKey: "reminder_worker",
        instanceId: INSTANCE_A,
        observedAt: "2026-09-01T09:01:44.000Z",
        leaseMs: 60_000,
      }),
    ).resolves.toBe(true);
  });
});
