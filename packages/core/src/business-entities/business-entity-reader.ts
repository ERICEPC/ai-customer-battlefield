import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export type BusinessEntityStatus = "active" | "inactive" | "archived";

export interface BusinessEntityListItem {
  id: string;
  typeCode: string;
  name: string;
  shortName: string | null;
  status: BusinessEntityStatus;
  isT0: boolean;
  primaryOwnerName: string | null;
  primaryOpportunity: {
    id: string;
    name: string;
    stageCode: string;
    stageProgress: string;
  } | null;
  latestFollowup: {
    followupId: string;
    summary: string;
    confirmedAt: string;
  } | null;
  updatedAt: string;
  versionNo: string;
}

export interface BusinessEntityPage {
  items: BusinessEntityListItem[];
  nextCursor: string | null;
}

export interface BusinessEntityReaderInput {
  actor: ActorScope;
  status?: BusinessEntityStatus;
  search?: string;
  cursor?: string;
  limit: number;
}

export interface BusinessEntityReader {
  list(input: BusinessEntityReaderInput): Promise<BusinessEntityPage>;
}
