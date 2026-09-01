import { fileURLToPath } from "node:url";
import {
  BattleRuleAccessDeniedError,
  defaultBattleRuleSet,
  InvalidBattleRuleSetError,
} from "@battlefield/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { KyselyBattleRuleStore } from "../src/battle-rules/kysely-battle-rule-store.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import {
  createPgliteDatabase,
  SYNTHETIC_MANAGER_USER_ID,
  SYNTHETIC_OTHER_TENANT_ID,
  SYNTHETIC_OTHER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticManagementObserver,
  seedSyntheticTwoLevelIdentity,
} from "../src/testing/index.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const REQUEST_ID = "90000000-0000-4000-8000-000000000221";
const actor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_USER_ID,
};
const managerActor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_MANAGER_USER_ID,
};

describe("KyselyBattleRuleStore", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let store: KyselyBattleRuleStore;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    await seedSyntheticTwoLevelIdentity(database);
    store = new KyselyBattleRuleStore(database.db, {
      requestIdFactory: () => REQUEST_ID,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("seeds and resolves one independent default release for every tenant", async () => {
    await expect(store.resolve({ actor })).resolves.toEqual({
      ruleVersion: "battle-rules-v1-r1",
      rules: defaultBattleRuleSet,
    });
    await expect(
      store.resolve({
        actor: {
          tenantId: SYNTHETIC_OTHER_TENANT_ID,
          userId: SYNTHETIC_OTHER_USER_ID,
        },
      }),
    ).resolves.toEqual({
      ruleVersion: "battle-rules-v1-r1",
      rules: defaultBattleRuleSet,
    });
  });

  test("creates immutable versions, publishes changes, and rolls back by a new release", async () => {
    const firstPage = await store.listVersions({
      actor: managerActor,
      limit: 20,
    });
    expect(firstPage).toMatchObject({
      currentVersionId: firstPage.items[0]?.versionId,
      currentReleaseNo: "1",
      items: [{ versionNo: "1", name: "默认确定性作战规则 V1" }],
    });
    const versionTwoInput = {
      actor: managerActor,
      name: "重点客户加速规则",
      rules: {
        ...defaultBattleRuleSet,
        relationshipScore: { base: 55, perFact: 8, maximum: 95 },
      },
    };
    const versionTwo = await store.createVersion(versionTwoInput);
    expect(await store.createVersion(versionTwoInput)).toEqual(versionTwo);
    expect(versionTwo.versionNo).toBe("2");

    await expect(
      store.releaseVersion({
        actor: managerActor,
        versionId: versionTwo.versionId,
        reason: "演示重点客户加速策略",
      }),
    ).resolves.toMatchObject({ versionNo: "2", releaseNo: "2" });
    await expect(store.resolve({ actor })).resolves.toMatchObject({
      ruleVersion: "battle-rules-v2-r2",
      rules: { relationshipScore: { base: 55, perFact: 8, maximum: 95 } },
    });
    await expect(
      store.releaseVersion({
        actor: managerActor,
        versionId: firstPage.items[0]?.versionId ?? "",
        reason: "回滚默认稳定规则",
      }),
    ).resolves.toMatchObject({ versionNo: "1", releaseNo: "3" });

    const audits = await withTenantTransaction(
      database.db,
      { ...managerActor, requestId: REQUEST_ID },
      (transaction) =>
        transaction
          .selectFrom("app.audit_entries")
          .select("action")
          .where("tenant_id", "=", managerActor.tenantId)
          .where("aggregate_type", "=", "battle_rule")
          .orderBy("occurred_at")
          .orderBy("id")
          .execute(),
    );
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      "battle_rule.released",
      "battle_rule.rolled_back",
      "battle_rule.version_created",
    ]);
  });

  test("allows runtime resolution but denies rule management without its capability", async () => {
    await expect(store.resolve({ actor })).resolves.toBeDefined();
    await expect(
      store.createVersion({
        actor,
        name: "销售不应能发布的规则",
        rules: defaultBattleRuleSet,
      }),
    ).rejects.toBeInstanceOf(BattleRuleAccessDeniedError);
  });

  test("fails closed when persisted released JSON does not satisfy the rule schema", async () => {
    const invalidVersionId = "a3000000-0000-4000-8000-000000000099";
    await withTenantTransaction(
      database.db,
      { ...managerActor, requestId: REQUEST_ID },
      async (transaction) => {
        await transaction
          .insertInto("app.battle_rule_versions")
          .values({
            tenant_id: actor.tenantId,
            id: invalidVersionId,
            version_no: 99,
            name: "损坏数据测试",
            rules: JSON.stringify({ relationshipScore: 100 }),
            content_fingerprint: "9".repeat(64),
            created_by: managerActor.userId,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("app.battle_rule_releases")
          .set({ version_id: invalidVersionId })
          .where("tenant_id", "=", actor.tenantId)
          .executeTakeFirstOrThrow();
      },
    );

    await expect(store.resolve({ actor })).rejects.toBeInstanceOf(
      InvalidBattleRuleSetError,
    );
  });
});
