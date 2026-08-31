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
        resolveCredential: vi.fn().mockResolvedValue({
          apiKey: "personal-api-key",
          model: "glm-5.3-flash",
        }),
      } as never,
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
});
