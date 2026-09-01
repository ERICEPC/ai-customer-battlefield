import "@testing-library/jest-dom/vitest";

import type { SessionProfile } from "@battlefield/contracts";
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
const salesSession: SessionProfile = {
  user: {
    id: "30000000-0000-4000-8000-000000000001",
    displayName: "销售1",
    email: "sales1@demo.local",
  },
  role: "sales" as const,
  capabilities: [],
  department,
  directLeader: {
    id: "30000000-0000-4000-8000-000000000072",
    displayName: "领导A",
  },
  teamMembers: [],
  expiresAt: "2026-09-01T08:00:00.000Z",
};
const leaderSession: SessionProfile = {
  user: {
    id: "30000000-0000-4000-8000-000000000072",
    displayName: "领导A",
    email: "leader.a@demo.local",
  },
  role: "department_leader" as const,
  capabilities: [
    "access_control.manage",
    "ai_runtime_config.manage",
    "audit.read",
    "business_rules.manage",
    "management_query.execute",
    "worker_operations.manage",
  ],
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
    expect(
      within(desktop).getByRole("link", { name: "系统管理" }),
    ).toHaveAttribute("href", "/admin");

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
    expect(
      within(screen.getByRole("navigation", { name: "主导航" })).queryByRole(
        "link",
        { name: "系统管理" },
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
    expect(screen.getAllByRole("link", { name: "系统管理" })).toHaveLength(2);
    expect(
      screen.getAllByRole("link", { name: "系统管理" })[0],
    ).toHaveAttribute("href", "/admin");
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

  it("blocks a sales user that opens system management directly", () => {
    render(
      <SessionProvider initialSession={salesSession}>
        <AppShell activeItem="系统管理" breadcrumb="管理工作台 / 系统管理">
          <p>不应渲染的系统管理内容</p>
        </AppShell>
      </SessionProvider>,
    );

    expect(screen.getByText("当前身份不能使用系统管理。")).toBeVisible();
    expect(
      screen.queryByText("不应渲染的系统管理内容"),
    ).not.toBeInTheDocument();
  });

  it("uses capabilities instead of the leader role label for management access", () => {
    const leaderWithoutSystemCapabilities: SessionProfile = {
      ...leaderSession,
      capabilities: ["management_query.execute"],
    };
    const { rerender } = render(
      <SessionProvider initialSession={leaderWithoutSystemCapabilities}>
        <AppShell activeItem="管理问数" breadcrumb="管理工作台 / 管理问数">
          <p>问数内容</p>
        </AppShell>
      </SessionProvider>,
    );

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(
      within(navigation).getByRole("link", { name: "管理问数" }),
    ).toBeVisible();
    expect(
      within(navigation).queryByRole("link", { name: "系统管理" }),
    ).not.toBeInTheDocument();

    rerender(
      <SessionProvider initialSession={leaderWithoutSystemCapabilities}>
        <AppShell activeItem="系统管理" breadcrumb="管理工作台 / 系统管理">
          <p>不应渲染的系统管理内容</p>
        </AppShell>
      </SessionProvider>,
    );
    expect(screen.getByText("当前账号未获得系统管理能力。")).toBeVisible();
    expect(
      screen.queryByText("不应渲染的系统管理内容"),
    ).not.toBeInTheDocument();
  });

  it("allows a sales-labelled account when the tenant grants one system capability", () => {
    const delegatedSales: SessionProfile = {
      ...salesSession,
      capabilities: ["worker_operations.manage"],
    };
    render(
      <SessionProvider initialSession={delegatedSales}>
        <AppShell activeItem="系统管理" breadcrumb="管理工作台 / 系统管理">
          <p>已授权系统管理内容</p>
        </AppShell>
      </SessionProvider>,
    );

    expect(screen.getByText("已授权系统管理内容")).toBeVisible();
    expect(
      within(screen.getByRole("navigation", { name: "主导航" })).getByRole(
        "link",
        { name: "系统管理" },
      ),
    ).toBeVisible();
  });
});
