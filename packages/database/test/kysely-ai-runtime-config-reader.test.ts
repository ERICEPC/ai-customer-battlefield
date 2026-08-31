import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { KyselyAiRuntimeConfigReader } from "../src/ai-configuration/kysely-ai-runtime-config-reader.js";
import { KyselyAiRuntimeConfigStore } from "../src/ai-configuration/kysely-ai-runtime-config-store.js";
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
const CONFIG_KEY = "followup_extraction";
const VERSION_ONE_ID = "a1000000-0000-4000-8000-000000000001";
const VERSION_TWO_ID = "a1000000-0000-4000-8000-000000000002";
const REQUEST_ID = "90000000-0000-4000-8000-000000000191";
const actor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_USER_ID,
};
const managerActor = {
  tenantId: SYNTHETIC_TENANT_ID,
  userId: SYNTHETIC_MANAGER_USER_ID,
};

describe("KyselyAiRuntimeConfigReader", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let reader: KyselyAiRuntimeConfigReader;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
    await seedSyntheticTwoLevelIdentity(database);
    reader = new KyselyAiRuntimeConfigReader(database.db, {
      requestIdFactory: () => REQUEST_ID,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("returns null without a release and resolves only the tenant's current release", async () => {
    await expect(
      reader.resolve({ actor, configKey: CONFIG_KEY }),
    ).resolves.toBeNull();
    await seedVersionsAndRelease(database);

    await expect(
      reader.resolve({ actor, configKey: CONFIG_KEY }),
    ).resolves.toEqual({
      configId: VERSION_ONE_ID,
      configKey: CONFIG_KEY,
      versionNo: "1",
      releaseNo: "1",
      name: "销售跟进拆解 V1",
      provider: "senseaudio",
      defaultModelId: "senseaudio-s2-flash",
      systemPrompt: "只提取销售原文明确表达的事实。",
      parameters: { temperature: 0.1, maxTokens: 1200 },
      releasedAt: "2026-09-01T05:00:00.000Z",
    });
    await expect(
      reader.resolve({
        actor: {
          tenantId: SYNTHETIC_OTHER_TENANT_ID,
          userId: SYNTHETIC_OTHER_USER_ID,
        },
        configKey: CONFIG_KEY,
      }),
    ).resolves.toBeNull();
  });

  test("switches releases without mutating immutable versions and supports rollback", async () => {
    await seedVersionsAndRelease(database);
    await releaseVersion(database, VERSION_TWO_ID, 2, "升级 Prompt");
    await expect(
      reader.resolve({ actor, configKey: CONFIG_KEY }),
    ).resolves.toMatchObject({
      configId: VERSION_TWO_ID,
      versionNo: "2",
      releaseNo: "2",
      defaultModelId: "glm-5.3-flash",
    });
    await releaseVersion(database, VERSION_ONE_ID, 3, "回滚到稳定版本");
    await expect(
      reader.resolve({ actor, configKey: CONFIG_KEY }),
    ).resolves.toMatchObject({
      configId: VERSION_ONE_ID,
      versionNo: "1",
      releaseNo: "3",
    });

    await expect(
      withTenantTransaction(
        database.db,
        { ...actor, requestId: REQUEST_ID },
        (transaction) =>
          transaction
            .updateTable("app.ai_runtime_config_versions")
            .set({ system_prompt: "尝试覆盖已建版本" })
            .where("tenant_id", "=", actor.tenantId)
            .where("id", "=", VERSION_ONE_ID)
            .executeTakeFirstOrThrow(),
      ),
    ).rejects.toThrow(/immutable/);
  });

  test("creates deduplicated versions and audits publish or rollback transitions", async () => {
    const store = new KyselyAiRuntimeConfigStore(database.db, {
      requestIdFactory: () => REQUEST_ID,
    });
    const firstInput = {
      actor: managerActor,
      configKey: CONFIG_KEY,
      name: "销售跟进拆解 V1",
      defaultModelId: "senseaudio-s2-flash",
      systemPrompt: "只提取销售原文明确表达的事实。",
      parameters: { temperature: 0.1, maxTokens: 1200 },
    };
    const first = await store.createVersion(firstInput);
    expect(await store.createVersion(firstInput)).toEqual(first);
    const second = await store.createVersion({
      ...firstInput,
      name: "销售跟进拆解 V2",
      defaultModelId: "glm-5.3-flash",
      systemPrompt: "提取事实，并明确风险与下一步。",
      parameters: { temperature: 0.2, maxTokens: 1600 },
    });
    expect([first.versionNo, second.versionNo]).toEqual(["1", "2"]);
    await expect(
      store.listVersions({
        actor: managerActor,
        configKey: CONFIG_KEY,
        limit: 20,
      }),
    ).resolves.toMatchObject({
      items: [
        { versionId: second.versionId, versionNo: "2" },
        { versionId: first.versionId, versionNo: "1" },
      ],
      currentVersionId: null,
      nextCursor: null,
    });

    await expect(
      store.releaseVersion({
        actor: managerActor,
        configKey: CONFIG_KEY,
        versionId: first.versionId,
        reason: "首次发布",
      }),
    ).resolves.toMatchObject({ versionNo: "1", releaseNo: "1" });
    await expect(
      store.releaseVersion({
        actor: managerActor,
        configKey: CONFIG_KEY,
        versionId: second.versionId,
        reason: "升级 Prompt",
      }),
    ).resolves.toMatchObject({ versionNo: "2", releaseNo: "2" });
    await expect(
      store.releaseVersion({
        actor: managerActor,
        configKey: CONFIG_KEY,
        versionId: first.versionId,
        reason: "回滚稳定版本",
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
          .where("aggregate_type", "=", "ai_runtime_config")
          .orderBy("occurred_at")
          .orderBy("id")
          .execute(),
    );
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      "ai_runtime_config.released",
      "ai_runtime_config.released",
      "ai_runtime_config.rolled_back",
      "ai_runtime_config.version_created",
      "ai_runtime_config.version_created",
    ]);
  });
});

async function seedVersionsAndRelease(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .insertInto("app.ai_runtime_config_versions")
        .values([
          {
            tenant_id: actor.tenantId,
            id: VERSION_ONE_ID,
            config_key: CONFIG_KEY,
            version_no: 1,
            name: "销售跟进拆解 V1",
            provider: "senseaudio",
            default_model_id: "senseaudio-s2-flash",
            system_prompt: "只提取销售原文明确表达的事实。",
            parameters: JSON.stringify({ temperature: 0.1, maxTokens: 1200 }),
            content_fingerprint: "1".repeat(64),
            created_by: actor.userId,
            created_at: "2026-09-01T04:00:00.000Z",
          },
          {
            tenant_id: actor.tenantId,
            id: VERSION_TWO_ID,
            config_key: CONFIG_KEY,
            version_no: 2,
            name: "销售跟进拆解 V2",
            provider: "senseaudio",
            default_model_id: "glm-5.3-flash",
            system_prompt: "提取事实，并明确风险与下一步。",
            parameters: JSON.stringify({ temperature: 0.2, maxTokens: 1600 }),
            content_fingerprint: "2".repeat(64),
            created_by: actor.userId,
            created_at: "2026-09-01T04:30:00.000Z",
          },
        ])
        .execute();
      await transaction
        .insertInto("app.ai_runtime_config_releases")
        .values({
          tenant_id: actor.tenantId,
          config_key: CONFIG_KEY,
          version_id: VERSION_ONE_ID,
          release_no: 1,
          released_by: actor.userId,
          released_at: "2026-09-01T05:00:00.000Z",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.ai_runtime_config_release_history")
        .values({
          tenant_id: actor.tenantId,
          config_key: CONFIG_KEY,
          release_no: 1,
          version_id: VERSION_ONE_ID,
          released_by: actor.userId,
          released_at: "2026-09-01T05:00:00.000Z",
          reason: "首次发布",
        })
        .executeTakeFirstOrThrow();
    },
  );
}

async function releaseVersion(
  database: DatabaseHandle<BattlefieldDatabase>,
  versionId: string,
  releaseNo: number,
  reason: string,
): Promise<void> {
  const releasedAt = `2026-09-01T0${4 + releaseNo}:00:00.000Z`;
  await withTenantTransaction(
    database.db,
    { ...actor, requestId: REQUEST_ID },
    async (transaction) => {
      await transaction
        .updateTable("app.ai_runtime_config_releases")
        .set({
          version_id: versionId,
          release_no: releaseNo,
          released_by: actor.userId,
          released_at: releasedAt,
        })
        .where("tenant_id", "=", actor.tenantId)
        .where("config_key", "=", CONFIG_KEY)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("app.ai_runtime_config_release_history")
        .values({
          tenant_id: actor.tenantId,
          config_key: CONFIG_KEY,
          release_no: releaseNo,
          version_id: versionId,
          released_by: actor.userId,
          released_at: releasedAt,
          reason,
        })
        .executeTakeFirstOrThrow();
    },
  );
}
