import "@testing-library/jest-dom/vitest";

import type {
  ActionProposalRecord,
  BusinessActionRecord,
} from "@battlefield/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActionWorkspace, type ActionWorkspaceApi } from "./action-workspace";

const proposalId = "c0000000-0000-4000-8000-000000000001";
const entityId = "50000000-0000-4000-8000-000000000001";
const ownerId = "30000000-0000-4000-8000-000000000001";
const actionId = "d0000000-0000-4000-8000-000000000001";

const proposal: ActionProposalRecord = {
  proposalId,
  entityId,
  entityName: "Aurora Systems",
  opportunityId: null,
  title: "提交正式方案",
  description: "附上安全与交付计划。",
  suggestedOwnerId: ownerId,
  suggestedOwnerName: "销售甲",
  suggestedPriority: "high",
  suggestedPlannedAt: "2026-09-03T09:00:00.000Z",
  sourceBattleStateVersionId: "b0000000-0000-4000-8000-000000000001",
  status: "pending_confirmation",
  versionNo: "1",
  proposedAt: "2026-08-31T05:00:00.000Z",
  expiresAt: "2026-09-07T05:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  actionId: null,
};

const formalAction: BusinessActionRecord = {
  actionId,
  entityId,
  entityName: "Aurora Systems",
  opportunityId: null,
  title: "完成安全评审",
  description: "与客户安全负责人完成评审。",
  ownerUserId: ownerId,
  ownerName: "销售甲",
  priority: "urgent",
  status: "planned",
  plannedAt: "2026-09-02T09:00:00.000Z",
  completedAt: null,
  sourceProposalId: "c0000000-0000-4000-8000-000000000002",
  confirmedBy: ownerId,
  confirmedAt: "2026-08-31T04:00:00.000Z",
  versionNo: "1",
};

const secondProposal: ActionProposalRecord = {
  ...proposal,
  proposalId: "c0000000-0000-4000-8000-000000000003",
  title: "确认采购流程",
};

