import type { FollowupDraftAgent } from "@battlefield/core";

export class DeterministicFollowupDraftAgent implements FollowupDraftAgent {
  async propose(input: Parameters<FollowupDraftAgent["propose"]>[0]) {
    return {
      summary: input.rawInput,
      relatedOpportunityIds: [],
      agentExecution: {
        provider: "deterministic",
        model: "deterministic-followup-v1",
        promptVersion: "deterministic-development-v1",
        status: "succeeded" as const,
        providerRequestId: null,
        durationMs: 0,
        usage: null,
      },
    };
  }
}
