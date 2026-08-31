import Link from "next/link";
import type { ReactNode } from "react";

import { developmentActorConfiguration } from "../config/development-actor";

const navigation = [
  { label: "经营总览", href: "/workspace" },
  { label: "经营对象", href: "/entities" },
  { label: "客户作战地图", href: "/battle-map" },
  { label: "跟进工作台", href: "/" },
  { label: "经营动作", href: "/actions" },
  { label: "通知中心", href: "/inbox" },
  { label: "周报中心", href: "#" },
] as const;

type NavigationLabel = (typeof navigation)[number]["label"];

const mobileNavigation: ReadonlyArray<{
  label: string;
  href: string;
  activeItem: NavigationLabel;
  mark: string;
}> = [
  { label: "今日", href: "/workspace", activeItem: "经营总览", mark: "今" },
  { label: "跟进", href: "/", activeItem: "跟进工作台", mark: "跟" },
  {
    label: "地图",
    href: "/battle-map",
    activeItem: "客户作战地图",
    mark: "图",
  },
  { label: "动作", href: "/actions", activeItem: "经营动作", mark: "动" },
  { label: "通知", href: "/inbox", activeItem: "通知中心", mark: "信" },
];

export function AppShell({
  activeItem,
  breadcrumb,
  children,
}: {
  activeItem: NavigationLabel;
  breadcrumb: string;
  children: ReactNode;
}) {
  const actor = developmentActorConfiguration();
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
          {navigation.map((item) => {
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
          演示环境 · 合成数据
        </div>
      </aside>

      <main>
        <header className="topbar">
          <span className="breadcrumb">{breadcrumb}</span>
          <div className="user-chip">
            <span aria-hidden="true">{actor.displayName.slice(0, 1)}</span>
            {actor.displayName}
          </div>
        </header>
        {children}
      </main>

      <nav className="mobile-navigation" aria-label="移动端主导航">
        {mobileNavigation.map((item) => {
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
