import "@testing-library/jest-dom/vitest";

import type {
  ManagementQueryResult,
  ManagementQuerySubjectPage,
} from "@battlefield/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ManagementQueryApiError } from "./api-client";
import {
  ManagementQueryWorkspace,
  type ManagementQueryWorkspaceApi,
} from "./management-query-workspace";

const sellerId = "30000000-0000-4000-8000-000000000001";
const entityId = "50000000-0000-4000-8000-000000000001";
const gapEntityId = "50000000-0000-4000-8000-000000000002";
const actionId = "d0000000-0000-4000-8000-000000000001";
const stateId = "b0000000-0000-4000-8000-000000000001";

const subjectPage: ManagementQuerySubjectPage = {
  items: [
    {
      userId: sellerId,
      displayName: "演示销售",
      scopeKind: "observed_portfolio",
    },
  ],
  nextCursor: null,
};
const result: ManagementQueryResult = {
  queryId: "90000000-0000-4000-8000-000000000091",
  capability: "sales_weekly_progress",
  subject: { userId: sellerId, displayName: "演示销售" },
  period: {
    start: "2026-08-31T00:00:00.000Z",
    end: "2026-09-07T00:00:00.000Z",
  },
  dataCutoffAt: "2026-09-01T04:00:00.000Z",
  scope: { kind: "observed_portfolio", entityCount: 2 },
  metrics: {
    confirmedFollowupCount: 2,
    validFactCount: 3,
    stageChangeCount: 1,
    completedActionCount: 1,
    openActionCount: 2,
    overdueActionCount: 1,
  },
  highlights: [
    {
      entityId,
      entityName: "华东示范客户",
      latestActivityAt: "2026-09-01T03:00:00.000Z",
      confirmedFollowupCount: 2,
      validFactCount: 3,
      stageChangeCount: 1,
      completedActionCount: 1,
      openActionCount: 2,
      overdueActionCount: 1,
      evidence: [
        {
          kind: "action",
          evidenceId: actionId,
          occurredAt: "2026-09-01T03:00:00.000Z",
          label: "提交正式方案",
          deepLink: `/actions?actionId=${actionId}`,
        },
        {
          kind: "battle_state",
          evidenceId: stateId,
          occurredAt: "2026-09-01T02:00:00.000Z",
          label: "关系稳定，潜力较高",
          deepLink: `/battle-map?entityId=${entityId}&stateVersion=${stateId}`,
        },
      ],
    },
  ],
  dataGaps: [
    {
      entityId: gapEntityId,
      entityName: "华南示范客户",
      code: "missing_battle_state",
      message: "当前没有已发布作战状态，不能据此判断风险高低。",
    },
  ],
};

