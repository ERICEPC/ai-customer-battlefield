import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type {
  BattleDataSufficiency,
  BattleDimension,
  BattleRiskLevel,
  BattleSignalDirection,
} from "./battle-analysis-store.js";

export interface BattleStateRecord {
  battleStateVersionId: string;
  entityId: string;
  versionNo: string;
  inputVersion: string;
  relationshipScore: string | null;
  potentialScore: string | null;
  quadrantCode: string | null;
  primaryOpportunityId: string | null;
  riskLevel: BattleRiskLevel;
  dataSufficiency: BattleDataSufficiency;
  dataGaps: string[];
  summary: string;
  analysisRunId: string;
  effectiveAt: string;
  evidenceFactIds: string[];
}

export interface BattleStateDetail {
  state: BattleStateRecord;
  evidenceFacts: Array<{
    factId: string;
    factType: string;
    factValue: string;
    occurredAt: string;
    opportunityId: string | null;
  }>;
  signals: Array<{
    signalId: string;
    factId: string;
    dimension: BattleDimension;
    direction: BattleSignalDirection;
    strength: number;
    reason: string;
  }>;
}

export interface BattleMapPage {
  items: Array<{
    entityId: string;
    entityName: string;
    entityTypeCode: string;
    isT0: boolean;
    primaryOwnerName: string | null;
    state: BattleStateRecord | null;
  }>;
  nextCursor: string | null;
}

export interface BattleQueryReader {
  getCurrent(input: {
    actor: ActorScope;
    entityId: string;
  }): Promise<BattleStateDetail>;
  listMap(input: {
    actor: ActorScope;
    isT0?: boolean;
    quadrantCode?: string;
    dataSufficiency?: BattleDataSufficiency;
    cursor?: string;
    limit: number;
  }): Promise<BattleMapPage>;
}

export class BattleStateNotFoundError extends Error {
  constructor() {
    super("The current battle state was not found.");
    this.name = "BattleStateNotFoundError";
  }
}

export class InvalidBattleMapCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super("The battle-map cursor is invalid.", options);
    this.name = "InvalidBattleMapCursorError";
  }
}
