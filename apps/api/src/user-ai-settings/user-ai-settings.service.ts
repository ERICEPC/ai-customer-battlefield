import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  senseAudioTextModelIdSchema,
  type TestUserAiConnectionResponse,
  testUserAiConnectionResponseSchema,
  type UpdateUserAiSettingsRequest,
  type UserAiSettingsResponse,
  updateUserAiSettingsRequestSchema,
  userAiSettingsResponseSchema,
} from "@battlefield/contracts";
import {
  type BattlefieldDatabase,
  withTenantTransaction,
} from "@battlefield/database";
import { type Kysely, sql } from "kysely";

const DEFAULT_MODEL = "senseaudio-s2-flash" as const;
const DEFAULT_BASE_URL = "https://api.senseaudio.cn/v1";

type Fetch = typeof globalThis.fetch;

export interface UserAiSettingsActor {
  tenantId: string;
  userId: string;
}

export interface ResolvedUserAiCredential {
  apiKey: string;
  model: ReturnType<typeof senseAudioTextModelIdSchema.parse>;
}

interface SettingsRow {
  model_id: string;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  api_key_auth_tag: string | null;
  api_key_last_four: string | null;
  updated_at: Date;
}

export class UserAiSettingsError extends Error {
  constructor(
    readonly code:
      | "AI_SETTINGS_UNAVAILABLE"
      | "AI_KEY_NOT_CONFIGURED"
      | "AI_CONNECTION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "UserAiSettingsError";
  }
}

export class UserAiSettingsService {
  readonly #database: Kysely<BattlefieldDatabase>;
  readonly #encryptionKey: Buffer;
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  readonly #now: () => number;

  constructor(options: {
    database: Kysely<BattlefieldDatabase>;
    encryptionKey: Buffer;
    baseUrl?: string;
    fetch?: Fetch;
    now?: () => number;
  }) {
    if (options.encryptionKey.byteLength !== 32) {
      throw new Error("AI credential encryption key must be 32 bytes.");
    }
    this.#database = options.database;
    this.#encryptionKey = Buffer.from(options.encryptionKey);
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async get(actor: UserAiSettingsActor): Promise<UserAiSettingsResponse> {
    const row = await this.#readRow(actor);
    return publicSettings(row);
  }

  async update(
    actor: UserAiSettingsActor,
    input: UpdateUserAiSettingsRequest,
  ): Promise<UserAiSettingsResponse> {
    const parsed = updateUserAiSettingsRequestSchema.parse(input);
    const encrypted = parsed.apiKey
      ? encryptApiKey(parsed.apiKey, actor, this.#encryptionKey)
      : null;
    const updatedAt = new Date(this.#now());

    await withTenantTransaction(
      this.#database,
      { ...actor, requestId: randomUUID() },
      async (transaction) => {
        const baseValues = {
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          provider: "senseaudio" as const,
          model_id: parsed.selectedModel,
          api_key_ciphertext: encrypted?.ciphertext ?? null,
          api_key_iv: encrypted?.iv ?? null,
          api_key_auth_tag: encrypted?.authTag ?? null,
          api_key_last_four: encrypted?.lastFour ?? null,
          version_no: 1,
          created_at: updatedAt,
          updated_at: updatedAt,
        };
        const insert = transaction
          .insertInto("app.user_ai_settings")
          .values(baseValues);
        if (encrypted) {
          await insert
            .onConflict((conflict) =>
              conflict.columns(["tenant_id", "user_id"]).doUpdateSet({
                provider: "senseaudio",
                model_id: parsed.selectedModel,
                api_key_ciphertext: encrypted.ciphertext,
                api_key_iv: encrypted.iv,
                api_key_auth_tag: encrypted.authTag,
                api_key_last_four: encrypted.lastFour,
                version_no: sql`app.user_ai_settings.version_no + 1`,
                updated_at: updatedAt,
              }),
            )
            .executeTakeFirstOrThrow();
          return;
        }
        await insert
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "user_id"]).doUpdateSet({
              provider: "senseaudio",
              model_id: parsed.selectedModel,
              version_no: sql`app.user_ai_settings.version_no + 1`,
              updated_at: updatedAt,
            }),
          )
          .executeTakeFirstOrThrow();
      },
    );
    return this.get(actor);
  }

