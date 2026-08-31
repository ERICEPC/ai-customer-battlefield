"use client";

import type {
  InboxItem,
  InboxPage,
  InboxQuery,
  MarkNotificationReadResponse,
} from "@battlefield/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { listInbox, markNotificationRead } from "./api-client";

export interface NotificationBellApi {
  list(input: InboxQuery): Promise<InboxPage>;
  markRead(notificationId: string): Promise<MarkNotificationReadResponse>;
}

const defaultApi: NotificationBellApi = {
  list: listInbox,
  markRead: markNotificationRead,
};

export function NotificationBell({
  api = defaultApi,
}: {
  api?: NotificationBellApi;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const unreadCount = items.filter((item) => item.readAt === null).length;

  const refresh = useCallback(async () => {
    setError(false);
    try {
      const page = await api.list({ limit: 20 });
      setItems(page.items);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function markRead(item: InboxItem): Promise<void> {
    if (item.readAt || markingId) return;
    setMarkingId(item.notificationId);
    try {
      const receipt = await api.markRead(item.notificationId);
      setItems((current) =>
        current.map((candidate) =>
          candidate.notificationId === receipt.notificationId
            ? { ...candidate, readAt: receipt.readAt }
            : candidate,
        ),
      );
    } catch {
      setError(true);
    } finally {
      setMarkingId(null);
    }
  }

  function toggleDrawer(): void {
    const next = !open;
    setOpen(next);
    if (next) void refresh();
  }

  return (
    <div className="notification-bell">
      <button
        type="button"
        className="notification-bell-trigger"
        aria-label={`打开消息抽屉，${unreadCount} 条未读`}
        aria-expanded={open}
        onClick={toggleDrawer}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {unreadCount > 0 ? (
          <span className="notification-count">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            type="button"
            className="notification-drawer-backdrop"
            aria-label="关闭消息抽屉"
            onClick={() => setOpen(false)}
          />
          <aside
            className="notification-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="消息中心"
          >
            <header>
              <div>
                <p className="eyebrow">INBOX</p>
                <h2>消息中心</h2>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="notification-drawer-summary">
              <span>{unreadCount} 条未读</span>
              <Link href="/inbox" onClick={() => setOpen(false)}>
                进入完整通知中心
              </Link>
            </div>

            {loading ? (
              <p className="notification-drawer-state">正在加载消息…</p>
            ) : null}
            {error ? (
              <div className="notification-drawer-state" role="alert">
                <span>消息读取失败</span>
                <button type="button" onClick={() => void refresh()}>
                  重新加载
                </button>
              </div>
            ) : null}
            {!loading && !error && items.length === 0 ? (
              <p className="notification-drawer-state">暂时没有消息</p>
            ) : null}
            {!error && items.length > 0 ? (
              <div className="notification-drawer-list">
                {items.map((item) => (
                  <article
                    className={item.readAt ? "is-read" : "is-unread"}
                    key={item.notificationId}
                  >
                    <div className="notification-drawer-item-heading">
                      <span>{item.readAt ? "已读" : "未读"}</span>
                      <time dateTime={item.createdAt}>
                        {formatTime(item.createdAt)}
                      </time>
                    </div>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                    <div className="notification-drawer-item-actions">
                      {isSafeApplicationPath(item.deepLink) ? (
                        <Link
                          href={item.deepLink}
                          onClick={() => setOpen(false)}
                        >
                          查看对应记录
                        </Link>
                      ) : (
                        <span>关联记录不可访问</span>
                      )}
                      {!item.readAt ? (
                        <button
                          type="button"
                          disabled={markingId === item.notificationId}
                          onClick={() => void markRead(item)}
                        >
                          {markingId === item.notificationId
                            ? "处理中…"
                            : "标为已读"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
          </aside>
        </>
      ) : null}
    </div>
  );
}

function isSafeApplicationPath(value: string): boolean {
  return /^\/(?!\/)[^\r\n]*$/.test(value);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}
