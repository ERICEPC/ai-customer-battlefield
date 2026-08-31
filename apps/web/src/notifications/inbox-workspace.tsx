"use client";

import type {
  InboxItem,
  InboxPage,
  InboxQuery,
  MarkNotificationReadResponse,
} from "@battlefield/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { listInbox, markNotificationRead } from "./api-client";

export interface InboxWorkspaceApi {
  list(input: InboxQuery): Promise<InboxPage>;
  markRead(notificationId: string): Promise<MarkNotificationReadResponse>;
}

const defaultApi: InboxWorkspaceApi = {
  list: listInbox,
  markRead: markNotificationRead,
};

export function InboxWorkspace({
  api = defaultApi,
}: {
  api?: InboxWorkspaceApi;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const [markingIds, setMarkingIds] = useState<ReadonlySet<string>>(new Set());
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestVersion = useRef(0);
  const visibleItems = unreadOnly
    ? items.filter((item) => item.readAt === null)
    : items;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadVersion intentionally triggers recovery.
  useEffect(() => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setIsLoading(true);
    setIsLoadingMore(false);
    setLoadError(null);
    setCursor(null);
    api
      .list({ ...(unreadOnly ? { unreadOnly: true } : {}), limit: 50 })
      .then((page) => {
        if (version !== requestVersion.current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (version !== requestVersion.current) return;
        setLoadError(errorMessage(error));
        setItems([]);
      })
      .finally(() => {
        if (version === requestVersion.current) setIsLoading(false);
      });
  }, [api, unreadOnly, reloadVersion]);

  async function loadMore(): Promise<void> {
    if (!cursor || isLoadingMore) return;
    const version = requestVersion.current;
    setIsLoadingMore(true);
    try {
      const page = await api.list({
        ...(unreadOnly ? { unreadOnly: true } : {}),
        cursor,
        limit: 50,
      });
      if (version !== requestVersion.current) return;
      setItems((current) => mergeNotifications(current, page.items));
      setCursor(page.nextCursor);
    } catch (error) {
      if (version === requestVersion.current) setLoadError(errorMessage(error));
    } finally {
      if (version === requestVersion.current) setIsLoadingMore(false);
    }
  }

  async function markRead(item: InboxItem): Promise<void> {
    if (item.readAt || markingIds.has(item.notificationId)) return;
    setMarkingIds((current) => new Set(current).add(item.notificationId));
    setReadErrors((current) => omitKey(current, item.notificationId));
    try {
      const receipt = await api.markRead(item.notificationId);
      setItems((current) =>
        current.map((candidate) =>
          candidate.notificationId === receipt.notificationId
            ? { ...candidate, readAt: receipt.readAt }
            : candidate,
        ),
      );
    } catch (error) {
      setReadErrors((current) => ({
        ...current,
        [item.notificationId]: errorMessage(error),
      }));
    } finally {
      setMarkingIds((current) => {
        const next = new Set(current);
        next.delete(item.notificationId);
        return next;
      });
    }
  }

  return (
    <section className="inbox-workspace" aria-label="通知列表">
      <div className="inbox-toolbar">
        <label className="compact-check">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.currentTarget.checked)}
          />
          只看未读
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setReloadVersion((value) => value + 1)}
        >
          刷新通知
        </button>
      </div>

      {isLoading ? (
        <div className="battle-page-state" role="status">
          <span className="loading-mark" aria-hidden="true" />
          正在加载通知…
        </div>
      ) : null}
      {loadError ? (
        <div className="battle-error" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setReloadVersion((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      ) : null}
      {!isLoading && !loadError && visibleItems.length === 0 ? (
        <div className="battle-empty">
          <span aria-hidden="true">✓</span>
          <h2>暂时没有通知</h2>
          <p>
            {unreadOnly ? "所有通知都已处理。" : "新的动作提醒会出现在这里。"}
          </p>
        </div>
      ) : null}
      {!isLoading && !loadError && visibleItems.length > 0 ? (
        <div className="inbox-list">
          {visibleItems.map((item) => {
            const marking = markingIds.has(item.notificationId);
            const readError = readErrors[item.notificationId];
            return (
              <article
                className={`inbox-card${item.readAt ? " is-read" : " is-unread"}`}
                aria-label={item.title}
                key={item.notificationId}
              >
                <div className="inbox-status-column">
                  <span className="inbox-unread-dot" aria-hidden="true" />
                  <span>{item.readAt ? "已读" : "未读"}</span>
                </div>
                <div className="inbox-card-content">
                  <div className="inbox-card-heading">
                    <div>
                      <span
                        className={`notification-priority priority-${item.priority}`}
                      >
                        {priorityLabel(item.priority)}
                      </span>
                      <time dateTime={item.createdAt}>
                        {formatTime(item.createdAt)}
                      </time>
                    </div>
                    <h2>{item.title}</h2>
                  </div>
                  <p>{item.body}</p>
                  <div className="inbox-card-actions">
                    {isSafeApplicationPath(item.deepLink) ? (
                      <Link href={item.deepLink}>查看详情</Link>
                    ) : (
                      <span>关联记录链接不可用</span>
                    )}
                    {!item.readAt ? (
                      <button
                        type="button"
                        className="text-button"
                        disabled={marking}
                        onClick={() => void markRead(item)}
                      >
                        {readError
                          ? "重试标记已读"
                          : marking
                            ? "正在标记…"
                            : "标为已读"}
                      </button>
                    ) : null}
                  </div>
                  {readError ? <div role="alert">{readError}</div> : null}
                </div>
              </article>
            );
          })}
          {cursor ? (
            <div className="inbox-pagination">
              <button
                type="button"
                className="secondary-button"
                disabled={isLoadingMore}
                onClick={() => void loadMore()}
              >
                {isLoadingMore ? "正在加载…" : "加载更多通知"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function mergeNotifications(
  current: InboxItem[],
  incoming: InboxItem[],
): InboxItem[] {
  const merged = new Map(current.map((item) => [item.notificationId, item]));
  for (const item of incoming) merged.set(item.notificationId, item);
  return [...merged.values()];
}

function omitKey(
  source: Record<string, string>,
  key: string,
): Record<string, string> {
  const next = { ...source };
  delete next[key];
  return next;
}

function isSafeApplicationPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\r") &&
    !value.includes("\n")
  );
}

function priorityLabel(priority: InboxItem["priority"]): string {
  return {
    low: "低优先级",
    medium: "中优先级",
    high: "高优先级",
    urgent: "紧急",
  }[priority];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "通知操作失败，请重试。";
}
