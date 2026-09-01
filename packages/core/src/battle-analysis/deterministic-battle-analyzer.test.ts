import { describe, expect, it } from "vitest";
import { defaultBattleRuleSet } from "./battle-rule.js";
import { DeterministicBattleAnalyzer } from "./deterministic-battle-analyzer.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};

describe("DeterministicBattleAnalyzer", () => {
  it("reproduces the current visible result from the default rule document", async () => {
    const analyzer = new DeterministicBattleAnalyzer();
    const result = await analyzer.analyze({
      actor,
      ruleVersion: "battle-rules-v1-release-1",
      rules: defaultBattleRuleSet,
      snapshot: {
        entityId: "50000000-0000-4000-8000-000000000001",
        inputVersion: "a".repeat(64),
        facts: [
          {
            factId: "82000000-0000-4000-8000-000000000001",
            factType: "budget_status",
            factValue: "预算已确认",
            occurredAt: "2026-08-31T02:30:00.000Z",
            opportunityId: "60000000-0000-4000-8000-000000000001",
          },
        ],
      },
    });

    expect(analyzer.configurationVersion).toBe("deterministic-v1");
    expect(result).toMatchObject({
      relationshipScore: "65.00",
      potentialScore: "75.00",
      quadrantCode: "high_relationship_high_potential",
      riskLevel: "low",
      dataSufficiency: "sufficient",
      summary: "已基于 1 条正式事实生成可回放的确定性分析。",
      signals: [{ dimension: "potential", strength: 70 }],
      actionProposals: [
        {
          title: "确认下一步客户经营动作",
          description: "结合最新正式事实，与客户确认负责人、时间和预期结果。",
          suggestedPriority: "high",
        },
      ],
    });
  });

  it("uses a supplied released rule instead of hidden score constants", async () => {
    const analyzer = new DeterministicBattleAnalyzer();
    const result = await analyzer.analyze({
      actor,
      ruleVersion: "battle-rules-v2-release-2",
      rules: {
        ...defaultBattleRuleSet,
        minimumFactCount: 2,
        relationshipScore: { base: 10, perFact: 2, maximum: 20 },
        potentialScore: { base: 30, perFact: 3, maximum: 50 },
      },
      snapshot: {
        entityId: "50000000-0000-4000-8000-000000000001",
        inputVersion: "b".repeat(64),
        facts: [],
      },
    });

    expect(result.relationshipScore).toBeNull();
    expect(result.dataSufficiency).toBe("insufficient");
  });
});
