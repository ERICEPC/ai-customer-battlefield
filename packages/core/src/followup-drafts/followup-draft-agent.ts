export interface ActorScope {
  tenantId: string;
  userId: string;
}

export interface FollowupDraftCandidate {
  summary: string;
  relatedOpportunityIds: string[];
}

export interface FollowupDraftAgent {
  propose(input: {
    actor: ActorScope;
    rawInput: string;
  }): Promise<FollowupDraftCandidate>;
}
