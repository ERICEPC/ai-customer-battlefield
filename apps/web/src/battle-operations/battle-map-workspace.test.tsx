import "@testing-library/jest-dom/vitest";

import type {
  BattleAnalysisResult,
  BattleMapItem,
  BattleMapPage,
  BattleStateDetail,
  BattleStateRecord,
} from "@battlefield/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BattleMapWorkspace,
  type BattleMapWorkspaceApi,
} from "./battle-map-workspace";

const entityId = "50000000-0000-4000-8000-000000000001";
const stateId = "b0000000-0000-4000-8000-000000000001";
const factId = "90000000-0000-4000-8000-000000000001";

const mappedState = {
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
  summary: "预算已确认，关系与潜力均较强。",
  analysisRunId: "a0000000-0000-4000-8000-000000000001",
  effectiveAt: "2026-08-31T05:00:00.000Z",
  evidenceFactIds: [factId],
} satisfies BattleStateRecord;

const mappedItem: BattleMapItem = {
  entityId,
  entityName: "Aurora Systems",
  entityTypeCode: "customer",
  isT0: true,
  primaryOwnerName: "销售甲",
  state: mappedState,
};

const unmappedItem: BattleMapItem = {
  entityId: "50000000-0000-4000-8000-000000000002",
  entityName: "Beacon Labs",
  entityTypeCode: "partner",
  isT0: false,
  primaryOwnerName: null,
  state: null,
};

const detail: BattleStateDetail = {
  state: mappedState,
  evidenceFacts: [
    {
      factId,
      factType: "budget_status",
      factValue: "预算已确认",
      occurredAt: "2026-08-31T04:30:00.000Z",
      opportunityId: null,
    },
  ],
  signals: [
    {
      signalId: "91000000-0000-4000-8000-000000000001",
      factId,
      dimension: "potential",
      direction: "positive",
      strength: 80,
      reason: "已确认预算。",
    },
  ],
};

function api(overrides: Partial<BattleMapWorkspaceApi> = {}) {
  return {
    listMap: vi.fn().mockResolvedValue({
      items: [mappedItem, unmappedItem],
      nextCursor: null,
    } satisfies BattleMapPage),
    getState: vi.fn().mockResolvedValue(detail),
    requestAnalysis: vi.fn().mockResolvedValue({
      analysisRunId: "a0000000-0000-4000-8000-000000000002",
      entityId,
      inputVersion: "a".repeat(64),
      status: "completed",
      startedAt: "2026-08-31T05:00:00.000Z",
      finishedAt: "2026-08-31T05:00:01.000Z",
      battleStateVersionId: stateId,
      battleStateVersionNo: "2",
      proposalIds: [],
    } satisfies BattleAnalysisResult),
    ...overrides,
  } satisfies BattleMapWorkspaceApi;
}

afterEach(cleanup);