  async resolveCredential(
    actor: UserAiSettingsActor,
  ): Promise<ResolvedUserAiCredential> {
    const row = await this.#readRow(actor);
    if (!row?.api_key_ciphertext || !row.api_key_iv || !row.api_key_auth_tag) {
      throw new UserAiSettingsError(
        "AI_KEY_NOT_CONFIGURED",
        "请先在个人设置中配置 SenseAudio API Key。",
      );
    }
    try {
      return {
        apiKey: decryptApiKey(row, actor, this.#encryptionKey),
        model: senseAudioTextModelIdSchema.parse(row.model_id),
      };
    } catch (error) {
      if (error instanceof UserAiSettingsError) throw error;
      throw new UserAiSettingsError(
        "AI_SETTINGS_UNAVAILABLE",
        "个人 AI 配置暂时无法读取，请重新保存后再试。",
      );
    }
  }

  async testConnection(
    actor: UserAiSettingsActor,
  ): Promise<TestUserAiConnectionResponse> {
    const credential = await this.resolveCredential(actor);
    const startedAt = this.#now();
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: credential.model,
          messages: [
            {
              role: "system",
              content: "你正在执行连接测试。请只回复：连接成功",
            },
            { role: "user", content: "测试连接" },
          ],
          stream: false,
          temperature: 0,
          max_tokens: 32,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new UserAiSettingsError(
        "AI_CONNECTION_FAILED",
        "模型连接失败，请检查网络后重试。",
      );
    }
    if (!response.ok) {
      throw new UserAiSettingsError(
        "AI_CONNECTION_FAILED",
        `模型连接失败（HTTP ${response.status}）。`,
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    const decoded = decodeChatCompletion(payload);
    return testUserAiConnectionResponseSchema.parse({
      ok: true,
      model: credential.model,
      reply: decoded.reply,
      providerRequestId: decoded.requestId,
      durationMs: Math.max(0, Math.round(this.#now() - startedAt)),
    });
  }

  async #readRow(actor: UserAiSettingsActor): Promise<SettingsRow | null> {
    return withTenantTransaction(
      this.#database,
      { ...actor, requestId: randomUUID() },
      async (transaction) =>
        (await transaction
          .selectFrom("app.user_ai_settings")
          .select([
            "model_id",
            "api_key_ciphertext",
            "api_key_iv",
            "api_key_auth_tag",
            "api_key_last_four",
            "updated_at",
          ])
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .executeTakeFirst()) ?? null,
    );
  }
}

function publicSettings(row: SettingsRow | null): UserAiSettingsResponse {
  if (!row) {
    return userAiSettingsResponseSchema.parse({
      selectedModel: DEFAULT_MODEL,
      apiKeyConfigured: false,
      apiKeyLastFour: null,
      updatedAt: null,
    });
  }
  return userAiSettingsResponseSchema.parse({
    selectedModel: row.model_id,
    apiKeyConfigured: Boolean(row.api_key_ciphertext),
    apiKeyLastFour: row.api_key_last_four,
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

function encryptApiKey(
  apiKey: string,
  actor: UserAiSettingsActor,
  encryptionKey: Buffer,
): { ciphertext: string; iv: string; authTag: string; lastFour: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(aad(actor)));
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    lastFour: apiKey.slice(-4),
  };
}

function decryptApiKey(
  row: SettingsRow,
  actor: UserAiSettingsActor,
  encryptionKey: Buffer,
): string {
  if (!(row.api_key_ciphertext && row.api_key_iv && row.api_key_auth_tag)) {
    throw new UserAiSettingsError(
      "AI_KEY_NOT_CONFIGURED",
      "请先在个人设置中配置 SenseAudio API Key。",
    );
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(row.api_key_iv, "base64"),
  );
  decipher.setAAD(Buffer.from(aad(actor)));
  decipher.setAuthTag(Buffer.from(row.api_key_auth_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.api_key_ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function aad(actor: UserAiSettingsActor): string {
  return `${actor.tenantId}:${actor.userId}:senseaudio`;
}

function decodeChatCompletion(value: unknown): {
  reply: string;
  requestId: string | null;
} {
  const body = unwrapProviderPayload(value);
  return {
    reply: extractProviderReply(body) ?? "连接成功",
    requestId: extractProviderRequestId(body),
  };
}

function unwrapProviderPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!(current && typeof current === "object" && !Array.isArray(current))) {
      break;
    }
    const object = current as Record<string, unknown>;
    const nested = object.data ?? object.result ?? object.response;
    if (!(nested && typeof nested === "object")) break;
    current = nested;
  }
  return current;
}

function extractProviderReply(value: unknown): string | null {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return textContent(value);
  }
  const body = value as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const choice = first as Record<string, unknown>;
    if (
      choice.message &&
      typeof choice.message === "object" &&
      !Array.isArray(choice.message)
    ) {
      const message = choice.message as Record<string, unknown>;
      const content =
        textContent(message.content) ?? textContent(message.reasoning_content);
      if (content) return content;
    }
    const choiceText = textContent(choice.text);
    if (choiceText) return choiceText;
  }
  return (
    textContent(body.output_text) ??
    textContent(body.content) ??
    textContent(body.output)
  );
}

function textContent(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (!(part && typeof part === "object" && !Array.isArray(part)))
        return "";
      const object = part as Record<string, unknown>;
      return (
        textContent(object.text) ??
        textContent(object.content) ??
        textContent(object.output_text) ??
        ""
      );
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractProviderRequestId(value: unknown): string | null {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return null;
  }
  const body = value as Record<string, unknown>;
  for (const key of ["id", "request_id", "requestId"]) {
    if (typeof body[key] === "string" && body[key]) return body[key];
  }
  return null;
}
