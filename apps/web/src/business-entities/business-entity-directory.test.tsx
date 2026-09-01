import "@testing-library/jest-dom/vitest";

import type {
  BusinessEntityListItem,
  BusinessEntityPage,
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

import { BusinessEntityDirectory } from "./business-entity-directory";

const aurora = createItem({
  id: "10000000-0000-4000-8000-000000000001",
  name: "Aurora Systems",
  owner: "销售甲",
  opportunity: "年度平台项目",
});
const beacon = createItem({
  id: "10000000-0000-4000-8000-000000000002",
  name: "Beacon Labs",
  owner: null,
  opportunity: null,
});
const cedar = createItem({
  id: "10000000-0000-4000-8000-000000000003",
  name: "Cedar Works",
  owner: "销售乙",
  opportunity: "续约项目",
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BusinessEntityDirectory", () => {
  it("announces initial loading while the request is pending", () => {
    const request = vi.fn(
      () => new Promise<BusinessEntityPage>(() => undefined),
    );

    render(<BusinessEntityDirectory request={request} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载经营对象");
  });

  it("shows owner, primary opportunity, stage and explicit data gaps", async () => {
    render(
      <BusinessEntityDirectory
        request={vi.fn().mockResolvedValue({
          items: [aurora, beacon],
          nextCursor: null,
        })}
      />,
    );

    const auroraRow = await findEntityRow(aurora.id);
    expect(within(auroraRow).getByText("销售甲")).toBeVisible();
    expect(within(auroraRow).getByText("年度平台项目")).toBeVisible();
    expect(within(auroraRow).getByText("方案与报价 · 30.00%")).toBeVisible();
    expect(within(auroraRow).getByText("T0")).toBeVisible();
    expect(
      within(auroraRow).getByRole("link", {
        name: "客户确认预算，并要求下周提交 POC 排期。",
      }),
    ).toHaveAttribute(
      "href",
      "/followups/80000000-0000-4000-8000-000000000001",
    );

    const beaconRow = await findEntityRow(beacon.id);
    expect(within(beaconRow).getByText("待补充负责人")).toBeVisible();
    expect(within(beaconRow).getByText("暂无主商机")).toBeVisible();
    expect(within(beaconRow).getByText("待补充阶段")).toBeVisible();
    expect(within(beaconRow).getByText("暂无正式跟进")).toBeVisible();
  });

  it("renders an actionable empty state", async () => {
    render(
      <BusinessEntityDirectory
        request={vi.fn().mockResolvedValue({ items: [], nextCursor: null })}
      />,
    );

    expect(await screen.findByText("暂时没有符合条件的经营对象")).toBeVisible();
    expect(screen.getByText("可以调整搜索词或经营状态后重试")).toBeVisible();
  });

  it("keeps a failed request retryable", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [aurora], nextCursor: null });
    render(<BusinessEntityDirectory request={request} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "经营对象加载失败",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    expect(await screen.findByText("Aurora Systems")).toBeVisible();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("submits trimmed search after a debounce", async () => {
    const request = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    render(<BusinessEntityDirectory request={request} />);
    await screen.findByText("暂时没有符合条件的经营对象");

    fireEvent.change(screen.getByLabelText("搜索经营对象"), {
      target: { value: "  Aurora  " },
    });
    expect(request).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith({
        search: "Aurora",
        limit: 20,
      }),
    );
  });

  it("applies the selected status filter", async () => {
    const request = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    render(<BusinessEntityDirectory request={request} />);
    await screen.findByText("暂时没有符合条件的经营对象");

    fireEvent.change(screen.getByLabelText("经营状态"), {
      target: { value: "archived" },
    });

    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith({
        status: "archived",
        limit: 20,
      }),
    );
  });

  it("appends a cursor page without rendering duplicate entities", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        items: [aurora, beacon],
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        items: [beacon, cedar],
        nextCursor: null,
      });
    render(<BusinessEntityDirectory request={request} />);
    await screen.findByText("Aurora Systems");

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByText("Cedar Works");

    expect(screen.getAllByTestId("business-entity-row")).toHaveLength(3);
    expect(request).toHaveBeenLastCalledWith({
      cursor: "next-page",
      limit: 20,
    });
  });

  it("uses one semantic table that carries mobile card labels", async () => {
    render(
      <BusinessEntityDirectory
        request={vi.fn().mockResolvedValue({
          items: [aurora],
          nextCursor: null,
        })}
      />,
    );

    const table = await screen.findByRole("table", { name: "经营对象目录" });
    const row = await findEntityRow(aurora.id);
    expect(table).toHaveClass("business-entity-table");
    expect(within(row).getByText("销售甲").closest("td")).toHaveAttribute(
      "data-label",
      "负责人",
    );
  });
});

async function findEntityRow(id: string): Promise<HTMLElement> {
  const rows = await screen.findAllByTestId("business-entity-row");
  const row = rows.find((candidate) => candidate.dataset.entityId === id);
  if (!row) {
    throw new Error(`Entity row ${id} was not rendered.`);
  }
  return row;
}

function createItem(input: {
  id: string;
  name: string;
  owner: string | null;
  opportunity: string | null;
}): BusinessEntityListItem {
  return {
    id: input.id,
    typeCode: "customer",
    name: input.name,
    shortName: null,
    status: "active",
    isT0: input.id.endsWith("0001"),
    primaryOwnerName: input.owner,
    primaryOpportunity: input.opportunity
      ? {
          id: input.id.replace(/^1/, "2"),
          name: input.opportunity,
          stageCode: "proposal",
          stageLabel: "方案与报价",
          stageProgress: "30.00",
        }
      : null,
    latestFollowup: input.id.endsWith("0001")
      ? {
          followupId: "80000000-0000-4000-8000-000000000001",
          summary: "客户确认预算，并要求下周提交 POC 排期。",
          confirmedAt: "2026-08-31T04:00:00.000Z",
        }
      : null,
    updatedAt: "2026-08-31T03:30:00.000Z",
    versionNo: "1",
  };
}
