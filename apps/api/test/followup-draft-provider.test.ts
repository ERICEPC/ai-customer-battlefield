import { describe, expect, it } from "vitest";

import { createConfiguredFollowupDraftAgent } from "../src/followup-drafts/followup-draft.providers.js";

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
});
