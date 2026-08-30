export interface ActorScope {
  tenantId: string;
  userId: string;
}

export interface FollowupDraftCandidate {
  summary: string;
  relatedOpportunityIds: string[];
  primaryOpportunityId?: string | null;
  facts?: Array<{ factType: string; factValue: string }>;
}

export interface FollowupDraftAgent {
  propose(input: {
    actor: ActorScope;
    entityId?: string;
    rawInput: string;
    occurredAt?: string;
  }): Promise<FollowupDraftCandidate>;
}
