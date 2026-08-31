import { fileURLToPath } from "node:url";
import type {
  BattlefieldDatabase,
  DatabaseHandle,
} from "@battlefield/database";
import { migrateDatabase } from "@battlefield/database";
import { createPgliteDatabase } from "@battlefield/database/testing";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UserAiSettingsService } from "../src/user-ai-settings/user-ai-settings.service.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);
const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};

describe("UserAiSettingsService", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await sql`
      insert into app.tenants (id, slug, name)
      values (${actor.tenantId}::uuid, 'alpha', 'Alpha')
    `.execute(database.db);
    await sql`
      insert into app.users (tenant_id, id, display_name, email)
      values (
        ${actor.tenantId}::uuid,
        ${actor.userId}::uuid,
        '销售1',
        'sales1@demo.local'
      )
    `.execute(database.db);
  });

  afterEach(async () => {
    await database.close();
  });

  it("stores a personal key encrypted and only returns masked status", async () => {
    const service = new UserAiSettingsService({
      database: database.db,
      encryptionKey: Buffer.alloc(32, 7),
    });
    const apiKey = "sk-personal-secret-key-1234567890";

    await expect(
      service.update(actor, {
        selectedModel: "senseaudio-s2-flash",
        apiKey,
      }),
    ).resolves.toMatchObject({
      selectedModel: "senseaudio-s2-flash",
      apiKeyConfigured: true,
      apiKeyLastFour: "7890",
    });

    const persisted = await sql<{
      api_key_ciphertext: string;
      api_key_iv: string;
      api_key_auth_tag: string;
    }>`
      select api_key_ciphertext, api_key_iv, api_key_auth_tag
      from app.user_ai_settings
      where tenant_id = ${actor.tenantId}::uuid
        and user_id = ${actor.userId}::uuid
    `.execute(database.db);
    expect(JSON.stringify(persisted.rows)).not.toContain(apiKey);
    await expect(service.get(actor)).resolves.not.toHaveProperty("apiKey");
  });

  it("uses the selected model and decrypted key for a real connection request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        id: "chatcmpl-settings-test",
        model: "glm-5.3-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "连接成功" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const service = new UserAiSettingsService({
      database: database.db,
      encryptionKey: Buffer.alloc(32, 9),
      fetch,
      now: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(1_321),
    });
    await service.update(actor, {
      selectedModel: "glm-5.3-flash",
      apiKey: "sk-personal-secret-key-abcdefghij",
    });

    await expect(service.testConnection(actor)).resolves.toEqual({
      ok: true,
      model: "glm-5.3-flash",
      reply: "连接成功",
      providerRequestId: "chatcmpl-settings-test",
      durationMs: 321,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.senseaudio.cn/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer sk-personal-secret-key-abcdefghij",
        }),
      }),
    );
  });

  it("treats a successful wrapped provider receipt as connected", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        code: 0,
        data: {
          request_id: "senseaudio-wrapped-request",
          model: "senseaudio-s2-flash",
        },
      }),
    );
    const service = new UserAiSettingsService({
      database: database.db,
      encryptionKey: Buffer.alloc(32, 3),
      fetch,
    });
    await service.update(actor, {
      selectedModel: "senseaudio-s2-flash",
      apiKey: "sk-personal-secret-key-wrapped-demo",
    });

    await expect(service.testConnection(actor)).resolves.toMatchObject({
      ok: true,
      reply: "连接成功",
      providerRequestId: "senseaudio-wrapped-request",
    });
  });
});
