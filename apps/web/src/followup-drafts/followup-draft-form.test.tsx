import "@testing-library/jest-dom/vitest";

import type {
  BusinessEntityPage,
  FollowupConfirmationResponse,
  FollowupDraftResponse,
  FormalFollowupRecord,
} from "@battlefield/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FollowupApiError } from "./api-client";
import {
  FollowupDraftForm,
  type FollowupWorkbenchApi,
} from "./followup-draft-form";

const entityId = "50000000-0000-4000-8000-000000000001";
const draftId = "70000000-0000-4000-8000-000000000001";
const followupId = "80000000-0000-4000-8000-000000000001";

const entities: BusinessEntityPage = {
  items: [
    {
      id: entityId,
      typeCode: "customer",
      name: "Aurora Systems",
      shortName: null,
      status: "active",
      isT0: true,
      primaryOwnerName: "alpha-owner",
      primaryOpportunity: null,
      updatedAt: "2026-08-31T02:30:00.000Z",
      versionNo: "1",
    },
  ],
  nextCursor: null,
};

function pendingDraft(
  overrides: Partial<FollowupDraftResponse> = {},
): FollowupDraftResponse {
  return {
    draftId,
    status: "pending_confirmation",
    rawInput: "客户确认预算，下一步提交方案",
    candidate: {
      entityId,
      summary: "客户确认预算，下一步提交方案",
      occurredAt: "2026-08-31T02:30:00.000Z",
      followupType: "other",
      relatedOpportunityIds: [],
      primaryOpportunityId: null,
      facts: [],
    },
    versionNo: "1",
    createdAt: "2026-08-31T02:30:00.000Z",
    updatedAt: "2026-08-31T02:30:00.000Z",
    expiresAt: "2026-09-07T02:30:00.000Z",
    confirmedAt: null,
    confirmedBy: null,
    cancelledAt: null,
    followupId: null,
    agentExecution: {
      provider: "senseaudio",
      model: "senseaudio-s2-flash",
      promptVersion: "followup-extraction-v1",
      status: "succeeded",
      providerRequestId: "resp-demo",
      durationMs: 1234,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    },
    ...overrides,
  };
}

const confirmation: FollowupConfirmationResponse = {
  draftId,
  status: "confirmed",
  followupId,
  eventId: "90000000-0000-4000-8000-000000000001",
  versionNo: "2",
  confirmedAt: "2026-08-31T02:35:00.000Z",
};

const formalFollowup: FormalFollowupRecord = {
  followupId,
  sourceDraftId: draftId,
  entityId,
  occurredAt: "2026-08-31T02:30:00.000Z",
  followupType: "meeting",
  summary: "客户确认预算；销售需在下周提交方案",
  submittedBy: "30000000-0000-4000-8000-000000000001",
  confirmedBy: "30000000-0000-4000-8000-000000000001",
  confirmedAt: "2026-08-31T02:35:00.000Z",
  relatedOpportunityIds: [],
  primaryOpportunityId: null,
  facts: [
    {
      factType: "budget_status",
      factValue: "预算已确认",
      opportunityId: null,
    },
  ],
};

function api(overrides: Partial<FollowupWorkbenchApi> = {}) {
  return {
    listEntities: vi.fn().mockResolvedValue(entities),
    createDraft: vi.fn().mockResolvedValue(pendingDraft()),
    getDraft: vi.fn().mockResolvedValue(pendingDraft()),
    getFormalFollowup: vi.fn().mockResolvedValue(formalFollowup),
    reviseDraft: vi.fn().mockImplementation(async (_draftId, request) =>
      pendingDraft({
        candidate: request.candidate,
        versionNo: "2",
        updatedAt: "2026-08-31T02:32:00.000Z",
      }),
    ),
    cancelDraft: vi.fn().mockResolvedValue(
      pendingDraft({
        status: "cancelled",
        versionNo: "2",
        cancelledAt: "2026-08-31T02:34:00.000Z",
      }),
    ),
    confirmDraft: vi.fn().mockResolvedValue(confirmation),
    ...overrides,
  } satisfies FollowupWorkbenchApi;
}

afterEach(cleanup);

