import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConfiguredFollowupDraftAgent,
  createUserConfiguredFollowupDraftAgent,
} from "../src/followup-drafts/followup-draft.providers.js";

afterEach(() => vi.unstubAllGlobals());

describe("follow-up draft provider configuration", () => {
  it("fails closed instead of presenting deterministic echo as AI when the key is absent", async () => {
    const agent = createConfiguredFollowupDraftAgent({
      NODE_ENV: "development",
    });

    await expect(
      agent.propose({
        actor: { tenantId: "tenant-demo", userId: "user-demo" },
        entityId: "50000000-0000-4000-8000-000000000001",
        rawInput: "客户已确认预算。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("labels explicit deterministic replay so it cannot be mistaken for SenseAudio", async () => {
    const agent = createConfiguredFollowupDraftAgent({
      NODE_ENV: "development",
      FOLLOWUP_AGENT_PROVIDER: "deterministic",
    });

    await expect(
      agent.propose({
        actor: { tenantId: "tenant-demo", userId: "user-demo" },
        entityId: "50000000-0000-4000-8000-000000000001",
        rawInput: "客户已确认预算。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      agentExecution: {
        provider: "deterministic",
        model: "deterministic-followup-v1",
        promptVersion: "deterministic-development-v1",
      },
    });
  });

  it("uses the logged-in user's encrypted credential and selected model before the system fallback", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "request-personal",
          model: "glm-5.3-flash",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "客户已确认预算。",
                  followupType: "meeting",
                  facts: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const agent = createUserConfiguredFollowupDraftAgent(
      {
        resolveRuntimeSelection: vi.fn().mockResolvedValue({
          apiKey: "personal-api-key",
          model: "glm-5.3-flash",
        }),
      } as never,
      { resolve: vi.fn().mockResolvedValue(null) },
      {
        NODE_ENV: "development",
        FOLLOWUP_AGENT_PROVIDER: "senseaudio",
        SENSEAUDIO_API_KEY: "stale-system-key",
      },
    );

    await expect(
      agent.propose({
        actor: { tenantId: "tenant-demo", userId: "user-demo" },
        entityId: "50000000-0000-4000-8000-000000000001",
        rawInput: "客户已确认预算。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      agentExecution: { model: "glm-5.3-flash" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.senseaudio.cn/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer personal-api-key",
        }),
      }),
    );
  });

  it("resolves personal model, tenant prompt, and system key in explicit precedence order", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        id: "request-layered-config",
        model: "qwen3.8-27b",
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "客户已确认预算。",
                followupType: "meeting",
                facts: [],
              }),
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const agent = createUserConfiguredFollowupDraftAgent(
      {
        resolveRuntimeSelection: vi.fn().mockResolvedValue({
          apiKey: null,
          model: "qwen3.8-27b",
        }),
      } as never,
      {
        resolve: vi.fn().mockResolvedValue({
          configId: "a1000000-0000-4000-8000-000000000001",
          configKey: "followup_extraction",
          versionNo: "2",
          releaseNo: "3",
          name: "销售跟进拆解 V2",
          provider: "senseaudio",
          defaultModelId: "glm-5.3-flash",
          systemPrompt: "租户已发布的销售跟进拆解提示词。",
          parameters: { temperature: 0.2, maxTokens: 800 },
          releasedAt: "2026-09-01T05:00:00.000Z",
        }),
      },
      {
        NODE_ENV: "development",
        FOLLOWUP_AGENT_PROVIDER: "senseaudio",
        SENSEAUDIO_API_KEY: "system-api-key",
      },
    );

    await expect(
      agent.propose({
        actor: { tenantId: "tenant-demo", userId: "user-demo" },
        entityId: "50000000-0000-4000-8000-000000000001",
        rawInput: "客户已确认预算。",
        occurredAt: "2026-08-31T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      agentExecution: {
        model: "qwen3.8-27b",
        promptVersion: "followup_extraction-v2-r3",
      },
    });
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: "Bearer system-api-key",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "qwen3.8-27b",
      temperature: 0.2,
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content: "租户已发布的销售跟进拆解提示词。",
        },
        { role: "user", content: "客户已确认预算。" },
      ],
    });
  });
});
