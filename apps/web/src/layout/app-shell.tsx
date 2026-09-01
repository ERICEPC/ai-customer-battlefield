"use client";

import type { ManagementCapability } from "@battlefield/contracts";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";

import { useSession } from "../auth/session-provider";
import { NotificationBell } from "../notifications/notification-bell";

const navigation = [
  {
    label: "经营总览",
    href: "/workspace",
    roles: ["sales", "department_leader"],
  },
  {
    label: "经营对象",
    href: "/entities",
    roles: ["sales", "department_leader"],
  },
  {
    label: "客户作战地图",
    href: "/battle-map",
    roles: ["sales", "department_leader"],
  },
  { label: "跟进工作台", href: "/", roles: ["sales", "department_leader"] },
  {
    label: "经营动作",
    href: "/actions",
    roles: ["sales", "department_leader"],
  },
  { label: "通知中心", href: "/inbox", roles: ["sales", "department_leader"] },
  {
    label: "管理问数",
    href: "/ask",
    roles: ["sales", "department_leader"],
  },
  {
    label: "周报中心",
    href: "/reports",
    roles: ["sales", "department_leader"],
  },
  {
    label: "系统管理",
    href: "/admin",
    roles: ["sales", "department_leader"],
  },
] as const;

type NavigationLabel = (typeof navigation)[number]["label"];
type ActiveItem = NavigationLabel | "个人设置";
type NavigationRole = (typeof navigation)[number]["roles"][number];

const requiredCapabilitiesByItem: Partial<
  Record<ActiveItem, readonly ManagementCapability[]>
> = {
  管理问数: ["management_query.execute"],
};

const systemManagementCapabilities: readonly ManagementCapability[] = [
  "access_control.manage",
  "ai_runtime_config.manage",
  "audit.read",
  "business_rules.manage",
  "worker_operations.manage",
];

const mobileNavigation: ReadonlyArray<{
  label: string;
  href: string;
  activeItem: ActiveItem;
  mark: string;
  roles: readonly NavigationRole[];
}> = [
  {
    label: "今日",
    href: "/workspace",
    activeItem: "经营总览",
    mark: "今",
    roles: ["sales", "department_leader"],
  },
  {
    label: "跟进",
    href: "/",
    activeItem: "跟进工作台",
    mark: "跟",
    roles: ["sales", "department_leader"],
  },
  {
    label: "地图",
    href: "/battle-map",
    activeItem: "客户作战地图",
    mark: "图",
    roles: ["sales", "department_leader"],
  },
  {
    label: "动作",
    href: "/actions",
    activeItem: "经营动作",
    mark: "动",
    roles: ["sales", "department_leader"],
  },
  {
    label: "通知",
    href: "/inbox",
    activeItem: "通知中心",
    mark: "信",
    roles: ["sales", "department_leader"],
  },
  {
    label: "问数",
    href: "/ask",
    activeItem: "管理问数",
    mark: "问",
    roles: ["sales", "department_leader"],
  },
  {
    label: "周报",
    href: "/reports",
    activeItem: "周报中心",
    mark: "报",
    roles: ["sales", "department_leader"],
  },
];

