import { randomUUID } from "node:crypto";
import {
  type AiRuntimeConfig,
  type AiRuntimeConfigReader,
  InvalidAiRuntimeConfigError,
} from "@battlefield/core";
import type { Kysely } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

export interface KyselyAiRuntimeConfigReaderOptions {
  requestIdFactory?: () => string;
}

export class KyselyAiRuntimeConfigReader implements AiRuntimeConfigReader {
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyAiRuntimeConfigReaderOptions = {},
  ) {
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async resolve(
    input: Parameters<AiRuntimeConfigReader["resolve"]>[0],
  ): Promise<AiRuntimeConfig | null> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const row = await transaction
          .selectFrom("app.ai_runtime_config_releases as release")
          .innerJoin("app.ai_runtime_config_versions as version", (join) =>
            join
              .onRef("version.tenant_id", "=", "release.tenant_id")
              .onRef("version.config_key", "=", "release.config_key")
              .onRef("version.id", "=", "release.version_id"),
          )
          .select([
            "version.id as config_id",
            "version.config_key",
            "version.version_no",
            "release.release_no",
            "version.name",
            "version.provider",
            "version.default_model_id",
            "version.system_prompt",
            "version.parameters",
            "release.released_at",
          ])
          .where("release.tenant_id", "=", input.actor.tenantId)
          .where("release.config_key", "=", input.configKey)
          .executeTakeFirst();
        if (!row) return null;
        const parameters = decodeAiRuntimeParameters(row.parameters);
        return {
          configId: row.config_id,
          configKey: row.config_key,
          versionNo: String(row.version_no),
          releaseNo: String(row.release_no),
          name: row.name,
          provider: row.provider,
          defaultModelId: row.default_model_id,
          systemPrompt: row.system_prompt,
          parameters,
          releasedAt: aiRuntimeIsoString(row.released_at),
        };
      },
    );
  }
}

export function decodeAiRuntimeParameters(
  value: unknown,
): AiRuntimeConfig["parameters"] {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      throw new InvalidAiRuntimeConfigError();
    }
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    Object.keys(decoded).sort().join(",") !== "maxTokens,temperature"
  ) {
    throw new InvalidAiRuntimeConfigError();
  }
  const candidate = decoded as Record<string, unknown>;
  if (
    typeof candidate.temperature !== "number" ||
    !Number.isFinite(candidate.temperature) ||
    candidate.temperature < 0 ||
    candidate.temperature > 2 ||
    typeof candidate.maxTokens !== "number" ||
    !Number.isInteger(candidate.maxTokens) ||
    candidate.maxTokens < 1 ||
    candidate.maxTokens > 8_000
  ) {
    throw new InvalidAiRuntimeConfigError();
  }
  return {
    temperature: candidate.temperature,
    maxTokens: candidate.maxTokens,
  };
}

export function aiRuntimeIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidAiRuntimeConfigError();
  return date.toISOString();
}
