import "@testing-library/jest-dom/vitest";

import type { FormalFollowupRecord } from "@battlefield/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FollowupDetailWorkspace } from "./followup-detail-workspace";

const followup: FormalFollowupRecord = {
  followupId: "80000000-0000-4000-8000-000000000001",
  sourceDraftId: "70000000-0000-4000-8000-000000000001",
  entityId: "50000000-0000-4000-8000-000000000001",
  occurredAt: "2026-09-01T02:00:00.000Z",
  followupType: "meeting",
  summary: "客户确认 380 万元预算，下周三前需要 POC 排期。",
  submittedBy: "30000000-0000-4000-8000-000000000001",
  confirmedBy: "30000000-0000-4000-8000-000000000001",
  confirmedAt: "2026-09-01T02:01:00.000Z",
  relatedOpportunityIds: ["60000000-0000-4000-8000-000000000001"],
  primaryOpportunityId: "60000000-0000-4000-8000-000000000001",
  facts: [
    {
      factType: "budget_status",
      factValue: "项目预算已确认：380 万元",
      opportunityId: "60000000-0000-4000-8000-000000000001",
    },
    {
      factType: "next_step",
      factValue: "下周三前提交 POC 排期",
      opportunityId: null,
    },
  ],
};

afterEach(cleanup);

describe("FollowupDetailWorkspace", () => {
  test("shows the confirmed record, facts, and traceable business links", async () => {
    render(
      <FollowupDetailWorkspace
        followupId={followup.followupId}
        request={vi.fn().mockResolvedValue(followup)}
      />,
    );

    expect(await screen.findByText(followup.summary)).toBeVisible();
    const facts = screen.getByRole("list", { name: "本次确认的经营事实" });
    expect(within(facts).getByText("项目预算已确认：380 万元")).toBeVisible();
    expect(within(facts).getByText("下周三前提交 POC 排期")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "查看对应作战地图" }),
    ).toHaveAttribute("href", `/battle-map?entityId=${followup.entityId}`);
    expect(
      screen.getByRole("link", { name: "返回经营对象表格" }),
    ).toHaveAttribute("href", "/entities");
  });
});
