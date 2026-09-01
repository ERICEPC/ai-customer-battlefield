import type { BattleAnalyzer } from "./battle-analysis-store.js";

export class DeterministicBattleAnalyzer implements BattleAnalyzer {
  readonly configurationVersion = "deterministic-v1";

  async analyze(input: Parameters<BattleAnalyzer["analyze"]>[0]) {
    const { facts } = input.snapshot;
    const { rules } = input;
    if (facts.length < rules.minimumFactCount) {
      return {
        relationshipScore: null,
        potentialScore: null,
        quadrantCode: null,
        primaryOpportunityId: null,
        riskLevel: rules.insufficientResult.riskLevel,
        dataSufficiency: "insufficient" as const,
        dataGaps: [rules.insufficientResult.dataGap],
        summary: rules.insufficientResult.summary,
        signals: [],
        evidenceFactIds: [],
        actionProposals: [],
      };
    }

    const relationshipScore = calculateScore(
      facts.length,
      rules.relationshipScore,
    );
    const potentialScore = calculateScore(facts.length, rules.potentialScore);
    const primaryOpportunityId =
      facts.findLast((fact) => fact.opportunityId !== null)?.opportunityId ??
      null;
    return {
      relationshipScore: relationshipScore.toFixed(2),
      potentialScore: potentialScore.toFixed(2),
      quadrantCode: rules.sufficientResult.quadrantCode,
      primaryOpportunityId,
      riskLevel: rules.sufficientResult.riskLevel,
      dataSufficiency: "sufficient" as const,
      dataGaps: [],
      summary: rules.sufficientResult.summaryTemplate.replace(
        /\{factCount\}/g,
        String(facts.length),
      ),
      signals: facts.map((fact) => ({
        factId: fact.factId,
        dimension: rules.sufficientResult.signalDimension,
        direction: "positive" as const,
        strength: rules.sufficientResult.signalStrength,
        reason: `${fact.factType} 已由人工确认。`,
      })),
      evidenceFactIds: facts.map((fact) => fact.factId),
      actionProposals: [
        {
          title: rules.actionProposal.title,
          description: rules.actionProposal.description,
          suggestedOwnerId: input.actor.userId,
          suggestedPriority: rules.actionProposal.priority,
          suggestedPlannedAt: null,
        },
      ],
    };
  }
}

function calculateScore(
  factCount: number,
  rule: { base: number; perFact: number; maximum: number },
) {
  return Math.min(rule.maximum, rule.base + factCount * rule.perFact);
}