function api(
  overrides: Partial<ManagementQueryWorkspaceApi> = {},
): ManagementQueryWorkspaceApi {
  return {
    listSubjects: vi.fn().mockResolvedValue(subjectPage),
    run: vi.fn().mockResolvedValue(result),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ManagementQueryWorkspace", () => {
  test("loads authorized sellers and prepares an explicit this-week query", async () => {
    render(
      <ManagementQueryWorkspace
        api={api()}
        now={() => new Date("2026-09-01T04:00:00.000Z")}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("正在读取可问销售");
    expect(await screen.findByLabelText("查询销售")).toHaveValue(sellerId);
    expect(screen.getByLabelText("开始日期")).toHaveValue("2026-08-31");
    expect(screen.getByLabelText("结束日期（不含）")).toHaveValue("2026-09-07");
    expect(screen.getByText("销售本周有哪些可核验进展？")).toBeVisible();
  });

  test("renders metrics, evidence links, scope, cutoff and truthful data gaps", async () => {
    const queryApi = api();
    render(
      <ManagementQueryWorkspace
        api={queryApi}
        now={() => new Date("2026-09-01T04:00:00.000Z")}
      />,
    );
    await screen.findByLabelText("查询销售");
    fireEvent.click(screen.getByRole("button", { name: "生成进展答复" }));

    const answer = await screen.findByRole("region", {
      name: "演示销售的经营进展",
    });
    expect(within(answer).getByText("管理观察范围 · 2 个对象")).toBeVisible();
    expect(within(answer).getByText("数据截止")).toBeVisible();
    expect(within(answer).getByText("确认跟进")).toBeVisible();
    expect(within(answer).getByText("有效事实")).toBeVisible();
    expect(within(answer).getByText("华东示范客户")).toBeVisible();
    expect(
      within(answer).getByRole("link", { name: "提交正式方案" }),
    ).toHaveAttribute("href", `/actions?actionId=${actionId}`);
    expect(within(answer).getByText("华南示范客户")).toBeVisible();
    expect(within(answer).getByText(/不能据此判断风险高低/)).toBeVisible();
    expect(queryApi.run).toHaveBeenCalledWith(
      {
        capability: "sales_weekly_progress",
        subjectUserId: sellerId,
        periodStart: "2026-08-31T00:00:00.000Z",
        periodEnd: "2026-09-07T00:00:00.000Z",
      },
      expect.stringMatching(/^management-query-/),
    );
  });

  test("does not invent a result when no seller is currently queryable", async () => {
    render(
      <ManagementQueryWorkspace
        api={api({
          listSubjects: vi
            .fn()
            .mockResolvedValue({ items: [], nextCursor: null }),
        })}
      />,
    );

    expect(await screen.findByText("当前没有可问销售")).toBeVisible();
    expect(screen.getByText(/不会展示同租户的未授权成员/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "生成进展答复" }),
    ).not.toBeInTheDocument();
  });

  test("explains slow subject loading and can retry a failed directory request", async () => {
    vi.useFakeTimers();
    const pending = deferred<ManagementQuerySubjectPage>();
    const listSubjects = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(subjectPage);
    render(<ManagementQueryWorkspace api={api({ listSubjects })} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "仍在核对当前责任关系",
    );
    await act(async () => pending.reject(new Error("销售目录读取失败")));
    expect(screen.getByRole("alert")).toHaveTextContent("销售目录读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重新加载销售" }));
    await act(async () => Promise.resolve());
    expect(screen.getByLabelText("查询销售")).toBeVisible();
  });

  test("validates the explicit period before calling the API", async () => {
    const queryApi = api();
    render(<ManagementQueryWorkspace api={queryApi} />);
    await screen.findByLabelText("查询销售");
    fireEvent.change(screen.getByLabelText("结束日期（不含）"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成进展答复" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "结束日期必须晚于开始日期",
    );
    expect(queryApi.run).not.toHaveBeenCalled();
  });

  test("shows slow query feedback and retries a failed query", async () => {
    vi.useFakeTimers();
    const pending = deferred<ManagementQueryResult>();
    const run = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result);
    render(
      <ManagementQueryWorkspace
        api={api({ run })}
        idempotencyKeyFactory={() => "management-query-retry-key"}
      />,
    );
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "生成进展答复" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "仍在汇总责任范围内的事实与动作",
    );
    await act(async () => pending.reject(new Error("问数服务暂不可用")));
    expect(screen.getByRole("alert")).toHaveTextContent("问数服务暂不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试本次查询" }));
    await act(async () => Promise.resolve());
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      "management-query-retry-key",
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      "management-query-retry-key",
    );
    expect(
      screen.getByRole("region", { name: "演示销售的经营进展" }),
    ).toBeVisible();
  });

  test("reuses the failed attempt key from the primary submit button too", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("连接中断"))
      .mockResolvedValueOnce(result);
    const idempotencyKeyFactory = vi
      .fn()
      .mockReturnValueOnce("management-query-primary-retry")
      .mockReturnValueOnce("management-query-should-not-be-used");
    render(
      <ManagementQueryWorkspace
        api={api({ run })}
        idempotencyKeyFactory={idempotencyKeyFactory}
      />,
    );
    await screen.findByLabelText("查询销售");
    fireEvent.click(screen.getByRole("button", { name: "生成进展答复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("连接中断");

    fireEvent.click(screen.getByRole("button", { name: "重新生成答复" }));
    await act(async () => Promise.resolve());

    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      "management-query-primary-retry",
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      "management-query-primary-retry",
    );
    expect(idempotencyKeyFactory).toHaveBeenCalledTimes(1);
  });

  test("starts a user-confirmed fresh attempt after an idempotency scope conflict", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new ManagementQueryApiError(
          409,
          "MANAGEMENT_QUERY_IDEMPOTENCY_CONFLICT",
          "The authorized scope changed.",
        ),
      )
      .mockResolvedValueOnce(result);
    const idempotencyKeyFactory = vi
      .fn()
      .mockReturnValueOnce("management-query-old-scope")
      .mockReturnValueOnce("management-query-current-scope");
    render(
      <ManagementQueryWorkspace
        api={api({ run })}
        idempotencyKeyFactory={idempotencyKeyFactory}
      />,
    );
    await screen.findByLabelText("查询销售");
    fireEvent.click(screen.getByRole("button", { name: "生成进展答复" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "授权范围已变化",
    );
    fireEvent.click(screen.getByRole("button", { name: "按当前范围重新查询" }));
    await act(async () => Promise.resolve());

    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      "management-query-old-scope",
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      "management-query-current-scope",
    );
    expect(idempotencyKeyFactory).toHaveBeenCalledTimes(2);
  });

  test("disables submission and suppresses duplicate execution while a query runs", async () => {
    const pending = deferred<ManagementQueryResult>();
    const run = vi.fn().mockReturnValue(pending.promise);
    render(<ManagementQueryWorkspace api={api({ run })} />);
    await screen.findByLabelText("查询销售");
    const submit = screen.getByRole("button", { name: "生成进展答复" });
    fireEvent.click(submit);

    expect(
      screen.getByRole("button", { name: "正在生成答复…" }),
    ).toBeDisabled();
    fireEvent.submit(submit.closest("form") as HTMLFormElement);
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () =>
      pending.resolve({
        ...result,
        subject: { ...result.subject, displayName: "唯一结果" },
      }),
    );
    expect(
      await screen.findByRole("region", { name: "唯一结果的经营进展" }),
    ).toBeVisible();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
