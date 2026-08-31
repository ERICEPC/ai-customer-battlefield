import { describe, expect, it, vi } from "vitest";

import type {
  BattleAnalysisStore,
  BattleAnalyzer,
  ConfirmedFactSnapshotReader,
} from "./battle-analysis-store.js";
import {
  type BattleAnalysisInputChangedError,
  type BattleAnalyzerExecutionError,
  InvalidBattleAnalysisCandidateError,
  RequestBattleAnalysis,
} from "./request-battle-analysis.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const entityId = "50000000-0000-4000-8000-000000000001";
const factId = "82000000-0000-4000-8000-000000000001";
const analysisRunId = "a0000000-0000-4000-8000-000000000001";
const stateId = "b0000000-0000-4000-8000-000000000001";
const inputVersion = "a".repeat(64);
const startedAt = new Date("2026-08-31T03:00:00.000Z");
const finishedAt = new Date("2026-08-31T03:00:02.000Z");

const snapshot = {
  entityId,
  inputVersion,
  facts: [
    {
      factId,
      factType: "budget_status",
      factValue: "预算已确认",
      occurredAt: "2026-08-31T02:30:00.000Z",
      opportunityId: null,
    },
  ],
};

const candidate = {
  relationshipScore: "72.50",
  potentialScore: "81.00",
  quadrantCode: "high_relationship_high_potential",
  primaryOpportunityId: null,
  riskLevel: "medium" as const,
  dataSufficiency: "sufficient" as const,
  dataGaps: [],
  summary: "  关系稳定，预算已确认。  ",
  signals: [
    {
      factId,
      dimension: "potential" as const,
      direction: "positive" as const,
      strength: 80,
      reason: "  客户已确认预算。  ",
    },
  ],
  evidenceFactIds: [factId],
  actionProposals: [
    {
      title: "  提交解决方案  ",
      description: "  按客户要求补充实施排期。  ",
      suggestedOwnerId: null,
      suggestedPriority: "high" as const,
      suggestedPlannedAt: "2026-09-03T09:00:00.000Z",
    },
  ],
};

function dependencies(
  overrides: {
    reader?: Partial<ConfirmedFactSnapshotReader>;
    analyzer?: Partial<BattleAnalyzer>;
    store?: Partial<BattleAnalysisStore>;
  } = {},
) {
  const reader = {
    read: vi.fn().mockResolvedValue(snapshot),
    ...overrides.reader,
  } satisfies ConfirmedFactSnapshotReader;
  const analyzer = {
    analyze: vi.fn().mockResolvedValue(candidate),
    ...overrides.analyzer,
  } satisfies BattleAnalyzer;
  const store = {
    findByTriggerEvent: vi.fn().mockResolvedValue(null),
    start: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue({
      analysisRunId,
      entityId,
      status: "completed",
      inputVersion,
      battleStateVersionId: stateId,
      battleStateVersionNo: "1",
      proposalIds: ["c0000000-0000-4000-8000-000000000001"],
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    }),
    fail: vi.fn().mockResolvedValue(undefined),
    ...overrides.store,
  } satisfies BattleAnalysisStore;
  return { reader, analyzer, store };
}

function useCase(parts = dependencies()) {
  return {
    parts,
    subject: new RequestBattleAnalysis({
      ...parts,
      idGenerator: { next: () => analysisRunId },
      clock: {
        now: vi
          .fn()
          .mockReturnValueOnce(startedAt)
          .mockReturnValueOnce(finishedAt),
      },
      ruleVersion: "battle-rules-v1",
      analyzerConfigVersion: "deterministic-v1",
    }),
  };
}

