import { followupDraftCandidateSchema } from "@battlefield/contracts";
import type { FollowupDraftAgent } from "@battlefield/core";

const DEFAULT_BASE_URL = "https://api.senseaudio.cn/v1";
const DEFAULT_MODEL = "senseaudio-s2-flash";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PROMPT_VERSION = "followup-extraction-v1";

export const DEFAULT_FOLLOWUP_EXTRACTION_PROMPT = `你是销售跟进记录拆解助手。只提取用户原文明确表达、可供人工核对的内容，不补写、不猜测。
返回严格符合 JSON Schema 的对象：
- summary：简洁保留进展、风险和下一步；
- followupType：meeting、call、message、email、other 之一；
- facts：原文支持的经营事实，factType 使用小写英文 snake_case，factValue 使用简洁中文。
风险、主观判断和建议不能伪装成已确认事实；无法确定时宁可省略。`;

type Fetch = typeof globalThis.fetch;

interface SenseAudioFollowupDraftAgentOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  prompt?: string;
  promptVersion?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetch?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class SenseAudioFollowupDraftAgentError extends Error {
  constructor(
    readonly code:
      | "upstream_error"
      | "rate_limited"
      | "timeout"
      | "not_configured"
      | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "SenseAudioFollowupDraftAgentError";
  }
}

export class SenseAudioFollowupDraftAgent implements FollowupDraftAgent {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #prompt: string;
  readonly #promptVersion: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #fetch: Fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: SenseAudioFollowupDraftAgentOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#prompt = options.prompt ?? DEFAULT_FOLLOWUP_EXTRACTION_PROMPT;
    this.#promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? wait;
    this.#now = options.now ?? Date.now;
  }

  async propose(input: Parameters<FollowupDraftAgent["propose"]>[0]) {
    const requestBody = JSON.stringify({
      model: this.#model,
      input: [
        { type: "message", role: "system", content: this.#prompt },
        { type: "message", role: "user", content: input.rawInput },
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: 1_200,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "followup_draft_candidate",
          strict: true,
          schema: extractionJsonSchema,
        },
      },
    });
    const startedAt = this.#now();
    const response = await this.#request(requestBody);

    let responseBody: unknown;
    try {
      responseBody = (await response.json()) as unknown;
    } catch {
      throw invalidResponse();
    }
    const completed = extractCompletedResponse(responseBody);
    let extraction: unknown;
    try {
      extraction = JSON.parse(completed.content);
    } catch {
      throw invalidResponse();
    }
    if (!(extraction && typeof extraction === "object")) {
      throw invalidResponse();
    }

    const parsed = followupDraftCandidateSchema.safeParse({
      ...extraction,
      entityId: input.entityId ?? "00000000-0000-4000-8000-000000000000",
      occurredAt: input.occurredAt ?? "1970-01-01T00:00:00.000Z",
      relatedOpportunityIds: [],
      primaryOpportunityId: null,
    });
    if (!parsed.success) {
      throw invalidResponse();
    }

    return {
      summary: parsed.data.summary,
      followupType: parsed.data.followupType,
      relatedOpportunityIds: [],
      facts: parsed.data.facts,
      agentExecution: {
        provider: "senseaudio",
        model: completed.model ?? this.#model,
        promptVersion: this.#promptVersion,
        status: "succeeded" as const,
        providerRequestId: completed.requestId,
        durationMs: Math.max(0, Math.round(this.#now() - startedAt)),
        usage: completed.usage,
      },
    };
  }

  async #request(requestBody: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: requestBody,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt < this.#maxAttempts) {
          await this.#sleep(retryDelay(attempt));
          continue;
        }
        throw transportError(error);
      }

      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.#maxAttempts) {
        await this.#sleep(
          retryAfterMilliseconds(response.headers) ?? retryDelay(attempt),
        );
        continue;
      }
      throw new SenseAudioFollowupDraftAgentError(
        response.status === 429 ? "rate_limited" : "upstream_error",
        `SenseAudio request failed with status ${response.status}.`,
      );
    }
    throw transportError(lastError);
  }
}

const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "followupType", "facts"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 5_000 },
    followupType: {
      type: "string",
      enum: ["meeting", "call", "message", "email", "other"],
    },
    facts: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["factType", "factValue"],
        properties: {
          factType: {
            type: "string",
            pattern: "^[a-z][a-z0-9_.-]{0,99}$",
          },
          factValue: { type: "string", minLength: 1, maxLength: 5_000 },
        },
      },
    },
  },
} as const;

function extractCompletedResponse(responseBody: unknown): {
  content: string;
  requestId: string | null;
  model: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
} {
  if (!(responseBody && typeof responseBody === "object")) {
    throw invalidResponse();
  }
  const body = responseBody as {
    id?: unknown;
    model?: unknown;
    status?: unknown;
    output?: unknown;
    usage?: unknown;
  };
  if (body.status !== "completed") {
    throw invalidResponse();
  }
  if (
    body.output &&
    typeof body.output === "object" &&
    !Array.isArray(body.output) &&
    "content" in body.output &&
    typeof body.output.content === "string"
  ) {
    return {
      content: body.output.content,
      requestId: typeof body.id === "string" ? body.id : null,
      model: typeof body.model === "string" ? body.model : null,
      usage: decodeUsage(body.usage),
    };
  }
  throw invalidResponse();
}

function decodeUsage(value: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null {
  if (value === undefined || value === null) return null;
  if (!(typeof value === "object" && !Array.isArray(value))) {
    throw invalidResponse();
  }
  const usage = value as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
  };
  if (
    !isNonnegativeInteger(usage.input_tokens) ||
    !isNonnegativeInteger(usage.output_tokens) ||
    !isNonnegativeInteger(usage.total_tokens)
  ) {
    throw invalidResponse();
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function invalidResponse(): SenseAudioFollowupDraftAgentError {
  return new SenseAudioFollowupDraftAgentError(
    "invalid_response",
    "SenseAudio returned an invalid structured response.",
  );
}

function retryAfterMilliseconds(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1_000, 60_000);
}

function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 2_000);
}

function transportError(error: unknown): SenseAudioFollowupDraftAgentError {
  const timedOut =
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError");
  return new SenseAudioFollowupDraftAgentError(
    timedOut ? "timeout" : "upstream_error",
    timedOut
      ? "SenseAudio request timed out."
      : "SenseAudio request could not be completed.",
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
