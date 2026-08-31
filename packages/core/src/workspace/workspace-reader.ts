import type { ActionPriority } from "../action-decisions/action-decision-store.js";
import type {
  BattleDataSufficiency,
  BattleRiskLevel,
} from "../battle-analysis/battle-analysis-store.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export type WorkspaceScopeMode = "personal" | "observed_portfolio" | "mixed";

export interface WorkspaceKpis {
  assignedEntityCount: number;
  pendingDraftCount: number;
  pendingProposalCount: number;
  overdueActionCount: number;
  unreadNotificationCount: number;
  highRiskEntityCount: number;
  dataIncompleteEntityCount: number;
}

export interface WorkspacePriorityAction {
  actionId: string;
  entityId: string;
  entityName: string;
  title: string;
  ownerUserId: string;
  ownerName: string;
  priority: ActionPriority;
  status: "planned" | "in_progress";
  plannedAt: string;
  isOverdue: boolean;
  deepLink: string;
}

export interface WorkspacePreviousBattleState {
  battleStateVersionId: string;
  relationshipScore: string | null;
  potentialScore: string | null;
  quadrantCode: string | null;
}

export interface WorkspaceBattleChange {
  entityId: string;
  entityName: string;
  isT0: boolean;
  battleStateVersionId: string;
  effectiveAt: string;
  relationshipScore: string | null;
  potentialScore: string | null;
  quadrantCode: string | null;
  riskLevel: BattleRiskLevel;
  dataSufficiency: BattleDataSufficiency;
  dataGaps: string[];
  previousState: WorkspacePreviousBattleState | null;
  relationshipDelta: number | null;
  potentialDelta: number | null;
  quadrantChanged: boolean;
  changeKind: "new_baseline" | "updated";
  deepLink: string;
}

export interface WorkspaceQuadrantBucket {
  quadrantCode: string | null;
  count: number;
}

export interface WorkspaceProjection {
  scopeMode: WorkspaceScopeMode;
  kpis: WorkspaceKpis;
  priorityActions: WorkspacePriorityAction[];
  recentBattleChanges: WorkspaceBattleChange[];
  quadrantDistribution: WorkspaceQuadrantBucket[];
}

export interface WorkspaceSnapshot extends WorkspaceProjection {
  generatedAt: string;
}

export interface WorkspaceReaderInput {
  actor: ActorScope;
  now: string;
}

export interface WorkspaceReader {
  read(input: WorkspaceReaderInput): Promise<WorkspaceProjection>;
}
