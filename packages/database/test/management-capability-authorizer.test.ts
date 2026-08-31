import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { actorHasManagementCapability } from "../src/authorization/management-capabilities.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import {
  createPgliteDatabase,
  SYNTHETIC_MANAGER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticManagementObserver,
  seedSyntheticTwoLevelIdentity,
} from "../src/testing/index.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const REQUEST_ID = "90000000-0000-4000-8000-000000000215";

describe("actorHasManagementCapability", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    await seedSyntheticTwoLevelIdentity(database);
  });

  afterEach(async () => {
    await database.close();
  });

  test("requires both a current membership and its tenant role grant", async () => {
    await expect(hasCapability(SYNTHETIC_MANAGER_USER_ID)).resolves.toBe(true);
    await expect(hasCapability(SYNTHETIC_USER_ID)).resolves.toBe(false);

    await withTenantTransaction(
      database.db,
      {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_MANAGER_USER_ID,
        requestId: REQUEST_ID,
      },
      (transaction) =>
        transaction
          .deleteFrom("app.role_capability_grants")
          .where("tenant_id", "=", SYNTHETIC_TENANT_ID)
          .where("role_code", "=", "department_leader")
          .where("capability_code", "=", "worker_operations.manage")
          .executeTakeFirstOrThrow(),
    );
    await expect(hasCapability(SYNTHETIC_MANAGER_USER_ID)).resolves.toBe(false);
  });

  async function hasCapability(userId: string): Promise<boolean> {
    return withTenantTransaction(
      database.db,
      { tenantId: SYNTHETIC_TENANT_ID, userId, requestId: REQUEST_ID },
      (transaction) =>
        actorHasManagementCapability(
          transaction,
          { tenantId: SYNTHETIC_TENANT_ID, userId },
          "worker_operations.manage",
        ),
    );
  }
});
