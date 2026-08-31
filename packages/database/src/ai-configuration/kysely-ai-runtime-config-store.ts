import { createHash, randomUUID } from "node:crypto";
import {
  AiRuntimeConfigAccessDeniedError,
  type AiRuntimeConfigManager,
  AiRuntimeConfigVersionNotFoundError,
  type AiRuntimeConfigVersionPage,
  type AiRuntimeConfigVersionRecord,
  InvalidAiRuntimeConfigCursorError,
  InvalidAiRuntimeConfigManagementInputError,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import { appendAuditEntry } from "../audit/append-audit-entry.js";
import { actorHasManagementCapability } from "../authorization/management-capabilities.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";
import {
  aiRuntimeIsoString,
  decodeAiRuntimeParameters,
} from "./kysely-ai-runtime-config-reader.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface VersionCursor {
  versionNo: string;
  id: string;
}

export interface KyselyAiRuntimeConfigStoreOptions {
  requestIdFactory?: () => string;
}

export class KyselyAiRuntimeConfigStore implements AiRuntimeConfigManager {
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyAiRuntimeConfigStoreOptions = {},
  ) {
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async listVersions(
    input: Parameters<AiRuntimeConfigManager["listVersions"]>[0],
  ): Promise<AiRuntimeConfigVersionPage> {
    if (!validConfigKey(input.configKey) || !validLimit(input.limit)) {
      throw new InvalidAiRuntimeConfigManagementInputError();
    }
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        await assertConfigurator(transaction, input.actor);
        let query = transaction
          .selectFrom("app.ai_runtime_config_versions")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("config_key", "=", input.configKey);
        if (cursor) {
          query = query.where(
            sql<boolean>`(version_no, id) < (${cursor.versionNo}::bigint, ${cursor.id}::uuid)`,
          );
        }
        const rows = await query
          .orderBy("version_no", "desc")
          .orderBy("id", "desc")
          .limit(input.limit + 1)
          .execute();
        const release = await transaction
          .selectFrom("app.ai_runtime_config_releases")
          .select("version_id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("config_key", "=", input.configKey)
          .executeTakeFirst();
        const hasNextPage = rows.length > input.limit;
        const pageRows = rows.slice(0, input.limit);
        const last = pageRows.at(-1);
        return {
          items: pageRows.map(mapVersion),
          currentVersionId: release?.version_id ?? null,
          nextCursor:
            hasNextPage && last
              ? encodeCursor({
                  versionNo: String(last.version_no),
                  id: last.id,
                })
              : null,
        };
      },
    );
  }

  async createVersion(
    input: Parameters<AiRuntimeConfigManager["createVersion"]>[0],
  ): Promise<AiRuntimeConfigVersionRecord> {
    const normalized = normalizeVersionInput(input);
    const requestId = this.requestIdFactory();
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        await assertConfigurator(transaction, input.actor);
        await lockConfig(transaction, input.actor.tenantId, input.configKey);
        const fingerprint = fingerprintVersion(normalized);
        const existing = await transaction
          .selectFrom("app.ai_runtime_config_versions")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("config_key", "=", input.configKey)
          .where("content_fingerprint", "=", fingerprint)
          .executeTakeFirst();
        if (existing) return mapVersion(existing);
        const latest = await transaction
          .selectFrom("app.ai_runtime_config_versions")
          .select("version_no")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("config_key", "=", input.configKey)
          .orderBy("version_no", "desc")
          .limit(1)
          .executeTakeFirst();
        const createdAt = await currentTimestamp(transaction);
        const created = await transaction
          .insertInto("app.ai_runtime_config_versions")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            config_key: input.configKey,
            version_no: BigInt(String(latest?.version_no ?? 0)) + 1n,
            name: normalized.name,
            provider: "senseaudio",
            default_model_id: normalized.defaultModelId,
            system_prompt: normalized.systemPrompt,
            parameters: JSON.stringify(normalized.parameters),
            content_fingerprint: fingerprint,
            created_by: input.actor.userId,
            created_at: createdAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await appendAuditEntry(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "ai_runtime_config",
          aggregateId: created.id,
          action: "ai_runtime_config.version_created",
          occurredAt: createdAt.toISOString(),
          requestId,
          afterPayload: {
            configKey: input.configKey,
            versionNo: String(created.version_no),
            contentFingerprint: fingerprint,
          },
        });
        return mapVersion(created);
      },
    );
  }

  async releaseVersion(
    input: Parameters<AiRuntimeConfigManager["releaseVersion"]>[0],
  ) {
    if (
      !validConfigKey(input.configKey) ||
      input.reason.trim().length < 1 ||
      input.reason.trim().length > 1_000
    ) {
      throw new InvalidAiRuntimeConfigManagementInputError();
    }
    const requestId = this.requestIdFactory();
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        await assertConfigurator(transaction, input.actor);
        await lockConfig(transaction, input.actor.tenantId, input.configKey);
        const target = await transaction
          .selectFrom("app.ai_runtime_config_versions")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("config_key", "=", input.configKey)
          .where("id", "=", input.versionId)
          .executeTakeFirst();
        if (!target) throw new AiRuntimeConfigVersionNotFoundError();
        const current = await transaction
          .selectFrom("app.ai_runtime_config_releases as release")
          .leftJoin("app.ai_runtime_config_versions as version", (join) =>
            join
              .onRef("version.tenant_id", "=", "release.tenant_id")
              .onRef("version.config_key", "=", "release.config_key")
              .onRef("version.id", "=", "release.version_id"),
          )
          .select([
            "release.version_id",
            "release.release_no",
            "version.version_no as current_version_no",
            "release.released_at",
          ])
          .where("release.tenant_id", "=", input.actor.tenantId)
          .where("release.config_key", "=", input.configKey)
          .executeTakeFirst();
        if (current?.version_id === target.id) {
          return mapReleased(target, {
            releaseNo: String(current.release_no),
            releasedAt: current.released_at,
          });
        }
        const releaseNo = BigInt(String(current?.release_no ?? 0)) + 1n;
        const releasedAt = await currentTimestamp(transaction);
        await transaction
          .insertInto("app.ai_runtime_config_releases")
          .values({
            tenant_id: input.actor.tenantId,
            config_key: input.configKey,
            version_id: target.id,
            release_no: releaseNo,
            released_by: input.actor.userId,
            released_at: releasedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "config_key"]).doUpdateSet({
              version_id: target.id,
              release_no: releaseNo,
              released_by: input.actor.userId,
              released_at: releasedAt,
            }),
          )
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.ai_runtime_config_release_history")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            config_key: input.configKey,
            release_no: releaseNo,
            version_id: target.id,
            released_by: input.actor.userId,
            released_at: releasedAt,
            reason: input.reason.trim(),
          })
          .executeTakeFirstOrThrow();
        const rolledBack =
          current?.current_version_no !== null &&
          current?.current_version_no !== undefined &&
          BigInt(String(target.version_no)) <
            BigInt(String(current.current_version_no));
        await appendAuditEntry(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "ai_runtime_config",
          aggregateId: target.id,
          action: rolledBack
            ? "ai_runtime_config.rolled_back"
            : "ai_runtime_config.released",
          occurredAt: releasedAt.toISOString(),
          requestId,
          beforePayload: current
            ? {
                versionId: current.version_id,
                releaseNo: String(current.release_no),
              }
            : null,
          afterPayload: {
            configKey: input.configKey,
            versionId: target.id,
            versionNo: String(target.version_no),
            releaseNo: String(releaseNo),
          },
          reason: input.reason.trim(),
        });
        return mapReleased(target, {
          releaseNo: String(releaseNo),
          releasedAt,
        });
      },
    );
  }
}

