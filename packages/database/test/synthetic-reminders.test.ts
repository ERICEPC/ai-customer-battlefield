import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";
import {
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "../src/testing/synthetic-directory.js";
import {
  SYNTHETIC_MANAGER_USER_ID,
  seedSyntheticAcceptedAction,
  seedSyntheticManagementObserver,
} from "../src/testing/synthetic-reminders.js";
import { KyselyWorkspaceReader } from "../src/workspace/kysely-workspace-reader.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

describe("synthetic reminder demo data", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticAcceptedAction(database);
  });

  afterEach(async () => {
    await database.close();
  });

  test("publishes the seeded battle state to read-side projections", async () => {
    const workspace = await new KyselyWorkspaceReader(database.db).read({
      actor: {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_USER_ID,
      },
      now: "2026-09-01T12:00:00.000Z",
    });

    expect(workspace.recentBattleChanges).toHaveLength(1);
    expect(workspace.recentBattleChanges[0]).toMatchObject({
      quadrantCode: "develop",
      changeKind: "new_baseline",
    });
    expect(workspace.quadrantDistribution).toEqual([
      { quadrantCode: "develop", count: 1 },
    ]);
  });

  test("offers a management-observer demo identity without granting action ownership", async () => {
    await seedSyntheticManagementObserver(database);
    const workspace = await new KyselyWorkspaceReader(database.db).read({
      actor: {
        tenantId: SYNTHETIC_TENANT_ID,
        userId: SYNTHETIC_MANAGER_USER_ID,
      },
      now: "2026-09-01T12:00:00.000Z",
    });

    expect(workspace.scopeMode).toBe("observed_portfolio");
    expect(workspace.priorityActions).toEqual([
      expect.objectContaining({
        title: "推进正式方案",
        ownerUserId: SYNTHETIC_USER_ID,
      }),
    ]);
    expect(workspace.recentBattleChanges).toEqual([
      expect.objectContaining({ entityName: "Aurora Systems" }),
    ]);
  });
});
