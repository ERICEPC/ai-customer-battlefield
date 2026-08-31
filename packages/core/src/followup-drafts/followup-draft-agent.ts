export interface ActorScope {
  tenantId: string;
  userId: string;
}

export interface FollowupAgentExecutionReceipt {
  provider: string;
  model: string;
  promptVersion: string;
  status: "succeeded";
  providerRequestId: string | null;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
}

export interface FollowupDraftCandidate {
  summary: string;
  followupType?: "meeting" | "call" | "message" | "email" | "other";
  relatedOpportunityIds: string[];
  primaryOpportunityId?: string | null;
  facts?: Array<{ factType: string; factValue: string }>;
  agentExecution?: FollowupAgentExecutionReceipt;
}

export interface FollowupDraftAgent {
  propose(input: {
    actor: ActorScope;
    entityId?: string;
    rawInput: string;
    occurredAt?: string;
  }): Promise<FollowupDraftCandidate>;
}
