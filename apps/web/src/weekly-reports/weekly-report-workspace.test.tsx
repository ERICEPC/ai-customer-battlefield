import "@testing-library/jest-dom/vitest";

import type {
  ReviewWeeklyReportRequest,
  WeeklyReportDetail,
  WeeklyReportListItem,
  WeeklyReportPage,
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

import { WeeklyReportApiError } from "./api-client";
import {
  WeeklyReportWorkspace,
  type WeeklyReportWorkspaceApi,
} from "./weekly-report-workspace";

const reportId = "91000000-0000-4000-8000-000000000001";
const versionId = "92000000-0000-4000-8000-000000000001";
const entityId = "50000000-0000-4000-8000-000000000001";
const actionId = "d0000000-0000-4000-8000-000000000001";
const stateId = "b0000000-0000-4000-8000-000000000001";

const detail: WeeklyReportDetail = {
  reportId,
  versionId,
  reportType: "personal",
  revisionNo: 1,
  lockVersion: 1,
  status: "in_review",
  title: "个人周报",
  note: "",
  period: {
    start: "2026-08-24T00:00:00.000Z",
    end: "2026-08-31T00:00:00.000Z",
  },
  dataCutoffAt: "2026-08-31T00:00:00.000Z",
  scope: { label: "本人责任范围", entityCount: 1, contributorCount: 1 },
  metrics: {
    confirmedFollowupCount: 2,
    validFactCount: 1,
    stageChangeCount: 1,
    completedActionCount: 1,
    openActionCount: 1,
    overdueActionCount: 1,
  },
  generator: { kind: "deterministic", version: "weekly-progress-v1" },
  sections: [
    {
      kind: "progress",
      items: [
        {
          itemId: "93000000-0000-4000-8000-000000000001",
          sectionKind: "progress",
          entityId,
          entityName: "华东示范客户",
          title: "本周确认进展",
          summary: "2 次已确认跟进，1 条有效事实，1 次阶段变化，1 个已完成动作",
          severity: "positive",
          occurredAt: "2026-08-30T03:00:00.000Z",
          included: true,
          sortOrder: 0,
          contributors: [
            {
              userId: "30000000-0000-4000-8000-000000000001",
              displayName: "演示销售",
            },
          ],
          evidence: [
            {
              kind: "action",
              evidenceId: actionId,
              occurredAt: "2026-08-30T03:00:00.000Z",
              label: "完成正式方案",
              deepLink: `/actions?actionId=${actionId}`,
            },
          ],
        },
      ],
    },
    {
      kind: "risk",
      items: [
        {
          itemId: "93000000-0000-4000-8000-000000000002",
          sectionKind: "risk",
          entityId,
          entityName: "华东示范客户",
          title: "风险与阻塞",
          summary: "1 个正式动作已逾期；作战风险为高。",
          severity: "critical",
          occurredAt: "2026-08-30T02:00:00.000Z",
          included: true,
          sortOrder: 0,
          contributors: [],
          evidence: [
            {
              kind: "battle_state",
              evidenceId: stateId,
              occurredAt: "2026-08-30T02:00:00.000Z",
              label: "预算风险仍待确认",
              deepLink: `/battle-map?entityId=${entityId}&stateVersion=${stateId}`,
            },
          ],
        },
      ],
    },
    {
      kind: "next_action",
      items: [
        {
          itemId: "93000000-0000-4000-8000-000000000003",
          sectionKind: "next_action",
          entityId,
          entityName: "华东示范客户",
          title: "下一步正式动作",
          summary: "1 个动作待推进。",
          severity: "info",
          occurredAt: "2026-08-29T02:00:00.000Z",
          included: true,
          sortOrder: 0,
          contributors: [],
          evidence: [
            {
              kind: "action",
              evidenceId: actionId,
              occurredAt: "2026-08-29T02:00:00.000Z",
              label: "准备决策材料",
              deepLink: `/actions?actionId=${actionId}`,
            },
          ],
        },
      ],
    },
    {
      kind: "data_gap",
      items: [
        {
          itemId: "93000000-0000-4000-8000-000000000004",
          sectionKind: "data_gap",
          entityId,
          entityName: "华东示范客户",
          title: "缺少作战状态",
          summary: "当前没有截止时点前的已发布作战状态。",
          severity: "warning",
          occurredAt: null,
          included: true,
          sortOrder: 0,
          contributors: [],
          evidence: [],
        },
      ],
    },
  ],
  previousVersionId: null,
  createdAt: "2026-08-31T01:00:00.000Z",
  publishedAt: null,
  capabilities: { canReview: true, canPublish: true, canRevise: false },
};

const historyItem: WeeklyReportListItem = {
  reportId,
  versionId,
  reportType: "personal",
  revisionNo: 1,
  status: "in_review",
  title: "个人周报",
  period: detail.period,
  dataCutoffAt: detail.dataCutoffAt,
  entityCount: 1,
  createdAt: detail.createdAt,
  publishedAt: null,
};

function api(
  overrides: Partial<WeeklyReportWorkspaceApi> = {},
): WeeklyReportWorkspaceApi {
  return {
    list: vi.fn().mockResolvedValue({ items: [historyItem], nextCursor: null }),
    get: vi.fn().mockResolvedValue(detail),
    generate: vi.fn().mockResolvedValue(detail),
    review: vi
      .fn()
      .mockImplementation(
        async (_versionId: string, input: ReviewWeeklyReportRequest) => ({
          ...detail,
          lockVersion: detail.lockVersion + 1,
          note: input.note,
          sections: detail.sections.map((section) => ({
            ...section,
            items: section.items.map((item) => ({
              ...item,
              included:
                input.items.find(
                  (candidate) => candidate.itemId === item.itemId,
                )?.included ?? item.included,
            })),
          })),
        }),
      ),
    publish: vi.fn().mockResolvedValue({
      ...detail,
      lockVersion: 2,
      status: "published",
      publishedAt: "2026-08-31T03:00:00.000Z",
      capabilities: { canReview: false, canPublish: false, canRevise: true },
    }),
    revise: vi.fn().mockResolvedValue({
      ...detail,
      versionId: "92000000-0000-4000-8000-000000000002",
      revisionNo: 2,
      previousVersionId: versionId,
    }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WeeklyReportWorkspace", () => {
  test("opens an exact version and renders truthful scope, metadata, four sections and evidence", async () => {
    const reportApi = api();
    render(
      <WeeklyReportWorkspace
        api={reportApi}
        initialVersionId={versionId}
        now={() => new Date("2026-08-31T04:00:00.000Z")}
      />,
    );

    const report = await screen.findByRole("region", {
      name: "个人周报 第1版",
    });
    expect(reportApi.get).toHaveBeenCalledWith(versionId);
    expect(within(report).getByText("本人责任范围 · 1 个对象")).toBeVisible();
    expect(within(report).getByText("数据截止")).toBeVisible();
    expect(
      within(report).getByText("确定性生成 · weekly-progress-v1"),
    ).toBeVisible();
    for (const heading of [
      "本周进展",
      "风险与阻塞",
      "下一步动作",
      "数据缺口",
    ]) {
      expect(
        within(report).getByRole("heading", { name: heading, level: 3 }),
      ).toBeVisible();
    }
    expect(
      within(report).getByRole("link", { name: "完成正式方案" }),
    ).toHaveAttribute("href", `/actions?actionId=${actionId}`);
    expect(
      within(report).getByText("当前没有截止时点前的已发布作战状态。"),
    ).toBeVisible();
  });

  test("generates an explicit managed-scope week without inventing a team", async () => {
    const reportApi = api();
    render(
      <WeeklyReportWorkspace
        api={reportApi}
        now={() => new Date("2026-08-31T04:00:00.000Z")}
        idempotencyKeyFactory={() => "weekly-generate-key"}
      />,
    );
    await screen.findByRole("button", { name: /个人周报 · 第1版/ });
    fireEvent.change(screen.getByLabelText("周报类型"), {
      target: { value: "managed_portfolio" },
    });
    fireEvent.change(screen.getByLabelText("开始日期"), {
      target: { value: "2026-08-17" },
    });
    fireEvent.change(screen.getByLabelText("结束日期（不含）"), {
      target: { value: "2026-08-24" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成周报" }));

    await act(async () => Promise.resolve());
    expect(reportApi.generate).toHaveBeenCalledWith(
      {
        reportType: "managed_portfolio",
        periodStart: "2026-08-17T00:00:00.000Z",
        periodEnd: "2026-08-24T00:00:00.000Z",
      },
      "weekly-generate-key",
    );
    expect(screen.getByText(/仅汇总当前管理关注范围/)).toBeVisible();
    expect(screen.queryByText(/全团队周报/)).not.toBeInTheDocument();
  });

  test("saves inclusion and note, publishes, then creates an immutable revision", async () => {
    const reportApi = api();
    render(
      <WeeklyReportWorkspace
        api={reportApi}
        initialVersionId={versionId}
        idempotencyKeyFactory={() => "weekly-transition-key"}
      />,
    );
    await screen.findByRole("region", { name: "个人周报 第1版" });
    fireEvent.click(screen.getByLabelText("不纳入：本周确认进展"));
    fireEvent.change(screen.getByLabelText("审阅备注"), {
      target: { value: "已核对关键风险。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存审阅" }));
    expect(await screen.findByText("审阅已保存")).toBeVisible();
    expect(reportApi.review).toHaveBeenCalledWith(
      versionId,
      expect.objectContaining({
        lockVersion: 1,
        note: "已核对关键风险。",
        items: expect.arrayContaining([
          {
            itemId: "93000000-0000-4000-8000-000000000001",
            included: false,
          },
        ]),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "发布正式版本" }));
    expect(await screen.findByText("发布完成 · 通知独立投递")).toBeVisible();
    expect(reportApi.publish).toHaveBeenCalledWith(
      versionId,
      { lockVersion: 2 },
      "weekly-transition-key",
    );
    fireEvent.click(screen.getByRole("button", { name: "创建修订版" }));
    await act(async () => Promise.resolve());
    expect(reportApi.revise).toHaveBeenCalledWith(
      versionId,
      { lockVersion: 2 },
      "weekly-transition-key",
    );
  });

  test("explains optimistic conflicts and reloads the exact current version", async () => {
    const reportApi = api({
      review: vi
        .fn()
        .mockRejectedValue(
          new WeeklyReportApiError(
            409,
            "WEEKLY_REPORT_VERSION_CONFLICT",
            "版本已变化。",
          ),
        ),
    });
    render(
      <WeeklyReportWorkspace api={reportApi} initialVersionId={versionId} />,
    );
    await screen.findByRole("region", { name: "个人周报 第1版" });
    fireEvent.click(screen.getByRole("button", { name: "保存审阅" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "版本已变化，请重新载入后再审阅",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新载入当前版本" }));
    await act(async () => Promise.resolve());
    expect(reportApi.get).toHaveBeenCalledTimes(2);
  });

  test("shows slow, empty and recoverable history states", async () => {
    vi.useFakeTimers();
    const pending = deferred<WeeklyReportPage>();
    const list = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    render(<WeeklyReportWorkspace api={api({ list })} />);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole("status")).toHaveTextContent("仍在读取周报历史");
    await act(async () => pending.reject(new Error("历史读取失败")));
    expect(screen.getByRole("alert")).toHaveTextContent("历史读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重新加载周报" }));
    await act(async () => Promise.resolve());
    expect(screen.getByText("还没有周报版本")).toBeVisible();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
