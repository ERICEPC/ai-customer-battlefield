import "@testing-library/jest-dom/vitest";

import type { WorkspaceSnapshot } from "@battlefield/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SessionProvider } from "../auth/session-provider";
import {
  WorkspaceDashboard,
  type WorkspaceDashboardApi,
} from "./workspace-dashboard";

const actionId = "d0000000-0000-4000-8000-000000000071";
const entityId = "90000000-0000-4000-8000-000000000071";
const currentStateId = "e0000000-0000-4000-8000-000000000071";
const previousStateId = "e0000000-0000-4000-8000-000000000070";

const mixedSnapshot: WorkspaceSnapshot = {
  generatedAt: "2026-09-01T00:00:00.000Z",
  scopeMode: "mixed",
  kpis: {
    assignedEntityCount: 2,
    pendingDraftCount: 1,
    pendingProposalCount: 1,
    overdueActionCount: 1,
    unreadNotificationCount: 2,
    highRiskEntityCount: 1,
    dataIncompleteEntityCount: 1,
  },
  priorityActions: [
    {
      actionId,
      entityId,
      entityName: "华东示范客户",
      title: "确认下一轮方案范围",
      ownerUserId: "30000000-0000-4000-8000-000000000001",
      ownerName: "演示销售",
      priority: "high",
      status: "in_progress",
      plannedAt: "2026-08-31T23:00:00.000Z",
      isOverdue: true,
      deepLink: `/actions?actionId=${actionId}`,
    },
  ],
  recentBattleChanges: [
    {
      entityId,
      entityName: "华东示范客户",
      isT0: true,
      battleStateVersionId: currentStateId,
      effectiveAt: "2026-08-31T23:30:00.000Z",
      relationshipScore: "72.50",
      potentialScore: "81.00",
      quadrantCode: "focus",
      riskLevel: "high",
      dataSufficiency: "partial",
      dataGaps: ["缺少预算确认"],
      previousState: {
        battleStateVersionId: previousStateId,
        relationshipScore: "65.00",
        potentialScore: "80.00",
        quadrantCode: "observe",
      },
      relationshipDelta: 7.5,
      potentialDelta: 1,
      quadrantChanged: true,
      changeKind: "updated",
      deepLink: `/battle-map?entityId=${entityId}&stateVersion=${currentStateId}`,
    },
  ],
  quadrantDistribution: [
    { quadrantCode: "focus", count: 1 },
    { quadrantCode: null, count: 1 },
  ],
};

