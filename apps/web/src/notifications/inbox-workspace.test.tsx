import "@testing-library/jest-dom/vitest";

import type { InboxItem, InboxPage } from "@battlefield/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { InboxWorkspace, type InboxWorkspaceApi } from "./inbox-workspace";

const firstNotification: InboxItem = {
  notificationId: "f0000000-0000-4000-8000-000000000071",
  eventType: "action_due",
  title: "经营动作已到计划时间",
  body: "推进正式方案 已到计划时间，请及时推进。",
  deepLink: "/actions?actionId=d0000000-0000-4000-8000-000000000071",
  priority: "high",
  createdAt: "2026-08-31T00:08:00.000Z",
  readAt: null,
};
const secondNotification: InboxItem = {
  ...firstNotification,
  notificationId: "f0000000-0000-4000-8000-000000000072",
  title: "第二条动作提醒",
  createdAt: "2026-08-31T00:07:00.000Z",
};

function api(overrides: Partial<InboxWorkspaceApi> = {}): InboxWorkspaceApi {
  return {
    list: vi.fn().mockResolvedValue({
      items: [firstNotification],
      nextCursor: null,
    }),
    markRead: vi.fn().mockResolvedValue({
      notificationId: firstNotification.notificationId,
      readAt: "2026-08-31T00:10:00.000Z",
    }),
    ...overrides,
  };
}

afterEach(cleanup);

describe("InboxWorkspace", () => {
  test("renders loading then a plain-text notification with priority, time and safe action link", async () => {
    render(<InboxWorkspace api={api()} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载通知");
    expect(await screen.findByText(firstNotification.title)).toBeVisible();
    const card = screen.getByRole("article", {
      name: firstNotification.title,
    });
    expect(within(card).getByText("高优先级")).toBeVisible();
    expect(within(card).getByText(/2026/)).toBeVisible();
    expect(
      within(card).getByRole("link", { name: "查看详情" }),
    ).toHaveAttribute("href", firstNotification.deepLink);
    expect(within(card).getByText("未读")).toBeVisible();
  });

  test("shows empty state and can retry a failed initial load", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("通知读取失败"))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    render(<InboxWorkspace api={api({ list })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("通知读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    expect(await screen.findByText("暂时没有通知")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("switches to unread-only results and ignores stale pagination responses", async () => {
    let resolveOlder: ((value: InboxPage) => void) | undefined;
    const olderPage = new Promise<InboxPage>((resolve) => {
      resolveOlder = resolve;
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [firstNotification],
        nextCursor: "older-page",
      })
      .mockReturnValueOnce(olderPage)
      .mockResolvedValueOnce({ items: [secondNotification], nextCursor: null });
    render(<InboxWorkspace api={api({ list })} />);
    await screen.findByText(firstNotification.title);

    fireEvent.click(screen.getByRole("button", { name: "加载更多通知" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "只看未读" }));
    expect(await screen.findByText(secondNotification.title)).toBeVisible();
    resolveOlder?.({ items: [firstNotification], nextCursor: null });

    await waitFor(() =>
      expect(
        screen.queryByText(firstNotification.title),
      ).not.toBeInTheDocument(),
    );
    expect(list).toHaveBeenLastCalledWith({ unreadOnly: true, limit: 50 });
  });

  test("merges cursor pages without duplicate notification rows", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [firstNotification],
        nextCursor: "older-page",
      })
      .mockResolvedValueOnce({
        items: [firstNotification, secondNotification],
        nextCursor: null,
      });
    render(<InboxWorkspace api={api({ list })} />);
    await screen.findByText(firstNotification.title);
    fireEvent.click(screen.getByRole("button", { name: "加载更多通知" }));

    expect(await screen.findByText(secondNotification.title)).toBeVisible();
    expect(
      screen.getAllByRole("article", { name: firstNotification.title }),
    ).toHaveLength(1);
  });

  test("marks read only after the receipt and exposes a retry after failure", async () => {
    const markRead = vi
      .fn()
      .mockRejectedValueOnce(new Error("标记失败"))
      .mockResolvedValueOnce({
        notificationId: firstNotification.notificationId,
        readAt: "2026-08-31T00:10:00.000Z",
      });
    render(<InboxWorkspace api={api({ markRead })} />);
    await screen.findByText(firstNotification.title);

    fireEvent.click(screen.getByRole("button", { name: "标为已读" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("标记失败");
    expect(screen.getByText("未读")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试标记已读" }));

    await waitFor(() =>
      expect(screen.queryByText("未读")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("已读")).toBeVisible();
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  test("removes a read notification immediately from the unread-only view", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [firstNotification],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [firstNotification],
        nextCursor: null,
      });
    render(<InboxWorkspace api={api({ list })} />);
    await screen.findByText(firstNotification.title);

    fireEvent.click(screen.getByRole("checkbox", { name: "只看未读" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ unreadOnly: true, limit: 50 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "标为已读" }));

    expect(await screen.findByText("暂时没有通知")).toBeVisible();
    expect(screen.queryByText(firstNotification.title)).not.toBeInTheDocument();
  });

  test("never exposes a non-application deep link", async () => {
    render(
      <InboxWorkspace
        api={api({
          list: vi.fn().mockResolvedValue({
            items: [
              {
                ...firstNotification,
                deepLink: "https://untrusted.invalid/action",
              },
            ],
            nextCursor: null,
          }),
        })}
      />,
    );

    await screen.findByText(firstNotification.title);
    expect(
      screen.queryByRole("link", { name: "查看详情" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("关联记录链接不可用")).toBeVisible();
  });
});
