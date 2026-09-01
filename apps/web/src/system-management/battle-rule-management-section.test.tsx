import "@testing-library/jest-dom/vitest";

import type {
  BattleRuleSet,
  BattleRuleVersionPage,
} from "@battlefield/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  type BattleRuleManagementApi,
  BattleRuleManagementSection,
} from "./battle-rule-management-section";

const V1_ID = "a3000000-0000-4000-8000-000000000001";
const V2_ID = "a3000000-0000-4000-8000-000000000002";
const rules: BattleRuleSet = {
  minimumFactCount: 1,
  relationshipScore: { base: 60, perFact: 5, maximum: 90 },
  potentialScore: { base: 70, perFact: 5, maximum: 95 },
  insufficientResult: {
    riskLevel: "medium",
    dataGap: "缺少正式事实",
    summary: "事实不足。",
  },
  sufficientResult: {
    quadrantCode: "high_relationship_high_potential",
    riskLevel: "low",
    signalDimension: "potential",
    signalStrength: 70,
    summaryTemplate: "已基于 {factCount} 条事实生成分析。",
  },
  actionProposal: {
    title: "确认下一步客户经营动作",
    description: "与客户确认负责人和时间。",
    priority: "high",
  },
  stageLabels: { proposal: "方案与报价", solution_validation: "方案验证" },
};
const page: BattleRuleVersionPage = {
  items: [
    {
      versionId: V2_ID,
      versionNo: "2",
      name: "重点客户规则",
      rules: {
        ...rules,
        relationshipScore: { base: 55, perFact: 8, maximum: 95 },
      },
      contentFingerprint: "b".repeat(64),
      createdBy: "30000000-0000-4000-8000-000000000072",
      createdAt: "2026-09-01T08:00:00.000Z",
    },
    {
      versionId: V1_ID,
      versionNo: "1",
      name: "默认确定性作战规则 V1",
      rules,
      contentFingerprint: "a".repeat(64),
      createdBy: null,
      createdAt: "2026-09-01T07:00:00.000Z",
    },
  ],
  currentVersionId: V1_ID,
  currentReleaseNo: "1",
  nextCursor: null,
};

afterEach(cleanup);

describe("BattleRuleManagementSection", () => {
  test("shows the current receipt, score formulas and configured stage labels", async () => {
    render(<BattleRuleManagementSection api={api()} />);

    expect(await screen.findByText("V1 / R1")).toBeVisible();
    expect(screen.getByText(/关系 60 \+ 5\/条，封顶 90/)).toBeVisible();
    fireEvent.click(
      screen.getAllByText("查看阶段名称与建议动作")[1] ?? document.body,
    );
    expect(screen.getAllByText("方案验证")).toHaveLength(2);
    expect(
      (screen.getByLabelText("作战阶段名称") as HTMLTextAreaElement).value,
    ).toContain("solution_validation=方案验证");
  });

  test("creates a changed immutable version and releases a selected version with reason", async () => {
    const mockApi = api();
    render(<BattleRuleManagementSection api={mockApi} />);
    await screen.findByText("V1 / R1");

    fireEvent.change(screen.getByLabelText("作战规则版本名称"), {
      target: { value: "关系加速规则" },
    });
    fireEvent.change(screen.getByLabelText("关系起始分"), {
      target: { value: "58" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建规则版本" }));
    await waitFor(() => expect(mockApi.createVersion).toHaveBeenCalledOnce());
    expect(mockApi.createVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "关系加速规则",
        rules: expect.objectContaining({
          relationshipScore: { base: 58, perFact: 5, maximum: 90 },
        }),
      }),
    );

    fireEvent.change(screen.getByLabelText("待发布作战规则"), {
      target: { value: V2_ID },
    });
    fireEvent.change(screen.getByLabelText("作战规则发布原因"), {
      target: { value: "业务口径已验收" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布此版本" }));
    await waitFor(() =>
      expect(mockApi.releaseVersion).toHaveBeenCalledWith(
        V2_ID,
        "业务口径已验收",
      ),
    );
  });
});

function api(): BattleRuleManagementApi & {
  listVersions: ReturnType<typeof vi.fn>;
  createVersion: ReturnType<typeof vi.fn>;
  releaseVersion: ReturnType<typeof vi.fn>;
} {
  return {
    listVersions: vi.fn().mockResolvedValue(page),
    createVersion: vi.fn().mockResolvedValue(page.items[0]),
    releaseVersion: vi.fn().mockResolvedValue({
      versionId: V2_ID,
      versionNo: "2",
      releaseNo: "2",
      ruleVersion: "battle-rules-v2-r2",
      name: "重点客户规则",
      rules: page.items[0]?.rules ?? rules,
      releasedAt: "2026-09-01T08:10:00.000Z",
    }),
  };
}
