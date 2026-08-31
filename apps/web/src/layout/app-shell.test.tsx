import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SessionProvider } from "../auth/session-provider";
import { AppShell } from "./app-shell";

const department = {
  id: "31000000-0000-4000-8000-000000000001",
  name: "商业化一部",
};
const salesSession = {
  user: {
    id: "30000000-0000-4000-8000-000000000001",
    displayName: "销售1",
    email: "sales1@demo.local",
  },
  role: "sales" as const,
  department,
  directLeader: {
    id: "30000000-0000-4000-8000-000000000072",
    displayName: "领导A",
  },
  teamMembers: [],
  expiresAt: "2026-09-01T08:00:00.000Z",
};
const leaderSession = {
  user: {
    id: "30000000-0000-4000-8000-000000000072",
    displayName: "领导A",
    email: "leader.a@demo.local",
  },
  role: "department_leader" as const,
  department,
  directLeader: null,
  teamMembers: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      displayName: "销售1",
    },
  ],
  expiresAt: "2026-09-01T08:00:00.000Z",
};

afterEach(cleanup);

describe("AppShell", () => {
  it("identifies the running application as PostgreSQL-backed rather than synthetic", () => {
    render(
      <SessionProvider initialSession={salesSession}>
        <AppShell activeItem="经营总览" breadcrumb="销售工作台 / 经营总览">
          <p>工作台内容</p>
        </AppShell>
      </SessionProvider>,
    );

    expect(screen.getByText("开发环境 · PostgreSQL")).toBeVisible();
    expect(screen.getByRole("button", { name: /打开消息抽屉/ })).toBeVisible();
    expect(screen.queryByText("演示环境 · 合成数据")).not.toBeInTheDocument();
  });

  it("exposes real desktop and mobile routes for the implemented workspaces", () => {
    render(
      <SessionProvider initialSession={leaderSession}>
        <AppShell activeItem="经营动作" breadcrumb="销售工作台 / 经营动作">
          <p>页面内容</p>
        </AppShell>
      </SessionProvider>,
    );

    const desktop = screen.getByRole("navigation", { name: "主导航" });
    expect(
      within(desktop).getByRole("link", { name: "经营总览" }),
    ).toHaveAttribute("href", "/workspace");
    expect(screen.getByText("管理工作台 / 经营动作")).toBeVisible();
    expect(
      within(desktop).getByRole("link", { name: "客户作战地图" }),
    ).toHaveAttribute("href", "/battle-map");
    expect(
      within(desktop).getByRole("link", { name: "经营动作" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(desktop).getByRole("link", { name: "通知中心" }),
    ).toHaveAttribute("href", "/inbox");
    expect(
      within(desktop).getByRole("link", { name: "管理问数" }),
    ).toHaveAttribute("href", "/ask");
    expect(
      within(desktop).getByRole("link", { name: "周报中心" }),
    ).toHaveAttribute("href", "/reports");

    const mobile = screen.getByRole("navigation", { name: "移动端主导航" });
    expect(within(mobile).getByRole("link", { name: "今日" })).toHaveAttribute(
      "href",
      "/workspace",
    );
    expect(within(mobile).getByRole("link", { name: "跟进" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(within(mobile).getByRole("link", { name: "地图" })).toHaveAttribute(
      "href",
      "/battle-map",
    );
    expect(within(mobile).getByRole("link", { name: "动作" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(mobile).getByRole("link", { name: "通知" })).toHaveAttribute(
      "href",
      "/inbox",
    );
    expect(within(mobile).getByRole("link", { name: "问数" })).toHaveAttribute(
      "href",
      "/ask",
    );
    expect(within(mobile).getByRole("link", { name: "周报" })).toHaveAttribute(
      "href",
      "/reports",
    );
  });

  it("marks the workspace as the system home on desktop and mobile", () => {
    render(
      <SessionProvider initialSession={salesSession}>
        <AppShell activeItem="经营总览" breadcrumb="销售工作台 / 经营总览">
          <p>工作台内容</p>
        </AppShell>
      </SessionProvider>,
    );

    expect(
      screen.getByRole("link", { name: "AI 客户作战系统首页" }),
    ).toHaveAttribute("href", "/workspace");
    const desktop = screen.getByRole("navigation", { name: "主导航" });
    expect(
      within(desktop).getByRole("link", { name: "经营总览" }),
    ).toHaveAttribute("aria-current", "page");
    const mobile = screen.getByRole("navigation", { name: "移动端主导航" });
    expect(within(mobile).getByRole("link", { name: "今日" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(screen.getByRole("navigation", { name: "主导航" })).queryByRole(
        "link",
        { name: "管理问数" },
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("打开账号菜单"));
    expect(screen.getAllByText("销售身份").length).toBeGreaterThan(0);
    expect(screen.getByText("商业化一部")).toBeVisible();
    expect(screen.getByText("直属领导")).toBeVisible();
    expect(screen.getByText("领导A")).toBeVisible();
  });

  it("shows Leader A its direct department sales roster", () => {
    render(
      <SessionProvider initialSession={leaderSession}>
        <AppShell activeItem="管理问数" breadcrumb="管理工作台 / 管理问数">
          <p>管理页面</p>
        </AppShell>
      </SessionProvider>,
    );

    fireEvent.click(screen.getByLabelText("打开账号菜单"));
    expect(screen.getAllByText("直属领导").length).toBeGreaterThan(0);
    expect(screen.getByText("团队成员")).toBeVisible();
    expect(screen.getByText("销售1")).toBeVisible();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();
  });

  it("blocks a sales user that opens the leader-only route directly", () => {
    render(
      <SessionProvider initialSession={salesSession}>
        <AppShell activeItem="管理问数" breadcrumb="管理工作台 / 管理问数">
          <p>不应渲染的管理内容</p>
        </AppShell>
      </SessionProvider>,
    );

    expect(screen.getByText("当前身份不能使用管理问数。")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "返回我的工作台" }),
    ).toHaveAttribute("href", "/workspace");
    expect(screen.queryByText("不应渲染的管理内容")).not.toBeInTheDocument();
  });
});
