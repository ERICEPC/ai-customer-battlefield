import { describe, expect, it } from "vitest";

import type { Clock } from "../followup-drafts/create-followup-draft.js";
import {
  GetWorkspaceSnapshot,
  InvalidWorkspaceClockError,
} from "./get-workspace-snapshot.js";
import type {
  WorkspaceProjection,
  WorkspaceReader,
  WorkspaceReaderInput,
} from "./workspace-reader.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};

const projection: WorkspaceProjection = {
  scopeMode: "personal",
  kpis: {
    assignedEntityCount: 1,
    pendingDraftCount: 0,
    pendingProposalCount: 1,
    overdueActionCount: 0,
    unreadNotificationCount: 2,
    highRiskEntityCount: 0,
    dataIncompleteEntityCount: 1,
  },
  priorityActions: [],
  recentBattleChanges: [],
  quadrantDistribution: [{ quadrantCode: null, count: 1 }],
};

class RecordingWorkspaceReader implements WorkspaceReader {
  readonly inputs: WorkspaceReaderInput[] = [];

  constructor(private readonly projectionToReturn: WorkspaceProjection) {}

  async read(input: WorkspaceReaderInput): Promise<WorkspaceProjection> {
    this.inputs.push(input);
    return this.projectionToReturn;
  }
}

class RecordingClock implements Clock {
  calls = 0;

  constructor(private readonly value: Date) {}

  now(): Date {
    this.calls += 1;
    return this.value;
  }
}

describe("GetWorkspaceSnapshot", () => {
  it("captures one server time and delegates the actor scope unchanged", async () => {
    const reader = new RecordingWorkspaceReader(projection);
    const clock = new RecordingClock(new Date("2026-08-31T04:00:00.000Z"));
    const useCase = new GetWorkspaceSnapshot({ reader, clock });

    const result = await useCase.execute({ actor });

    expect(clock.calls).toBe(1);
    expect(reader.inputs).toEqual([
      {
        actor,
        now: "2026-08-31T04:00:00.000Z",
      },
    ]);
    expect(result).toEqual({
      generatedAt: "2026-08-31T04:00:00.000Z",
      ...projection,
    });
  });

  it("rejects an invalid clock before invoking the reader", async () => {
    const reader = new RecordingWorkspaceReader(projection);
    const useCase = new GetWorkspaceSnapshot({
      reader,
      clock: new RecordingClock(new Date(Number.NaN)),
    });

    await expect(useCase.execute({ actor })).rejects.toBeInstanceOf(
      InvalidWorkspaceClockError,
    );
    expect(reader.inputs).toEqual([]);
  });
});
