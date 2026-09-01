import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type { BattleRuleSet } from "./battle-rule.js";

export type BattleDimension = "relationship" | "potential" | "risk" | "stage";
export type BattleSignalDirection = "positive" | "negative" | "neutral";
export type BattleRiskLevel = "low" | "medium" | "high" | "critical";
export type BattleDataSufficiency = "insufficient" | "partial" | "sufficient";
export type SuggestedActionPriority = "low" | "medium" | "high" | "urgent";

export interface ConfirmedFactSnapshot {
  entityId: string;
  inputVersion: string;
  facts: Array<{
    factId: string;
    factType: string;
    factValue: string;
    occurredAt: string;
    opportunityId: string | null;
  }>;
}

export interface BattleAnalysisCandidate {
  relationshipScore: string | null;
  potentialScore: string | null;
  quadrantCode: string | null;
  primaryOpportunityId: string | null;
  riskLevel: BattleRiskLevel;
  dataSufficiency: BattleDataSufficiency;
  dataGaps: string[];
  summary: string;
  signals: Array<{
    factId: string;
    dimension: BattleDimension;
    direction: BattleSignalDirection;
    strength: number;
    reason: string;
  }>;
  evidenceFactIds: string[];
  actionProposals: Array<{
    title: string;
    description: string;
    suggestedOwnerId: string | null;
    suggestedPriority: SuggestedActionPriority;
    suggestedPlannedAt: string | null;
  }>;
}

export type BattleAnalysisResult =
  | {
      analysisRunId: string;
      entityId: string;
      status: "completed";
      inputVersion: string;
      battleStateVersionId: string;
      battleStateVersionNo: string;
      proposalIds: string[];
      startedAt: string;
      finishedAt: string;
    }
  | {
      analysisRunId: string;
      entityId: string;
      status: "superseded";
      inputVersion: string;
      battleStateVersionId: null;
      battleStateVersionNo: null;
      proposalIds: [];
      startedAt: string;
      finishedAt: string;
    };

export interface ConfirmedFactSnapshotReader {
  read(input: {
    actor: ActorScope;
    entityId: string;
  }): Promise<ConfirmedFactSnapshot>;
}

export interface BattleAnalyzer {
  readonly configurationVersion: string;
  analyze(input: {
    actor: ActorScope;
    snapshot: ConfirmedFactSnapshot;
    ruleVersion: string;
    rules: BattleRuleSet;
  }): Promise<BattleAnalysisCandidate>;
}

export interface BattleAnalysisStore {
  findByTriggerEvent(input: {
    actor: ActorScope;
    triggerEventId: string;
    entityId: string;
  }): Promise<BattleAnalysisResult | null>;
  start(input: {
    actor: ActorScope;
    analysisRunId: string;
    entityId: string;
    inputVersion: string;
    ruleVersion: string;
    analyzerConfigVersion: string;
    startedAt: string;
    triggerEventId?: string;
  }): Promise<void>;
  complete(input: {
    actor: ActorScope;
    analysisRunId: string;
    inputVersion: string;
    candidate: BattleAnalysisCandidate;
    finishedAt: string;
  }): Promise<BattleAnalysisResult>;
  fail(input: {
    actor: ActorScope;
    analysisRunId: string;
    errorCode: "ANALYZER_FAILED" | "INVALID_ANALYSIS_OUTPUT";
    finishedAt: string;
  }): Promise<void>;
}

export class BattleAnalysisNotFoundError extends Error {
  constructor() {
    super("Battle analysis run was not found.");
    this.name = "BattleAnalysisNotFoundError";
  }
}

export class BattleAnalysisStaleError extends Error {
  constructor(readonly latestInputVersion: string) {
    super("Battle analysis input was superseded by newer confirmed facts.");
    this.name = "BattleAnalysisStaleError";
  }
}