describe("BattleMapWorkspace", () => {
  it("renders KPI, T0, non-color plot encoding and an accessible list", async () => {
    render(<BattleMapWorkspace api={api()} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载作战地图");
    expect(
      (await screen.findAllByText("Aurora Systems")).length,
    ).toBeGreaterThan(1);
    expect(screen.getByRole("heading", { name: "T0 战略对象" })).toBeVisible();
    expect(screen.getByText("预算已确认，关系与潜力均较强。")).toBeVisible();
    expect(await screen.findByText("预算已确认")).toBeVisible();
    expect(await screen.findByText("已确认预算。")).toBeVisible();

    const point = screen.getByRole("button", {
      name: /Aurora Systems.*关系 72.50.*潜力 81.00/,
    });
    expect(point).toHaveAttribute("data-shape", "diamond");
    const table = screen.getByRole("table", { name: "作战地图等价列表" });
    expect(within(table).getByText("数据未计算")).toBeVisible();
  });

  it("selects and identifies an action-proposal source deep link", async () => {
    const historical = {
      ...detail,
      state: { ...detail.state, versionNo: "1", summary: "历史来源证据" },
    };
    const workspaceApi = api({
      listMap: vi.fn().mockImplementation((query) =>
        Promise.resolve({
          items: query.entityId ? [mappedItem] : [unmappedItem],
          nextCursor: null,
        }),
      ),
      getState: vi
        .fn()
        .mockImplementation((_entityId, versionId) =>
          Promise.resolve(versionId ? historical : detail),
        ),
    });
    render(
      <BattleMapWorkspace
        api={workspaceApi}
        initialEntityId={entityId}
        sourceStateVersionId={stateId}
      />,
    );

    expect(
      await screen.findByText("已定位到该建议的来源状态版本。"),
    ).toBeVisible();
    expect(await screen.findByText("历史来源证据")).toBeVisible();
    expect(workspaceApi.listMap).toHaveBeenCalledWith({
      entityId,
      limit: 1,
    });
    expect(workspaceApi.getState).toHaveBeenCalledWith(entityId, stateId);
  });

  it("responds to a deep-link target change on the same mounted route", async () => {
    const secondStateId = "b0000000-0000-4000-8000-000000000002";
    const secondDetail = {
      ...detail,
      state: {
        ...detail.state,
        battleStateVersionId: secondStateId,
        entityId: unmappedItem.entityId,
        summary: "第二个来源版本",
      },
    };
    const workspaceApi = api({
      listMap: vi.fn().mockImplementation((query) =>
        Promise.resolve({
          items:
            query.entityId === unmappedItem.entityId
              ? [{ ...unmappedItem, state: secondDetail.state }]
              : [mappedItem],
          nextCursor: null,
        }),
      ),
      getState: vi
        .fn()
        .mockImplementation((targetId) =>
          Promise.resolve(
            targetId === unmappedItem.entityId ? secondDetail : detail,
          ),
        ),
    });
    const rendered = render(
      <BattleMapWorkspace
        api={workspaceApi}
        initialEntityId={entityId}
        sourceStateVersionId={stateId}
      />,
    );
    await screen.findByText("已定位到该建议的来源状态版本。");

    rendered.rerender(
      <BattleMapWorkspace
        api={workspaceApi}
        initialEntityId={unmappedItem.entityId}
        sourceStateVersionId={secondStateId}
      />,
    );

    expect(await screen.findByText("第二个来源版本")).toBeVisible();
    expect(workspaceApi.getState).toHaveBeenCalledWith(
      unmappedItem.entityId,
      secondStateId,
    );
  });

  it("reads immutable source evidence even when the current projection is absent", async () => {
    const historical = {
      ...detail,
      state: { ...detail.state, versionNo: "1", summary: "仅历史版本存在" },
    };
    const workspaceApi = api({
      listMap: vi.fn().mockImplementation((query) =>
        Promise.resolve({
          items: query.entityId ? [{ ...mappedItem, state: null }] : [],
          nextCursor: null,
        }),
      ),
      getState: vi.fn().mockResolvedValue(historical),
    });

    render(
      <BattleMapWorkspace
        api={workspaceApi}
        initialEntityId={entityId}
        sourceStateVersionId={stateId}
      />,
    );

    expect(await screen.findByText("仅历史版本存在")).toBeVisible();
    expect(workspaceApi.getState).toHaveBeenCalledWith(entityId, stateId);
  });

  it("keeps a source target outside filtered KPI, plot and list results", async () => {
    const workspaceApi = api({
      listMap: vi.fn().mockImplementation((query) => {
        if (query.entityId) {
          return Promise.resolve({ items: [unmappedItem], nextCursor: null });
        }
        return Promise.resolve({
          items: query.isT0 ? [mappedItem] : [mappedItem, unmappedItem],
          nextCursor: null,
        });
      }),
    });
    render(
      <BattleMapWorkspace
        api={workspaceApi}
        initialEntityId={unmappedItem.entityId}
        sourceStateVersionId={stateId}
      />,
    );
    await screen.findByRole("heading", { name: "Beacon Labs" });

    fireEvent.click(screen.getByRole("checkbox", { name: "只看 T0" }));

    expect(await screen.findByLabelText("已加载对象 1")).toBeVisible();
    expect(
      within(
        screen.getByRole("table", { name: "作战地图等价列表" }),
      ).queryByText("Beacon Labs"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Beacon Labs" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Beacon Labs.*关系/ }),
    ).not.toBeInTheDocument();
  });

  it("treats insufficient data as a visible gap instead of inventing a point", async () => {
    const insufficient = {
      ...mappedItem,
      state: {
        ...mappedState,
        relationshipScore: null,
        potentialScore: null,
        quadrantCode: null,
        dataSufficiency: "insufficient" as const,
        dataGaps: ["缺少可验证的客户互动事实"],
        summary: "当前事实不足，无法判断作战位置。",
      },
    };
    render(
      <BattleMapWorkspace
        api={api({
          listMap: vi.fn().mockResolvedValue({
            items: [insufficient],
            nextCursor: null,
          }),
          getState: vi.fn().mockResolvedValue({
            state: insufficient.state,
            evidenceFacts: [],
            signals: [],
          }),
        })}
      />,
    );

    expect(await screen.findByText("缺少可验证的客户互动事实")).toBeVisible();
    expect(screen.queryByTestId("battle-map-point")).not.toBeInTheDocument();
    expect(screen.getByLabelText("数据不足 1")).toBeVisible();
  });

  it("recomputes a selected entity and refreshes map plus evidence", async () => {
    const workspaceApi = api();
    render(<BattleMapWorkspace api={workspaceApi} />);
    await screen.findAllByText("Aurora Systems");

    fireEvent.click(screen.getByRole("button", { name: "重新计算战场位置" }));

    await waitFor(() =>
      expect(workspaceApi.requestAnalysis).toHaveBeenCalledWith(entityId),
    );
    await waitFor(() => expect(workspaceApi.listMap).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(workspaceApi.getState).toHaveBeenCalledTimes(2);
  });

  it("does not render an old analysis result after selection changes", async () => {
    let resolveAnalysis: ((value: BattleAnalysisResult) => void) | undefined;
    const pendingAnalysis = new Promise<BattleAnalysisResult>((resolve) => {
      resolveAnalysis = resolve;
    });
    const workspaceApi = api({ requestAnalysis: vi.fn(() => pendingAnalysis) });
    render(<BattleMapWorkspace api={workspaceApi} />);
    await screen.findAllByText("Aurora Systems");

    fireEvent.click(screen.getByRole("button", { name: "重新计算战场位置" }));
    fireEvent.click(screen.getByRole("button", { name: "Beacon Labs" }));
    resolveAnalysis?.(await api().requestAnalysis(entityId));

    await waitFor(() =>
      expect(workspaceApi.requestAnalysis).toHaveBeenCalled(),
    );
    expect(screen.getByRole("heading", { name: "Beacon Labs" })).toBeVisible();
    expect(screen.queryByText("分析已更新至版本 2")).not.toBeInTheDocument();
    expect(screen.queryByText("预算已确认")).not.toBeInTheDocument();
  });

  it("keeps analyzer failures actionable and retryable", async () => {
    const workspaceApi = api({
      requestAnalysis: vi
        .fn()
        .mockRejectedValueOnce(new Error("分析服务暂时不可用"))
        .mockResolvedValueOnce(api().requestAnalysis(entityId)),
    });
    render(<BattleMapWorkspace api={workspaceApi} />);
    await screen.findAllByText("Aurora Systems");

    fireEvent.click(screen.getByRole("button", { name: "重新计算战场位置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "分析服务暂时不可用",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试分析" }));
    await waitFor(() =>
      expect(workspaceApi.requestAnalysis).toHaveBeenCalledTimes(2),
    );
  });

  it("reports a superseded first analysis without requiring a current state", async () => {
    const workspaceApi = api({
      requestAnalysis: vi.fn().mockResolvedValue({
        analysisRunId: "a0000000-0000-4000-8000-000000000003",
        entityId,
        inputVersion: "b".repeat(64),
        status: "superseded",
        startedAt: "2026-08-31T05:00:00.000Z",
        finishedAt: "2026-08-31T05:00:01.000Z",
        battleStateVersionId: null,
        battleStateVersionNo: null,
        proposalIds: [],
      }),
      getState: vi
        .fn()
        .mockResolvedValueOnce(detail)
        .mockRejectedValueOnce(new Error("当前状态不存在")),
    });
    render(<BattleMapWorkspace api={workspaceApi} />);
    await screen.findAllByText("Aurora Systems");

    fireEvent.click(screen.getByRole("button", { name: "重新计算战场位置" }));

    expect(
      await screen.findByText("事实已变化，本次旧分析未覆盖当前状态。"),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("loads cursor pages without hiding older map objects", async () => {
    const workspaceApi = api({
      listMap: vi
        .fn()
        .mockResolvedValueOnce({ items: [mappedItem], nextCursor: "map-next" })
        .mockResolvedValueOnce({ items: [unmappedItem], nextCursor: null }),
    });
    render(<BattleMapWorkspace api={workspaceApi} />);
    await screen.findAllByText("Aurora Systems");

    fireEvent.click(screen.getByRole("button", { name: "加载更多地图对象" }));

    expect((await screen.findAllByText("Beacon Labs")).length).toBeGreaterThan(
      0,
    );
    expect(workspaceApi.listMap).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "map-next" }),
    );
  });

  it("does not let an obsolete slow filter response overwrite the latest map", async () => {
    let resolveFirst: ((value: BattleMapPage) => void) | undefined;
    const first = new Promise<BattleMapPage>((resolve) => {
      resolveFirst = resolve;
    });
    const listMap = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ items: [unmappedItem], nextCursor: null });
    render(<BattleMapWorkspace api={api({ listMap })} />);

    fireEvent.change(screen.getByLabelText("数据充分度"), {
      target: { value: "partial" },
    });
    expect((await screen.findAllByText("Beacon Labs")).length).toBeGreaterThan(
      1,
    );

    resolveFirst?.({ items: [mappedItem], nextCursor: null });
    await waitFor(() =>
      expect(screen.queryByText("Aurora Systems")).not.toBeInTheDocument(),
    );
  });

  it("discards an old cursor page after the filter generation changes", async () => {
    let resolveOldPage: ((value: BattleMapPage) => void) | undefined;
    const oldPage = new Promise<BattleMapPage>((resolve) => {
      resolveOldPage = resolve;
    });
    const listMap = vi
      .fn()
      .mockResolvedValueOnce({ items: [mappedItem], nextCursor: "map-next" })
      .mockReturnValueOnce(oldPage)
      .mockResolvedValueOnce({ items: [unmappedItem], nextCursor: null });
    render(<BattleMapWorkspace api={api({ listMap })} />);
    await screen.findAllByText("Aurora Systems");

    fireEvent.click(screen.getByRole("button", { name: "加载更多地图对象" }));
    fireEvent.change(screen.getByLabelText("数据充分度"), {
      target: { value: "partial" },
    });
    expect((await screen.findAllByText("Beacon Labs")).length).toBeGreaterThan(
      1,
    );
    resolveOldPage?.({ items: [mappedItem], nextCursor: "obsolete-next" });

    await waitFor(() =>
      expect(screen.queryByText("Aurora Systems")).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "加载更多地图对象" }),
    ).not.toBeInTheDocument();
  });
});
