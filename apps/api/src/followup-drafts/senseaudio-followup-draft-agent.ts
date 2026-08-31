import { followupDraftCandidateSchema } from "@battlefield/contracts";
import type { FollowupDraftAgent } from "@battlefield/core";

const DEFAULT_BASE_URL = "https://api.senseaudio.cn/v1";
const DEFAULT_MODEL = "senseaudio-s2-flash";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PROMPT_VERSION = "followup-extraction-v1";
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 1_200;

export const DEFAULT_FOLLOWUP_EXTRACTION_PROMPT = `你是销售跟进记录拆解助手。只提取用户原文明确表达、可供人工核对的内容，不补写、不猜测。
只返回一个 JSON 对象，不要使用 Markdown 代码块，也不要附加解释。对象只能包含以下字段：
- summary：简洁保留进展、风险和下一步；
- followupType：meeting、call、message、email、other 之一；
- facts：对象数组，存放原文支持的经营事实；每项只能包含 factType 和 factValue，factType 使用小写英文 snake_case，factValue 使用简洁中文。
风险、主观判断和建议不能伪装成已确认事实；无法确定时宁可省略。`;

type Fetch = typeof globalThis.fetch;

interface SenseAudioFollowupDraftAgentOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  prompt?: string;
  promptVersion?: string;
  temperature?: number;
  maxTokens?: number;
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
  readonly #temperature: number;
  readonly #maxTokens: number;
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
    this.#temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? wait;
    this.#now = options.now ?? Date.now;
  }

  async propose(input: Parameters<FollowupDraftAgent["propose"]>[0]) {
    const requestBody = JSON.stringify({
      model: this.#model,
      messages: [
        { role: "system", content: this.#prompt },
        { role: "user", content: input.rawInput },
      ],
      stream: false,
      temperature: this.#temperature,
      max_tokens: this.#maxTokens,
      response_format: {
        type: "json_object",
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
        response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
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
    choices?: unknown;
    usage?: unknown;
  };
  if (
    Array.isArray(body.choices) &&
    body.choices.length > 0 &&
    body.choices[0] &&
    typeof body.choices[0] === "object" &&
    "message" in body.choices[0] &&
    body.choices[0].message &&
    typeof body.choices[0].message === "object" &&
    "content" in body.choices[0].message &&
    typeof body.choices[0].message.content === "string"
  ) {
    return {
      content: body.choices[0].message.content,
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
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  if (
    !isNonnegativeInteger(usage.prompt_tokens) ||
    !isNonnegativeInteger(usage.completion_tokens) ||
    !isNonnegativeInteger(usage.total_tokens)
  ) {
    throw invalidResponse();
  }
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
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
