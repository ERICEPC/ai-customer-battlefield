import { describe, expect, it } from "vitest";

import {
  battleAnalysisCandidateSchema,
  battleAnalysisRequestSchema,
  battleAnalysisResultSchema,
  battleMapPageSchema,
  battleMapQuerySchema,
  battleStateDetailSchema,
  battleStateRecordSchema,
} from "./battle-analysis.js";

const entityId = "50000000-0000-4000-8000-000000000001";
const factId = "82000000-0000-4000-8000-000000000001";
const runId = "a0000000-0000-4000-8000-000000000001";
const stateId = "b0000000-0000-4000-8000-000000000001";

function sufficientCandidate() {
  return {
    relationshipScore: "72.50",
    potentialScore: "81.00",
    quadrantCode: "high_relationship_high_potential",
    primaryOpportunityId: null,
    riskLevel: "medium" as const,
    dataSufficiency: "sufficient" as const,
    dataGaps: [],
    summary: "关系稳定，预算与采购流程已有明确事实。",
    signals: [
      {
        factId,
        dimension: "potential" as const,
        direction: "positive" as const,
        strength: 80,
        reason: "客户已确认预算。",
      },
    ],
    evidenceFactIds: [factId],
    actionProposals: [
      {
        title: "提交解决方案",
        description: "按客户要求补充实施排期。",
        suggestedOwnerId: null,
        suggestedPriority: "high" as const,
        suggestedPlannedAt: "2026-09-03T09:00:00.000Z",
      },
    ],
  };
}

describe("battle analysis contracts", () => {
  it("accepts an explainable sufficient analysis candidate", () => {
    expect(battleAnalysisCandidateSchema.parse(sufficientCandidate())).toEqual(
      sufficientCandidate(),
    );
  });

  it("requires missing-data output to avoid invented coordinates", () => {
    const result = battleAnalysisCandidateSchema.safeParse({
      ...sufficientCandidate(),
      relationshipScore: null,
      potentialScore: null,
      quadrantCode: null,
      dataSufficiency: "insufficient",
      dataGaps: ["缺少近期有效跟进"],
      signals: [],
      evidenceFactIds: [],
      actionProposals: [],
    });
    expect(result.success).toBe(true);

    expect(
      battleAnalysisCandidateSchema.safeParse({
        ...sufficientCandidate(),
        dataSufficiency: "insufficient",
        dataGaps: [],
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range scores, duplicate evidence, and unexplained signals", () => {
    expect(
      battleAnalysisCandidateSchema.safeParse({
        ...sufficientCandidate(),
        relationshipScore: "100.01",
      }).success,
    ).toBe(false);
    expect(
      battleAnalysisCandidateSchema.safeParse({
        ...sufficientCandidate(),
        evidenceFactIds: [factId, factId],
      }).success,
    ).toBe(false);
    expect(
      battleAnalysisCandidateSchema.safeParse({
        ...sufficientCandidate(),
        evidenceFactIds: [],
      }).success,
    ).toBe(false);
  });

  it("keeps requests strict and validates an optional input watermark", () => {
    expect(
      battleAnalysisRequestSchema.parse({
        entityId,
        expectedInputVersion: "f".repeat(64),
      }),
    ).toEqual({ entityId, expectedInputVersion: "f".repeat(64) });
    expect(
      battleAnalysisRequestSchema.safeParse({
        entityId,
        expectedInputVersion: "not-a-hash",
      }).success,
    ).toBe(false);
    expect(
      battleAnalysisRequestSchema.safeParse({ entityId, sql: "select 1" })
        .success,
    ).toBe(false);
  });

  it("represents completed and superseded analysis results without ambiguity", () => {
    expect(
      battleAnalysisResultSchema.parse({
        analysisRunId: runId,
        entityId,
        status: "completed",
        inputVersion: "a".repeat(64),
        battleStateVersionId: stateId,
        battleStateVersionNo: "2",
        proposalIds: ["c0000000-0000-4000-8000-000000000001"],
        startedAt: "2026-08-31T03:00:00.000Z",
        finishedAt: "2026-08-31T03:00:02.000Z",
      }).status,
    ).toBe("completed");

    expect(
      battleAnalysisResultSchema.safeParse({
        analysisRunId: runId,
        entityId,
        status: "superseded",
        inputVersion: "a".repeat(64),
        battleStateVersionId: stateId,
        battleStateVersionNo: "2",
        proposalIds: [],
        startedAt: "2026-08-31T03:00:00.000Z",
        finishedAt: "2026-08-31T03:00:02.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates immutable battle-state records and bounded map filters", () => {
    const state = {
      battleStateVersionId: stateId,
      entityId,
      versionNo: "2",
      inputVersion: "a".repeat(64),
      relationshipScore: "72.50",
      potentialScore: "81.00",
      quadrantCode: "high_relationship_high_potential",
      primaryOpportunityId: null,
      riskLevel: "medium" as const,
      dataSufficiency: "sufficient" as const,
      dataGaps: [],
      summary: "关系稳定，潜力较高。",
      analysisRunId: runId,
      analysisReceipt: {
        trigger: "manual",
        ruleVersion: "battle-rules-v1-r1",
        analyzerConfigVersion: "deterministic-v1",
      },
      effectiveAt: "2026-08-31T03:00:02.000Z",
      evidenceFactIds: [factId],
    };
    expect(battleStateRecordSchema.parse(state)).toEqual(state);

    expect(
      battleMapQuerySchema.parse({
        entityId,
        isT0: "true",
        quadrantCode: "high_relationship_high_potential",
        dataSufficiency: "sufficient",
        limit: "20",
      }),
    ).toEqual({
      entityId,
      isT0: true,
      quadrantCode: "high_relationship_high_potential",
      dataSufficiency: "sufficient",
      limit: 20,
    });
    expect(battleMapQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("allows map rows without analysis while preserving the entity identity", () => {
    expect(
      battleMapPageSchema.parse({
        items: [
          {
            entityId,
            entityName: "Aurora Systems",
            entityTypeCode: "customer",
            isT0: true,
            primaryOwnerName: "演示销售",
            state: null,
          },
        ],
        nextCursor: null,
      }).items[0]?.state,
    ).toBeNull();
  });

  it("returns evidence facts and signals in a bounded current-state detail", () => {
    expect(
      battleStateDetailSchema.parse({
        state: {
          battleStateVersionId: stateId,
          entityId,
          versionNo: "2",
          inputVersion: "a".repeat(64),
          relationshipScore: "72.50",
          potentialScore: "81.00",
          quadrantCode: "high_relationship_high_potential",
          primaryOpportunityId: null,
          riskLevel: "medium",
          dataSufficiency: "sufficient",
          dataGaps: [],
          summary: "关系稳定，潜力较高。",
          analysisRunId: runId,
          analysisReceipt: {
            trigger: "followup_confirmed",
            ruleVersion: "battle-rules-v1-r1",
            analyzerConfigVersion: "deterministic-v1",
          },
          effectiveAt: "2026-08-31T03:00:02.000Z",
          evidenceFactIds: [factId],
        },
        evidenceFacts: [
          {
            factId,
            factType: "budget_status",
            factValue: "预算已确认",
            occurredAt: "2026-08-31T02:30:00.000Z",
            opportunityId: null,
          },
        ],
        signals: [
          {
            signalId: "c0000000-0000-4000-8000-000000000001",
            factId,
            dimension: "potential",
            direction: "positive",
            strength: 80,
            reason: "客户已确认预算。",
          },
        ],
      }).signals,
    ).toHaveLength(1);
  });
});
