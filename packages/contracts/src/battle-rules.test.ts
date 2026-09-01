import { describe, expect, test } from "vitest";

import {
  battleRuleSetSchema,
  battleRuleVersionPageSchema,
  createBattleRuleVersionRequestSchema,
} from "./battle-rules.js";

const rules = {
  minimumFactCount: 1,
  relationshipScore: { base: 60, perFact: 5, maximum: 90 },
  potentialScore: { base: 70, perFact: 5, maximum: 95 },
  insufficientResult: {
    riskLevel: "medium",
    dataGap: "缺少已确认的正式经营事实",
    summary: "当前正式事实不足，暂不生成精确作战坐标。",
  },
  sufficientResult: {
    quadrantCode: "high_relationship_high_potential",
    riskLevel: "low",
    signalDimension: "potential",
    signalStrength: 70,
    summaryTemplate: "已基于 {factCount} 条正式事实生成分析。",
  },
  actionProposal: {
    title: "确认下一步客户经营动作",
    description: "与客户确认负责人、时间和预期结果。",
    priority: "high",
  },
  stageLabels: { solution_validation: "方案验证", won: "赢单" },
} as const;

describe("battle rule contracts", () => {
  test("accepts the bounded rule document and strict immutable version page", () => {
    expect(battleRuleSetSchema.parse(rules)).toEqual(rules);
    expect(
      battleRuleVersionPageSchema.parse({
        items: [
          {
            versionId: "a3000000-0000-4000-8000-000000000001",
            versionNo: "1",
            name: "默认规则",
            rules,
            contentFingerprint: "a".repeat(64),
            createdBy: null,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        currentVersionId: "a3000000-0000-4000-8000-000000000001",
        currentReleaseNo: "1",
        nextCursor: null,
      }).currentReleaseNo,
    ).toBe("1");
  });

  test("rejects executable extras, invalid score bounds and oversized labels", () => {
    expect(
      createBattleRuleVersionRequestSchema.safeParse({
        name: "危险规则",
        rules: { ...rules, script: "drop table" },
      }).success,
    ).toBe(false);
    expect(
      battleRuleSetSchema.safeParse({
        ...rules,
        relationshipScore: { base: 80, perFact: 5, maximum: 60 },
      }).success,
    ).toBe(false);
    expect(
      battleRuleSetSchema.safeParse({
        ...rules,
        stageLabels: Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [`stage_${index}`, "阶段"]),
        ),
      }).success,
    ).toBe(false);
  });
});
