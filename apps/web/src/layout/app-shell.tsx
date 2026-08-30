import Link from "next/link";
import type { ReactNode } from "react";

const navigation = [
  { label: "经营总览", href: "#" },
  { label: "经营对象", href: "/entities" },
  { label: "客户作战地图", href: "#" },
  { label: "跟进工作台", href: "/" },
  { label: "经营动作", href: "#" },
  { label: "周报中心", href: "#" },
] as const;

type NavigationLabel = (typeof navigation)[number]["label"];

export function AppShell({
  activeItem,
  breadcrumb,
  children,
}: {
  activeItem: NavigationLabel;
  breadcrumb: string;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="AI 客户作战系统首页">
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
            <span aria-hidden="true">演</span>
            演示销售
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