describe("FollowupDraftForm", () => {
  it("loads business entities and requires both a selection and meaningful input", async () => {
    const workbenchApi = api();
    render(<FollowupDraftForm api={workbenchApi} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载经营对象");
    expect(
      await screen.findByRole("option", { name: "Aurora Systems" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "生成跟进草稿" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("经营对象"), {
      target: { value: entityId },
    });
    fireEvent.change(screen.getByLabelText("本次客户跟进"), {
      target: { value: "客户确认预算" },
    });
    expect(screen.getByRole("button", { name: "生成跟进草稿" })).toBeEnabled();
  });

  it("creates a persistent draft for the selected entity with trimmed input", async () => {
    const workbenchApi = api();
    render(<FollowupDraftForm api={workbenchApi} />);
    await screen.findByRole("option", { name: "Aurora Systems" });

    fireEvent.change(screen.getByLabelText("经营对象"), {
      target: { value: entityId },
    });
    fireEvent.change(screen.getByLabelText("本次客户跟进"), {
      target: { value: "  客户确认预算，下一步提交方案  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成跟进草稿" }));

    expect(await screen.findByText("人工确认区")).toBeVisible();
    expect(screen.getByText("AI 已完成结构化拆解")).toBeVisible();
    expect(screen.getByText("待人工确认，尚未写入正式记录")).toBeVisible();
    expect(screen.getByText("senseaudio-s2-flash")).toBeVisible();
    expect(screen.getByText("followup-extraction-v1")).toBeVisible();
    expect(screen.getByText("运行成功 · 1.2 秒 · 150 tokens")).toBeVisible();
    expect(workbenchApi.createDraft).toHaveBeenCalledWith({
      entityId,
      rawInput: "客户确认预算，下一步提交方案",
    });
  });

  it("shows safe Agent retry guidance and preserves the original input", async () => {
    const createDraft = vi.fn().mockRejectedValue(
      new FollowupApiError(503, {
        code: "AGENT_UNAVAILABLE",
        message: "AI 拆解服务暂时不可用，请稍后重试。你的输入尚未入库。",
        requestId: "request-agent-001",
      }),
    );
    render(<FollowupDraftForm api={api({ createDraft })} />);
    await screen.findByRole("option", { name: "Aurora Systems" });
    fireEvent.change(screen.getByLabelText("经营对象"), {
      target: { value: entityId },
    });
    fireEvent.change(screen.getByLabelText("本次客户跟进"), {
      target: { value: "客户确认预算，下周提交方案。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成跟进草稿" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "AI 拆解服务暂时不可用，请稍后重试。你的输入尚未入库。",
    );
    expect(screen.getByLabelText("本次客户跟进")).toHaveValue(
      "客户确认预算，下周提交方案。",
    );
    expect(screen.queryByText("人工确认区")).not.toBeInTheDocument();
  });

  it("saves dirty edits before confirming the new version", async () => {
    const workbenchApi = api();
    render(<FollowupDraftForm api={workbenchApi} />);
    await generateDraft();

    fireEvent.change(screen.getByLabelText("确认摘要"), {
      target: { value: "客户确认预算；销售需在下周提交方案" },
    });
    fireEvent.change(screen.getByLabelText("跟进方式"), {
      target: { value: "meeting" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加经营事实" }));
    fireEvent.change(screen.getByLabelText("事实类型 1"), {
      target: { value: "budget_status" },
    });
    fireEvent.change(screen.getByLabelText("事实内容 1"), {
      target: { value: "预算已确认" },
    });
    fireEvent.click(screen.getByLabelText("我已核对以上内容"));
    fireEvent.click(screen.getByRole("button", { name: "确认并写入正式跟进" }));

    expect(await screen.findByText("已写入正式跟进")).toBeVisible();
    expect(workbenchApi.reviseDraft).toHaveBeenCalledWith(draftId, {
      versionNo: "1",
      candidate: expect.objectContaining({
        summary: "客户确认预算；销售需在下周提交方案",
        followupType: "meeting",
        facts: [{ factType: "budget_status", factValue: "预算已确认" }],
      }),
    });
    expect(workbenchApi.confirmDraft).toHaveBeenCalledWith(
      draftId,
      { versionNo: "2" },
      expect.stringMatching(/^confirm-/),
    );
    expect(screen.getByText(followupId)).toBeVisible();
    expect(
      screen.getByText("客户确认预算；销售需在下周提交方案"),
    ).toBeVisible();
    expect(screen.getByText("会议")).toBeVisible();
    expect(screen.getByText("budget_status")).toBeVisible();
    expect(screen.getByText("预算已确认")).toBeVisible();
    expect(
      await screen.findByText("30000000-0000-4000-8000-000000000001"),
    ).toBeVisible();
    expect(workbenchApi.getFormalFollowup).toHaveBeenCalledWith(followupId);
    expect(screen.getByText(/建议动作仍需单独确认/)).toBeVisible();
  });

  it("confirms an unchanged draft without creating a redundant revision", async () => {
    const workbenchApi = api();
    render(<FollowupDraftForm api={workbenchApi} />);
    await generateDraft();

    fireEvent.click(screen.getByLabelText("我已核对以上内容"));
    fireEvent.click(screen.getByRole("button", { name: "确认并写入正式跟进" }));

    await screen.findByText("已写入正式跟进");
    expect(workbenchApi.reviseDraft).not.toHaveBeenCalled();
    expect(workbenchApi.confirmDraft).toHaveBeenCalledWith(
      draftId,
      { versionNo: "1" },
      expect.stringMatching(/^confirm-/),
    );
  });

  it("makes a failed formal-record read visible and retryable after the write succeeds", async () => {
    const getFormalFollowup = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValueOnce(formalFollowup);
    const workbenchApi = api({ getFormalFollowup });
    render(<FollowupDraftForm api={workbenchApi} />);
    await generateDraft();

    fireEvent.click(screen.getByLabelText("我已核对以上内容"));
    fireEvent.click(screen.getByRole("button", { name: "确认并写入正式跟进" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "正式记录已写入，但详情读取失败",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新读取正式记录" }));
    expect(await screen.findByText("本次正式入库")).toBeVisible();
    expect(getFormalFollowup).toHaveBeenCalledTimes(2);
  });

  it("reuses the confirmation idempotency key after a recoverable request failure", async () => {
    const confirmDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce(confirmation);
    const workbenchApi = api({ confirmDraft });
    render(<FollowupDraftForm api={workbenchApi} />);
    await generateDraft();

    fireEvent.click(screen.getByLabelText("我已核对以上内容"));
    fireEvent.click(screen.getByRole("button", { name: "确认并写入正式跟进" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "网络暂时不可用",
    );

    fireEvent.click(screen.getByRole("button", { name: "确认并写入正式跟进" }));
    await screen.findByText("已写入正式跟进");
    expect(confirmDraft).toHaveBeenCalledTimes(2);
    expect(confirmDraft.mock.calls[0]?.[2]).toBe(
      confirmDraft.mock.calls[1]?.[2],
    );
  });

  it("recovers from an optimistic conflict by loading the latest draft", async () => {
    const latest = pendingDraft({
      versionNo: "2",
      candidate: {
        ...pendingDraft().candidate,
        summary: "其他会话已经更新的摘要",
      },
    });
    const workbenchApi = api({
      confirmDraft: vi.fn().mockRejectedValue(
        new FollowupApiError(409, {
          code: "DRAFT_VERSION_CONFLICT",
          message: "草稿已被其他操作更新。",
          requestId: "request-001",
          issues: [{ path: "versionNo", reason: "expected 2, received 1" }],
        }),
      ),
      getDraft: vi.fn().mockResolvedValue(latest),
    });
    render(<FollowupDraftForm api={workbenchApi} />);
    await generateDraft();
    fireEvent.click(screen.getByLabelText("我已核对以上内容"));
    fireEvent.click(screen.getByRole("button", { name: "确认并写入正式跟进" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "草稿已被其他操作更新",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新加载草稿" }));
    expect(
      await screen.findByDisplayValue("其他会话已经更新的摘要"),
    ).toBeVisible();
    expect(workbenchApi.getDraft).toHaveBeenCalledWith(draftId);
  });

  it("cancels a pending draft idempotently from the workbench", async () => {
    const workbenchApi = api();
    render(<FollowupDraftForm api={workbenchApi} />);
    await generateDraft();

    fireEvent.click(screen.getByRole("button", { name: "取消草稿" }));

    expect(await screen.findByText("草稿已取消")).toBeVisible();
    expect(workbenchApi.cancelDraft).toHaveBeenCalledWith(
      draftId,
      { versionNo: "1" },
      expect.stringMatching(/^cancel-/),
    );
  });

  it("keeps the entity loader retryable", async () => {
    const listEntities = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(entities);
    render(<FollowupDraftForm api={api({ listEntities })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "经营对象加载失败",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新加载经营对象" }));
    expect(
      await screen.findByRole("option", { name: "Aurora Systems" }),
    ).toBeVisible();
    expect(listEntities).toHaveBeenCalledTimes(2);
  });
});

async function generateDraft(): Promise<void> {
  await screen.findByRole("option", { name: "Aurora Systems" });
  fireEvent.change(screen.getByLabelText("经营对象"), {
    target: { value: entityId },
  });
  fireEvent.change(screen.getByLabelText("本次客户跟进"), {
    target: { value: "客户确认预算，下一步提交方案" },
  });
  fireEvent.click(screen.getByRole("button", { name: "生成跟进草稿" }));
  await screen.findByText("人工确认区");
}