function api(overrides: Partial<ActionWorkspaceApi> = {}) {
  return {
    listOwners: vi.fn().mockResolvedValue({
      items: [{ userId: ownerId, displayName: "销售甲" }],
      nextCursor: null,
    }),
    listProposals: vi.fn().mockResolvedValue({
      items: [proposal],
      nextCursor: null,
    }),
    getProposal: vi.fn().mockResolvedValue(proposal),
    acceptProposal: vi.fn().mockResolvedValue({
      proposalId,
      status: "accepted",
      actionId,
      versionNo: "2",
      decidedAt: "2026-08-31T06:00:00.000Z",
    }),
    rejectProposal: vi.fn().mockResolvedValue({
      proposalId,
      status: "rejected",
      actionId: null,
      versionNo: "2",
      decidedAt: "2026-08-31T06:00:00.000Z",
    }),
    listActions: vi.fn().mockResolvedValue({
      items: [formalAction],
      nextCursor: null,
    }),
    transitionAction: vi.fn().mockResolvedValue({
      actionId,
      status: "in_progress",
      versionNo: "2",
      changedAt: "2026-08-31T06:30:00.000Z",
    }),
    ...overrides,
  } satisfies ActionWorkspaceApi;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-31T06:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ActionWorkspace", () => {
  it("keeps pending proposals visibly separate from formal actions", async () => {
    render(<ActionWorkspace api={api()} />);

    expect(await screen.findByText("待确认建议")).toBeVisible();
    expect(screen.getByText("建议不是任务，尚未启用提醒")).toBeVisible();
    expect(screen.getByRole("heading", { name: "正式经营动作" })).toBeVisible();
    expect(screen.getByText("完成安全评审")).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "正式经营动作" })).getByText(
        "Aurora Systems",
      ),
    ).toBeVisible();
    expect(screen.getByText("来源状态版本")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "在地图查看来源与证据" }),
    ).toHaveAttribute(
      "href",
      `/battle-map?entityId=${entityId}&stateVersion=${proposal.sourceBattleStateVersionId}`,
    );
  });

  it("requires owner, time and priority before explicitly creating an action", async () => {
    const workspaceApi = api();
    render(<ActionWorkspace api={workspaceApi} />);
    await screen.findByText("待确认建议");

    fireEvent.change(screen.getByLabelText("责任人"), {
      target: { value: "" },
    });
    expect(screen.getByRole("button", { name: "创建经营动作" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("责任人"), {
      target: { value: ownerId },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建经营动作" }));

    expect(await screen.findByText("已创建正式经营动作")).toBeVisible();
    expect(workspaceApi.acceptProposal).toHaveBeenCalledWith(
      proposalId,
      expect.objectContaining({
        versionNo: "1",
        ownerUserId: ownerId,
        priority: "high",
        plannedAt: "2026-09-03T09:00:00.000Z",
      }),
      expect.stringMatching(/^accept-/),
    );
    expect(screen.getByText(actionId)).toBeVisible();
  });

  it("does not submit an inactive suggested or current owner", async () => {
    const workspaceApi = api({
      listOwners: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    render(<ActionWorkspace api={workspaceApi} />);
    await screen.findByText("待确认建议");

    expect(screen.getByLabelText("责任人")).toHaveValue("");
    expect(screen.getByText(/建议负责人.*当前不可用/)).toBeVisible();
    expect(screen.getByRole("button", { name: "创建经营动作" })).toBeDisabled();
  });

  it("loads every active owner through the server cursor", async () => {
    const secondOwnerId = "30000000-0000-4000-8000-000000000099";
    const listOwners = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ userId: ownerId, displayName: "销售甲" }],
        nextCursor: "owner-next",
      })
      .mockResolvedValueOnce({
        items: [{ userId: secondOwnerId, displayName: "销售乙" }],
        nextCursor: null,
      });
    render(<ActionWorkspace api={api({ listOwners })} />);
    await screen.findByText("待确认建议");

    fireEvent.click(screen.getByRole("button", { name: "加载更多负责人" }));

    expect(await screen.findByRole("option", { name: "销售乙" })).toBeVisible();
    expect(listOwners).toHaveBeenLastCalledWith({
      cursor: "owner-next",
      limit: 50,
    });
  });

  it("offers an explicit plan-time shortcut when the analyzer did not suggest one", async () => {
    render(
      <ActionWorkspace
        api={api({
          listProposals: vi.fn().mockResolvedValue({
            items: [{ ...proposal, suggestedPlannedAt: null }],
            nextCursor: null,
          }),
        })}
      />,
    );
    await screen.findByText("待确认建议");

    expect(screen.getByRole("button", { name: "创建经营动作" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "设为明日 09:00" }));

    expect(screen.getByLabelText("计划时间")).not.toHaveValue("");
    expect(screen.getByRole("button", { name: "创建经营动作" })).toBeEnabled();
  });

  it("reuses the acceptance idempotency key after a recoverable failure", async () => {
    const acceptProposal = vi
      .fn()
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce({
        proposalId,
        status: "accepted",
        actionId,
        versionNo: "2",
        decidedAt: "2026-08-31T06:00:00.000Z",
      });
    render(<ActionWorkspace api={api({ acceptProposal })} />);
    await screen.findByText("待确认建议");

    fireEvent.click(screen.getByRole("button", { name: "创建经营动作" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "网络暂时不可用",
    );
    expect(screen.getByLabelText("动作标题")).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝建议" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "创建经营动作" }));
    await screen.findByText("已创建正式经营动作");

    expect(acceptProposal.mock.calls[0]?.[2]).toBe(
      acceptProposal.mock.calls[1]?.[2],
    );
    expect(acceptProposal.mock.calls[0]?.[1]).toEqual(
      acceptProposal.mock.calls[1]?.[1],
    );
  });

  it("locks queue switching while a decision request is unresolved", async () => {
    let resolveDecision:
      | ((
          value: Awaited<ReturnType<ActionWorkspaceApi["acceptProposal"]>>,
        ) => void)
      | undefined;
    const acceptProposal = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<ActionWorkspaceApi["acceptProposal"]>>>(
          (resolve) => {
            resolveDecision = resolve;
          },
        ),
    );
    render(
      <ActionWorkspace
        api={api({
          acceptProposal,
          listProposals: vi.fn().mockResolvedValue({
            items: [proposal, secondProposal],
            nextCursor: null,
          }),
        })}
      />,
    );
    await screen.findByText("待确认建议");

    fireEvent.click(screen.getByRole("button", { name: "创建经营动作" }));
    expect(screen.getByRole("button", { name: /确认采购流程/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新工作区" })).toBeDisabled();

    resolveDecision?.({
      proposalId,
      status: "accepted",
      actionId,
      versionNo: "2",
      decidedAt: "2026-08-31T06:00:00.000Z",
    });
    expect(await screen.findByText("已创建正式经营动作")).toBeVisible();
  });

  it("recovers an ambiguous acceptance from the server terminal state", async () => {
    const getProposal = vi.fn().mockResolvedValue({
      ...proposal,
      status: "accepted",
      actionId,
      versionNo: "2",
      decidedAt: "2026-08-31T06:00:00.000Z",
      decidedBy: ownerId,
    });
    const workspaceApi = api({
      acceptProposal: vi.fn().mockRejectedValue(new Error("响应已丢失")),
      getProposal,
    });
    render(<ActionWorkspace api={workspaceApi} />);
    await screen.findByText("待确认建议");

    fireEvent.click(screen.getByRole("button", { name: "创建经营动作" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("响应已丢失");
    fireEvent.click(screen.getByRole("button", { name: "读取最新版本" }));

    expect(await screen.findByText("已创建正式经营动作")).toBeVisible();
    expect(getProposal).toHaveBeenCalledWith(proposalId);
    await waitFor(() =>
      expect(workspaceApi.listActions).toHaveBeenCalledTimes(2),
    );
  });

  it("preserves user edits when conflict recovery advances the proposal version", async () => {
    const acceptProposal = vi
      .fn()
      .mockRejectedValueOnce(new Error("版本冲突"))
      .mockResolvedValueOnce({
        proposalId,
        status: "accepted",
        actionId,
        versionNo: "3",
        decidedAt: "2026-08-31T06:05:00.000Z",
      });
    render(
      <ActionWorkspace
        api={api({
          acceptProposal,
          getProposal: vi.fn().mockResolvedValue({
            ...proposal,
            title: "服务器的新建议标题",
            versionNo: "2",
          }),
        })}
      />,
    );
    await screen.findByText("待确认建议");
    fireEvent.change(screen.getByLabelText("动作标题"), {
      target: { value: "保留我的编辑" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建经营动作" }));
    await screen.findByText("版本冲突");
    fireEvent.click(screen.getByRole("button", { name: "读取最新版本" }));

    expect(await screen.findByText(/已读取服务器版本 v2/)).toBeVisible();
    expect(screen.getByLabelText("动作标题")).toHaveValue("保留我的编辑");
    fireEvent.click(screen.getByRole("button", { name: "创建经营动作" }));
    await screen.findByText("已创建正式经营动作");
    expect(acceptProposal.mock.calls[1]?.[1]).toMatchObject({
      versionNo: "2",
      title: "保留我的编辑",
    });
  });

  it("requires a rejection reason and records a terminal receipt", async () => {
    const workspaceApi = api();
    render(<ActionWorkspace api={workspaceApi} />);
    await screen.findByText("待确认建议");

    fireEvent.click(screen.getByRole("button", { name: "拒绝建议" }));
    expect(screen.getByRole("button", { name: "确认拒绝" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("拒绝原因"), {
      target: { value: "客户优先级已变化" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认拒绝" }));

    expect(await screen.findByText("建议已拒绝，未创建行动")).toBeVisible();
    expect(workspaceApi.rejectProposal).toHaveBeenCalledWith(
      proposalId,
      { versionNo: "1", reason: "客户优先级已变化" },
      expect.stringMatching(/^reject-/),
    );
  });

  it("transitions only a formal action and refreshes its version", async () => {
    const workspaceApi = api();
    render(<ActionWorkspace api={workspaceApi} />);
    const actionSection = await screen.findByRole("region", {
      name: "正式经营动作",
    });

    fireEvent.click(
      within(actionSection).getByRole("button", { name: "开始执行" }),
    );
    await waitFor(() =>
      expect(workspaceApi.transitionAction).toHaveBeenCalledWith(actionId, {
        versionNo: "1",
        toStatus: "in_progress",
      }),
    );
    expect(within(actionSection).getByText("执行中")).toBeVisible();
  });

  it("renders expired pending rows as disabled terminal suggestions", async () => {
    render(
      <ActionWorkspace
        api={api({
          listProposals: vi.fn().mockResolvedValue({
            items: [
              {
                ...proposal,
                status: "expired",
                expiresAt: "2020-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "建议已过期" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "创建经营动作" }),
    ).not.toBeInTheDocument();
  });

  it("loads additional proposal and action cursor pages", async () => {
    const workspaceApi = api({
      listProposals: vi
        .fn()
        .mockResolvedValueOnce({
          items: [proposal],
          nextCursor: "proposal-next",
        })
        .mockResolvedValueOnce({ items: [secondProposal], nextCursor: null }),
      listActions: vi
        .fn()
        .mockResolvedValueOnce({
          items: [formalAction],
          nextCursor: "action-next",
        })
        .mockResolvedValueOnce({
          items: [
            {
              ...formalAction,
              actionId: "d0000000-0000-4000-8000-000000000004",
            },
          ],
          nextCursor: null,
        }),
    });
    render(<ActionWorkspace api={workspaceApi} />);
    await screen.findByText("待确认建议");

    fireEvent.click(screen.getByRole("button", { name: "加载更多建议" }));
    fireEvent.click(screen.getByRole("button", { name: "加载更多正式动作" }));

    expect(
      await screen.findByRole("button", { name: /确认采购流程/ }),
    ).toBeVisible();
    expect(workspaceApi.listProposals).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "proposal-next" }),
    );
    expect(workspaceApi.listActions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "action-next" }),
    );
  });

  it("discards old proposal and action cursor pages after a full refresh", async () => {
    let resolveOldProposals:
      | ((
          value: Awaited<ReturnType<ActionWorkspaceApi["listProposals"]>>,
        ) => void)
      | undefined;
    let resolveOldActions:
      | ((
          value: Awaited<ReturnType<ActionWorkspaceApi["listActions"]>>,
        ) => void)
      | undefined;
    const oldProposals = new Promise<
      Awaited<ReturnType<ActionWorkspaceApi["listProposals"]>>
    >((resolve) => {
      resolveOldProposals = resolve;
    });
    const oldActions = new Promise<
      Awaited<ReturnType<ActionWorkspaceApi["listActions"]>>
    >((resolve) => {
      resolveOldActions = resolve;
    });
    const freshProposal = {
      ...secondProposal,
      proposalId: "c0000000-0000-4000-8000-000000000005",
      title: "刷新后的建议",
    };
    const freshAction = {
      ...formalAction,
      actionId: "d0000000-0000-4000-8000-000000000005",
      title: "刷新后的动作",
    };
    const listProposals = vi
      .fn()
      .mockResolvedValueOnce({ items: [proposal], nextCursor: "proposal-next" })
      .mockReturnValueOnce(oldProposals)
      .mockResolvedValueOnce({ items: [freshProposal], nextCursor: null });
    const listActions = vi
      .fn()
      .mockResolvedValueOnce({
        items: [formalAction],
        nextCursor: "action-next",
      })
      .mockReturnValueOnce(oldActions)
      .mockResolvedValueOnce({ items: [freshAction], nextCursor: null });
    render(<ActionWorkspace api={api({ listProposals, listActions })} />);
    await screen.findByText("待确认建议");

    fireEvent.click(screen.getByRole("button", { name: "加载更多建议" }));
    fireEvent.click(screen.getByRole("button", { name: "加载更多正式动作" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
    expect(
      await screen.findByRole("button", { name: /刷新后的建议/ }),
    ).toBeVisible();
    expect(screen.getByText("刷新后的动作")).toBeVisible();

    resolveOldProposals?.({ items: [secondProposal], nextCursor: "obsolete" });
    resolveOldActions?.({
      items: [
        {
          ...formalAction,
          actionId: "d0000000-0000-4000-8000-000000000006",
          title: "旧分页动作",
        },
      ],
      nextCursor: "obsolete",
    });
    await waitFor(() => {
      expect(screen.queryByText("确认采购流程")).not.toBeInTheDocument();
      expect(screen.queryByText("旧分页动作")).not.toBeInTheDocument();
    });
  });
});