async function assertConfigurator(
  transaction: DatabaseTransaction,
  actor: { tenantId: string; userId: string },
): Promise<void> {
  if (
    !(await actorHasManagementCapability(
      transaction,
      actor,
      "ai_runtime_config.manage",
    ))
  ) {
    throw new AiRuntimeConfigAccessDeniedError();
  }
}

async function lockConfig(
  transaction: DatabaseTransaction,
  tenantId: string,
  configKey: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${configKey}`}))`.execute(
    transaction,
  );
}

function normalizeVersionInput(
  input: Parameters<AiRuntimeConfigManager["createVersion"]>[0],
) {
  const name = input.name.trim();
  const defaultModelId = input.defaultModelId.trim();
  const systemPrompt = input.systemPrompt.trim();
  if (
    !validConfigKey(input.configKey) ||
    name.length < 1 ||
    name.length > 200 ||
    defaultModelId.length < 1 ||
    defaultModelId.length > 200 ||
    systemPrompt.length < 1 ||
    systemPrompt.length > 20_000 ||
    !Number.isFinite(input.parameters.temperature) ||
    input.parameters.temperature < 0 ||
    input.parameters.temperature > 2 ||
    !Number.isInteger(input.parameters.maxTokens) ||
    input.parameters.maxTokens < 1 ||
    input.parameters.maxTokens > 8_000
  ) {
    throw new InvalidAiRuntimeConfigManagementInputError();
  }
  return {
    name,
    defaultModelId,
    systemPrompt,
    parameters: input.parameters,
  };
}