describe("RequestBattleAnalysis", () => {
  it("reads confirmed facts, runs the analyzer outside persistence, then completes once", async () => {
    const { subject, parts } = useCase();

    await subject.execute({
      actor,
      entityId,
      expectedInputVersion: inputVersion,
    });

    expect(parts.reader.read).toHaveBeenCalledWith({ actor, entityId });
    expect(parts.store.start).toHaveBeenCalledWith({
      actor,
      analysisRunId,
      entityId,
      inputVersion,
      ruleVersion: "battle-rules-v1",
      analyzerConfigVersion: "deterministic-v1",
      startedAt: startedAt.toISOString(),
    });
    expect(parts.analyzer.analyze).toHaveBeenCalledWith({
      actor,
      snapshot,
      ruleVersion: "battle-rules-v1",
      analyzerConfigVersion: "deterministic-v1",
    });
    expect(parts.store.complete).toHaveBeenCalledWith({
      actor,
      analysisRunId,
      inputVersion,
      candidate: {
        ...candidate,
        summary: "关系稳定，预算已确认。",
        signals: [{ ...candidate.signals[0], reason: "客户已确认预算。" }],
        actionProposals: [
          {
            ...candidate.actionProposals[0],
            title: "提交解决方案",
            description: "按客户要求补充实施排期。",
          },
        ],
      },
      finishedAt: finishedAt.toISOString(),
    });
    expect(parts.reader.read.mock.invocationCallOrder[0]).toBeLessThan(
      parts.analyzer.analyze.mock.invocationCallOrder[0] ?? 0,
    );
    expect(parts.analyzer.analyze.mock.invocationCallOrder[0]).toBeLessThan(
      parts.store.complete.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops before creating a run when the caller's input watermark is stale", async () => {
    const { subject, parts } = useCase();

    await expect(
      subject.execute({
        actor,
        entityId,
        expectedInputVersion: "b".repeat(64),
      }),
    ).rejects.toMatchObject<BattleAnalysisInputChangedError>({
      latestInputVersion: inputVersion,
    });
    expect(parts.store.start).not.toHaveBeenCalled();
    expect(parts.analyzer.analyze).not.toHaveBeenCalled();
  });

  it("records analyzer failure without attempting result persistence", async () => {
    const modelFailure = new Error("analyzer unavailable");
    const parts = dependencies({
      analyzer: { analyze: vi.fn().mockRejectedValue(modelFailure) },
    });
    const { subject } = useCase(parts);

    await expect(
      subject.execute({ actor, entityId }),
    ).rejects.toMatchObject<BattleAnalyzerExecutionError>({
      name: "BattleAnalyzerExecutionError",
      cause: modelFailure,
    });
    expect(parts.store.fail).toHaveBeenCalledWith({
      actor,
      analysisRunId,
      errorCode: "ANALYZER_FAILED",
      finishedAt: finishedAt.toISOString(),
    });
    expect(parts.store.complete).not.toHaveBeenCalled();
  });

  it("rejects unexplainable analyzer output and marks the run failed", async () => {
    const parts = dependencies({
      analyzer: {
        analyze: vi.fn().mockResolvedValue({
          ...candidate,
          evidenceFactIds: [],
        }),
      },
    });
    const { subject } = useCase(parts);

    await expect(subject.execute({ actor, entityId })).rejects.toBeInstanceOf(
      InvalidBattleAnalysisCandidateError,
    );
    expect(parts.store.fail).toHaveBeenCalledWith({
      actor,
      analysisRunId,
      errorCode: "INVALID_ANALYSIS_OUTPUT",
      finishedAt: finishedAt.toISOString(),
    });
    expect(parts.store.complete).not.toHaveBeenCalled();
  });

  it("runtime-validates analyzer enums instead of trusting TypeScript types", async () => {
    const parts = dependencies({
      analyzer: {
        analyze: vi.fn().mockResolvedValue({
          ...candidate,
          signals: [
            {
              ...candidate.signals[0],
              dimension: "invented_dimension",
            },
          ],
        }),
      },
    });
    const { subject } = useCase(parts);

    await expect(subject.execute({ actor, entityId })).rejects.toBeInstanceOf(
      InvalidBattleAnalysisCandidateError,
    );
    expect(parts.store.complete).not.toHaveBeenCalled();
  });
});
