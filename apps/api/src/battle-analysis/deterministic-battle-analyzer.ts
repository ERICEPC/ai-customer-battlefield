import type { BattleAnalyzer } from "@battlefield/core";

export class DeterministicBattleAnalyzer implements BattleAnalyzer {
  async analyze(input: Parameters<BattleAnalyzer["analyze"]>[0]) {
    const { facts } = input.snapshot;
    if (facts.length === 0) {
      return {
        relationshipScore: null,
        potentialScore: null,
        quadrantCode: null,
        primaryOpportunityId: null,
        riskLevel: "medium" as const,
        dataSufficiency: "insufficient" as const,
        dataGaps: ["缺少已确认的正式经营事实"],
        summary: "当前正式事实不足，暂不生成精确作战坐标。",
        signals: [],
        evidenceFactIds: [],
        actionProposals: [],
      };
    }

    const relationshipScore = Math.min(90, 60 + facts.length * 5);
    const potentialScore = Math.min(95, 70 + facts.length * 5);
    const primaryOpportunityId =
      facts.findLast((fact) => fact.opportunityId !== null)?.opportunityId ??
      null;
    return {
      relationshipScore: relationshipScore.toFixed(2),
      potentialScore: potentialScore.toFixed(2),
      quadrantCode: "high_relationship_high_potential",
      primaryOpportunityId,
      riskLevel: "low" as const,
      dataSufficiency: "sufficient" as const,
      dataGaps: [],
      summary: `已基于 ${facts.length} 条正式事实生成可回放的确定性分析。`,
      signals: facts.map((fact) => ({
        factId: fact.factId,
        dimension: "potential" as const,
        direction: "positive" as const,
        strength: 70,
        reason: `${fact.factType} 已由人工确认。`,
      })),
      evidenceFactIds: facts.map((fact) => fact.factId),
      actionProposals: [
        {
          title: "确认下一步客户经营动作",
          description: "结合最新正式事实，与客户确认负责人、时间和预期结果。",
          suggestedOwnerId: input.actor.userId,
          suggestedPriority: "high" as const,
          suggestedPlannedAt: null,
        },
      ],
    };
  }
}