function api(
  snapshot: WorkspaceSnapshot = mixedSnapshot,
): WorkspaceDashboardApi {
  return { get: vi.fn().mockResolvedValue(snapshot) };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WorkspaceDashboard", () => {
  test("opens with a sales-focused conversation and actionable reminders", async () => {
    const navigate = vi.fn();
    render(
      <SessionProvider
        initialSession={{
          user: {
            id: "30000000-0000-4000-8000-000000000001",
            displayName: "销售1",
            email: "sales1@demo.local",
          },
          role: "sales",
          department: {
            id: "31000000-0000-4000-8000-000000000001",
            name: "商业化一部",
          },
          directLeader: {
            id: "30000000-0000-4000-8000-000000000072",
            displayName: "领导A",
          },
          teamMembers: [],
          expiresAt: "2026-09-01T08:00:00.000Z",
        }}
      >
        <WorkspaceDashboard api={api()} navigate={navigate} />
      </SessionProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "你好，销售1" }),
    ).toBeVisible();
    const attention = screen.getByRole("region", {
      name: "销售1今天需要关注的事",
    });
    expect(
      within(attention).getByText(/确认下一轮方案范围.*已到计划时间/),
    ).toBeVisible();
    expect(within(attention).getByText(/关系从 65 提升到 72.5/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "我要录入线索" }));
    expect(screen.getByLabelText("告诉 AI 你想做什么")).toHaveValue(
      "我要录入线索",
    );
    fireEvent.submit(
      screen
        .getByRole("button", { name: "发送给 AI" })
        .closest("form") as HTMLFormElement,
    );
    expect(navigate).toHaveBeenCalledWith(
      "/?draft=%E6%88%91%E8%A6%81%E5%BD%95%E5%85%A5%E7%BA%BF%E7%B4%A2",
    );
  });

  test("shows team activity and a seller-query suggestion to a leader", async () => {
    render(
      <SessionProvider
        initialSession={{
          user: {
            id: "30000000-0000-4000-8000-000000000072",
            displayName: "领导A",
            email: "leader.a@demo.local",
          },
          role: "department_leader",
          department: {
            id: "31000000-0000-4000-8000-000000000001",
            name: "商业化一部",
          },
          directLeader: null,
          teamMembers: [
            {
              id: "30000000-0000-4000-8000-000000000001",
              displayName: "销售1",
            },
          ],
          expiresAt: "2026-09-01T08:00:00.000Z",
        }}
      >
        <WorkspaceDashboard api={api()} />
      </SessionProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "你好，领导A" }),
    ).toBeVisible();
    expect(screen.getByText(/演示销售正在推进华东示范客户/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "我要看看某位销售怎么样" }),
    ).toBeVisible();
  });

  test("does not offer the leader-only progress query to a sales user", async () => {
    render(
      <SessionProvider
        initialSession={{
          user: {
            id: "30000000-0000-4000-8000-000000000001",
            displayName: "销售1",
            email: "sales1@demo.local",
          },
          role: "sales",
          department: {
            id: "31000000-0000-4000-8000-000000000001",
            name: "商业化一部",
          },
          directLeader: {
            id: "30000000-0000-4000-8000-000000000072",
            displayName: "领导A",
          },
          teamMembers: [],
          expiresAt: "2026-09-01T08:00:00.000Z",
        }}
      >
        <WorkspaceDashboard api={api()} />
      </SessionProvider>,
    );

    await screen.findByRole("heading", { name: "我的推进与观察范围" });
    expect(
      screen.queryByRole("link", { name: "查看销售进展" }),
    ).not.toBeInTheDocument();
  });

  test("renders a mixed responsibility scope with bounded actions and battle changes", async () => {
    render(<WorkspaceDashboard api={api()} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载经营工作台");
    expect(
      await screen.findByRole("heading", { name: "我的推进与观察范围" }),
    ).toBeVisible();
    expect(screen.getByText(/同时包含我的直接责任范围/)).toBeVisible();
    expect(screen.getByRole("link", { name: "查看销售进展" })).toHaveAttribute(
      "href",
      "/ask",
    );

    const kpis = screen.getByRole("region", { name: "经营概况" });
    expect(
      within(kpis).getByRole("link", { name: "可见经营对象 2" }),
    ).toBeVisible();
    expect(within(kpis).getByText("待确认草稿")).toBeVisible();
    expect(within(kpis).getByText("未读通知")).toBeVisible();

    const action = screen.getByRole("article", {
      name: "确认下一轮方案范围",
    });
    expect(within(action).getByText("已到计划时间")).toBeVisible();
    expect(
      within(action).getByRole("link", { name: "查看动作" }),
    ).toHaveAttribute("href", `/actions?actionId=${actionId}`);

    const change = screen.getByRole("article", {
      name: "华东示范客户作战变化",
    });
    expect(within(change).getByText("关系 +7.5")).toBeVisible();
    expect(within(change).getByText("潜力 +1")).toBeVisible();
    expect(within(change).getByText("象限变化")).toBeVisible();
    expect(within(change).getByText("待补充事实")).toBeVisible();
    expect(within(change).getByText("缺少预算确认")).toBeVisible();
    expect(
      within(change).getByRole("link", { name: "查看作战状态" }),
    ).toHaveAttribute(
      "href",
      `/battle-map?entityId=${entityId}&stateVersion=${currentStateId}`,
    );
  });

  test.each([
    [
      "personal",
      "今日工作台",
      "对象仅限我直接负责或协作的范围；动作仅显示由我负责的正式动作。",
    ],
    [
      "observed_portfolio",
      "经营总览",
      "对象仅限我被授权观察的范围；可查看这些对象的全部开放动作，但不代表动作归我负责。",
    ],
  ] as const)(
    "explains the %s visibility boundary",
    async (mode, title, copy) => {
      render(
        <WorkspaceDashboard api={api({ ...mixedSnapshot, scopeMode: mode })} />,
      );

      expect(await screen.findByRole("heading", { name: title })).toBeVisible();
      expect(screen.getByText(copy)).toBeVisible();
    },
  );

  test("uses a stable skeleton and explains a request taking longer than two seconds", async () => {
    vi.useFakeTimers();
    render(
      <WorkspaceDashboard
        api={{
          get: vi.fn(() => new Promise<WorkspaceSnapshot>(() => {})),
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("正在加载经营工作台");
    expect(screen.getByTestId("workspace-loading-skeleton")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "仍在汇总你的责任范围与经营变化",
    );
  });

  test("shows a truthful empty scope without fabricated business data", async () => {
    render(
      <WorkspaceDashboard
        api={api({
          ...mixedSnapshot,
          scopeMode: "personal",
          kpis: {
            assignedEntityCount: 0,
            pendingDraftCount: 0,
            pendingProposalCount: 0,
            overdueActionCount: 0,
            unreadNotificationCount: 0,
            highRiskEntityCount: 0,
            dataIncompleteEntityCount: 0,
          },
          priorityActions: [],
          recentBattleChanges: [],
          quadrantDistribution: [],
        })}
      />,
    );

    expect(await screen.findByText("当前没有可见经营对象")).toBeVisible();
    expect(screen.getByText(/不会显示租户内其他人的对象/)).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  test("keeps incomplete analysis visible instead of treating it as a page error", async () => {
    render(
      <WorkspaceDashboard
        api={api({
          ...mixedSnapshot,
          recentBattleChanges: [],
          priorityActions: [],
        })}
      />,
    );

    expect(await screen.findByText("暂无已完成的作战分析")).toBeVisible();
    expect(
      screen.getByText("1 个对象的数据仍不完整。", { exact: false }),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("labels a first analysis as a baseline without fabricated deltas", async () => {
    const current = mixedSnapshot.recentBattleChanges[0];
    if (!current) throw new Error("The fixture requires one battle state.");
    render(
      <WorkspaceDashboard
        api={api({
          ...mixedSnapshot,
          recentBattleChanges: [
            {
              ...current,
              previousState: null,
              relationshipDelta: null,
              potentialDelta: null,
              quadrantChanged: false,
              changeKind: "new_baseline",
            },
          ],
        })}
      />,
    );

    const change = await screen.findByRole("article", {
      name: "华东示范客户作战变化",
    });
    expect(within(change).getByText("首次基线")).toBeVisible();
    expect(within(change).queryByText(/关系 [+-]/)).not.toBeInTheDocument();
    expect(within(change).queryByText(/潜力 [+-]/)).not.toBeInTheDocument();
  });

  test("can retry an unavailable workspace request", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("工作台读取失败"))
      .mockResolvedValueOnce(mixedSnapshot);
    render(<WorkspaceDashboard api={{ get }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "工作台读取失败",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    expect(
      await screen.findByRole("heading", { name: "我的推进与观察范围" }),
    ).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
