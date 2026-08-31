import "@testing-library/jest-dom/vitest";

import type { InboxItem } from "@battlefield/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { NotificationBell } from "./notification-bell";

const item: InboxItem = {
  notificationId: "f0000000-0000-4000-8000-000000000071",
  eventType: "sales_progress_updated",
  title: "销售1更新了 云岭新能源汽车股份有限公司",
  body: "客户确认 380 万元预算，下周三前需要 POC 排期。",
  deepLink: "/followups/80000000-0000-4000-8000-000000000001",
  priority: "medium",
  createdAt: "2026-09-01T02:01:00.000Z",
  readAt: null,
};

afterEach(cleanup);

describe("NotificationBell", () => {
  test("opens a right drawer with traceable messages and updates unread state", async () => {
    const markRead = vi.fn().mockResolvedValue({
      notificationId: item.notificationId,
      readAt: "2026-09-01T02:05:00.000Z",
    });
    render(
      <NotificationBell
        api={{
          list: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }),
          markRead,
        }}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "打开消息抽屉，1 条未读",
    });
    fireEvent.click(trigger);

    const drawer = screen.getByRole("dialog", { name: "消息中心" });
    expect(within(drawer).getByText(item.title)).toBeVisible();
    expect(within(drawer).getByText(item.body)).toBeVisible();
    expect(
      within(drawer).getByRole("link", { name: "查看对应记录" }),
    ).toHaveAttribute("href", item.deepLink);

    fireEvent.click(within(drawer).getByRole("button", { name: "标为已读" }));
    expect(await within(drawer).findByText("已读")).toBeVisible();
    expect(markRead).toHaveBeenCalledWith(item.notificationId);
  });
});
