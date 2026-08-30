import "@testing-library/jest-dom/vitest";

import type { FollowupDraftResponse } from "@battlefield/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FollowupDraftForm } from "./followup-draft-form";

const returnedDraft: FollowupDraftResponse = {
  draftId: "draft-001",
  status: "pending_confirmation",
  rawInput: "客户确认预算，下一步提交方案",
  candidate: {
    summary: "客户已确认预算，下一步提交方案",
    relatedOpportunityIds: [],
  },
  createdAt: "2026-08-31T02:30:00.000Z",
};

afterEach(cleanup);

describe("FollowupDraftForm", () => {
  it("keeps submit disabled until the user enters meaningful text", () => {
    render(<FollowupDraftForm createDraft={vi.fn()} />);

    expect(screen.getByRole("button", { name: "生成跟进草稿" })).toBeDisabled();
  });

  it("submits trimmed input through the injected API client", async () => {
    const createDraft = vi.fn().mockResolvedValue(returnedDraft);
    render(<FollowupDraftForm createDraft={createDraft} />);

    fireEvent.change(screen.getByLabelText("本次客户跟进"), {
      target: { value: "  客户确认预算，下一步提交方案  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成跟进草稿" }));

    await screen.findByText(returnedDraft.candidate.summary);
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft).toHaveBeenCalledWith({
      rawInput: "客户确认预算，下一步提交方案",
    });
  });

  it("shows progress while the draft is being generated", () => {
    const createDraft = vi.fn(
      () => new Promise<FollowupDraftResponse>(() => undefined),
    );
    render(<FollowupDraftForm createDraft={createDraft} />);

    fireEvent.change(screen.getByLabelText("本次客户跟进"), {
      target: { value: "客户确认预算" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成跟进草稿" }));

    expect(screen.getByRole("button", { name: "正在生成…" })).toBeDisabled();
  });

  it("renders the proposed summary as visibly pending confirmation", async () => {
    render(
      <FollowupDraftForm
        createDraft={vi.fn().mockResolvedValue(returnedDraft)}
      />,
    );

    fireEvent.change(screen.getByLabelText("本次客户跟进"), {
      target: { value: "客户确认预算，下一步提交方案" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成跟进草稿" }));

    expect(await screen.findByText("待确认")).toBeVisible();
    expect(screen.getByText(returnedDraft.candidate.summary)).toBeVisible();
  });

  it("shows a retryable error without clearing the user's input", async () => {
    render(
      <FollowupDraftForm
        createDraft={vi.fn().mockRejectedValue(new Error("offline"))}
      />,
    );
    const input = screen.getByLabelText("本次客户跟进");

    fireEvent.change(input, { target: { value: "客户确认预算" } });
    fireEvent.click(screen.getByRole("button", { name: "生成跟进草稿" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "生成失败，请稍后重试",
    );
    expect(input).toHaveValue("客户确认预算");
  });
});