export function AppShell({
  activeItem,
  breadcrumb,
  children,
  onLoggedOut,
}: {
  activeItem: ActiveItem;
  breadcrumb: string;
  children: ReactNode;
  onLoggedOut?: () => void;
}) {
  const { session, signOut, status } = useSession();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "anonymous") window.location.assign("/login");
  }, [status]);

  if (status === "loading") {
    return <main className="session-state">正在确认登录状态…</main>;
  }
  if (!session) {
    return (
      <main className="session-state">
        <p>登录状态已失效。</p>
        <Link href="/login">返回登录</Link>
      </main>
    );
  }
  if (!supportsItem(session.capabilities, activeItem)) {
    return (
      <main className="session-state">
        <p>
          {session.role === "sales"
            ? `当前身份不能使用${activeItem}。`
            : `当前账号未获得${activeItem}能力。`}
        </p>
        <Link href="/workspace">返回我的工作台</Link>
      </main>
    );
  }

  const visibleNavigation = navigation.filter(
    (item) =>
      supportsRole(item.roles, session.role) &&
      supportsItem(session.capabilities, item.label),
  );
  const visibleMobileNavigation = mobileNavigation.filter(
    (item) =>
      supportsRole(item.roles, session.role) &&
      supportsItem(session.capabilities, item.activeItem),
  );
  const roleLabel = session.role === "sales" ? "销售身份" : "直属领导";
  const visibleBreadcrumb =
    session.role === "department_leader"
      ? breadcrumb.replace(/^销售工作台/, "管理工作台")
      : breadcrumb;

  async function handleLogout() {
    setLogoutError(null);
    try {
      await signOut();
      if (onLoggedOut) onLoggedOut();
      else window.location.assign("/login");
    } catch {
      setLogoutError("退出失败，请检查网络后重试。");
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link
          className="brand"
          href="/workspace"
          aria-label="AI 客户作战系统首页"
        >
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span className="brand-copy">
            <strong>AI 作战台</strong>
            <span>Customer Battlefield</span>
          </span>
        </Link>

        <nav aria-label="主导航">
          {visibleNavigation.map((item) => {
            const isActive = item.label === activeItem;
            return (
              <Link
                href={item.href}
                className={isActive ? "active" : undefined}
                aria-current={isActive ? "page" : undefined}
                key={item.label}
              >
                <span className="nav-dot" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <span className="environment-dot" />
          开发环境 · PostgreSQL
        </div>
      </aside>

      <main>
        <header className="topbar">
          <span className="breadcrumb">{visibleBreadcrumb}</span>
          <div className="topbar-actions">
            <NotificationBell />
            <details className="account-menu">
              <summary className="user-chip" aria-label="打开账号菜单">
                <span aria-hidden="true">
                  {session.user.displayName.slice(0, 1)}
                </span>
                <span>
                  <strong>{session.user.displayName}</strong>
                  <small>{roleLabel}</small>
                </span>
              </summary>
              <div className="account-popover">
                <p className="account-role">{roleLabel}</p>
                <strong>{session.user.displayName}</strong>
                <span>{session.user.email}</span>
                <dl>
                  <div>
                    <dt>所属部门</dt>
                    <dd>{session.department.name}</dd>
                  </div>
                  {session.role === "sales" ? (
                    <div>
                      <dt>直属领导</dt>
                      <dd>{session.directLeader?.displayName ?? "暂未配置"}</dd>
                    </div>
                  ) : (
                    <div>
                      <dt>团队成员</dt>
                      <dd>
                        {session.teamMembers.length > 0
                          ? session.teamMembers
                              .map((member) => member.displayName)
                              .join("、")
                          : "暂无销售"}
                      </dd>
                    </div>
                  )}
                </dl>
                <Link className="account-settings-link" href="/settings">
                  个人设置
                </Link>
                {supportsItem(session.capabilities, "系统管理") ? (
                  <Link className="account-settings-link" href="/admin">
                    系统管理
                  </Link>
                ) : null}
                {logoutError ? <p role="alert">{logoutError}</p> : null}
                <button type="button" onClick={() => void handleLogout()}>
                  退出登录
                </button>
              </div>
            </details>
          </div>
        </header>
        {children}
      </main>

      <nav className="mobile-navigation" aria-label="移动端主导航">
        {visibleMobileNavigation.map((item) => {
          const isActive = item.activeItem === activeItem;
          return (
            <Link
              href={item.href}
              className={isActive ? "active" : undefined}
              aria-current={isActive ? "page" : undefined}
              key={item.label}
            >
              <span aria-hidden="true">{item.mark}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function supportsRole(
  roles: readonly NavigationRole[],
  role: NavigationRole,
): boolean {
  return roles.some((candidate) => candidate === role);
}

function supportsCapabilities(
  granted: readonly ManagementCapability[],
  required: readonly ManagementCapability[] | undefined,
): boolean {
  return (
    !required || required.every((capability) => granted.includes(capability))
  );
}

function supportsItem(
  granted: readonly ManagementCapability[],
  item: ActiveItem,
): boolean {
  if (item === "系统管理") {
    return systemManagementCapabilities.some((capability) =>
      granted.includes(capability),
    );
  }
  return supportsCapabilities(granted, requiredCapabilitiesByItem[item]);
}