function fingerprintVersion(input: ReturnType<typeof normalizeVersionInput>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: input.name,
        provider: "senseaudio",
        defaultModelId: input.defaultModelId,
        systemPrompt: input.systemPrompt,
        parameters: input.parameters,
      }),
    )
    .digest("hex");
}

function mapVersion(row: {
  id: string;
  config_key: string;
  version_no: string | number | bigint;
  name: string;
  provider: "senseaudio";
  default_model_id: string;
  system_prompt: string;
  parameters: unknown;
  content_fingerprint: string;
  created_by: string;
  created_at: Date | string;
}): AiRuntimeConfigVersionRecord {
  return {
    versionId: row.id,
    configKey: row.config_key,
    versionNo: String(row.version_no),
    name: row.name,
    provider: row.provider,
    defaultModelId: row.default_model_id,
    systemPrompt: row.system_prompt,
    parameters: decodeAiRuntimeParameters(row.parameters),
    contentFingerprint: row.content_fingerprint,
    createdBy: row.created_by,
    createdAt: aiRuntimeIsoString(row.created_at),
  };
}

function mapReleased(
  row: Parameters<typeof mapVersion>[0],
  release: { releaseNo: string; releasedAt: Date | string },
) {
  const version = mapVersion(row);
  return {
    configId: version.versionId,
    configKey: version.configKey,
    versionNo: version.versionNo,
    releaseNo: release.releaseNo,
    name: version.name,
    provider: version.provider,
    defaultModelId: version.defaultModelId,
    systemPrompt: version.systemPrompt,
    parameters: version.parameters,
    releasedAt: aiRuntimeIsoString(release.releasedAt),
  };
}

async function currentTimestamp(transaction: DatabaseTransaction) {
  const row = await sql<{ now: Date }>`select current_timestamp as now`.execute(
    transaction,
  );
  const now = row.rows[0]?.now;
  if (!now) throw new InvalidAiRuntimeConfigManagementInputError();
  return now;
}

function validConfigKey(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,99}$/.test(value);
}

function validLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 100;
}

function encodeCursor(cursor: VersionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): VersionCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("non-canonical encoding");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "id,versionNo"
    ) {
      throw new Error("invalid payload");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.versionNo !== "string" ||
      !/^[1-9][0-9]*$/.test(candidate.versionNo) ||
      typeof candidate.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.id,
      )
    ) {
      throw new Error("invalid values");
    }
    return { versionNo: candidate.versionNo, id: candidate.id };
  } catch (error) {
    throw new InvalidAiRuntimeConfigCursorError({ cause: error });
  }
}
