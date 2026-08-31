import { describe, expect, it, vi } from "vitest";

import { SenseAudioFollowupDraftAgent } from "../src/followup-drafts/senseaudio-followup-draft-agent.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const entityId = "50000000-0000-4000-8000-000000000001";

describe("SenseAudioFollowupDraftAgent", () => {
  it("requests strict structured output and returns a review-only candidate", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        id: "chatcmpl-demo",
        object: "chat.completion",
        model: "senseaudio-s2-flash",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "客户已确认预算，下周三前需要方案与排期。",
                followupType: "call",
                facts: [
                  { factType: "budget_status", factValue: "预算已确认" },
                  {
                    factType: "next_step",
                    factValue: "下周三前提交方案与排期",
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      }),
    );
    const agent = new SenseAudioFollowupDraftAgent({
      apiKey: "test-api-key",
      model: "senseaudio-s2-flash",
      promptVersion: "followup-extraction-v1",
      fetch,
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(2_234),
    });

    await expect(
      agent.propose({
        actor,
        entityId,
        rawInput:
          "刚给客户打完电话，预算确认了，让我们下周三前发方案和实施排期。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).resolves.toEqual({
      summary: "客户已确认预算，下周三前需要方案与排期。",
      followupType: "call",
      relatedOpportunityIds: [],
      facts: [
        { factType: "budget_status", factValue: "预算已确认" },
        { factType: "next_step", factValue: "下周三前提交方案与排期" },
      ],
      agentExecution: {
        provider: "senseaudio",
        model: "senseaudio-s2-flash",
        promptVersion: "followup-extraction-v1",
        status: "succeeded",
        providerRequestId: "chatcmpl-demo",
        durationMs: 1234,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.senseaudio.cn/v1/chat/completions");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-api-key",
      "content-type": "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "senseaudio-s2-flash",
      stream: false,
      response_format: {
        type: "json_object",
      },
    });
    expect(JSON.parse(String(init.body)).messages).toEqual([
      expect.objectContaining({ role: "system" }),
      {
        role: "user",
        content:
          "刚给客户打完电话，预算确认了，让我们下周三前发方案和实施排期。",
      },
    ]);
  });

  it("retries a rate-limited request once without losing the input", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "rate limited" } },
          { status: 429, headers: { "retry-after": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  summary: "客户预算已确认。",
                  followupType: "call",
                  facts: [
                    { factType: "budget_status", factValue: "预算已确认" },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const agent = new SenseAudioFollowupDraftAgent({
      apiKey: "test-api-key",
      fetch,
      maxAttempts: 2,
      sleep,
    });

    await expect(
      agent.propose({
        actor,
        entityId,
        rawInput: "电话中客户确认预算。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({ summary: "客户预算已确认。" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rejects structured output with fields outside the review contract", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "客户预算已确认。",
                followupType: "call",
                facts: [],
                autoCommit: true,
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const agent = new SenseAudioFollowupDraftAgent({
      apiKey: "test-api-key",
      fetch,
      maxAttempts: 1,
    });

    await expect(
      agent.propose({
        actor,
        entityId,
        rawInput: "客户预算已确认。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("classifies a successful non-JSON response as invalid structured output", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const agent = new SenseAudioFollowupDraftAgent({
      apiKey: "test-api-key",
      fetch,
      maxAttempts: 1,
    });

    await expect(
      agent.propose({
        actor,
        entityId,
        rawInput: "客户预算已确认。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("classifies a timed-out request without exposing transport details", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("provider detail", "AbortError"));
    const agent = new SenseAudioFollowupDraftAgent({
      apiKey: "test-api-key",
      fetch,
      maxAttempts: 1,
    });

    await expect(
      agent.propose({
        actor,
        entityId,
        rawInput: "客户预算已确认。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "timeout",
      message: "SenseAudio request timed out.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("recognizes the TimeoutError emitted by AbortSignal.timeout", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("provider detail", "TimeoutError"));
    const agent = new SenseAudioFollowupDraftAgent({
      apiKey: "test-api-key",
      fetch,
      maxAttempts: 1,
    });

    await expect(
      agent.propose({
        actor,
        entityId,
        rawInput: "客户预算已确认。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "timeout",
      message: "SenseAudio request timed out.",
    });
  });
});
