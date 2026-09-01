"use client";

import type {
  BusinessEntityListItem,
  BusinessEntityListQuery,
  BusinessEntityPage,
  BusinessEntityStatus,
} from "@battlefield/contracts";
import { useCallback, useEffect, useState } from "react";

import { listBusinessEntities } from "./api-client";

export type BusinessEntityDirectoryRequest = (
  query: BusinessEntityListQuery,
) => Promise<BusinessEntityPage>;

interface BusinessEntityDirectoryProps {
  request?: BusinessEntityDirectoryRequest;
}

const PAGE_SIZE = 20;

export function BusinessEntityDirectory({
  request = listBusinessEntities,
}: BusinessEntityDirectoryProps) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<BusinessEntityStatus | "">("");
  const [items, setItems] = useState<BusinessEntityListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const createQuery = useCallback(
    (cursor?: string): BusinessEntityListQuery => ({
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
      limit: PAGE_SIZE,
    }),
    [search, status],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadVersion is an intentional retry token.
  useEffect(() => {
    let isCurrent = true;
    setIsLoading(true);
    setHasError(false);
    setItems([]);
    setNextCursor(null);

    request(createQuery())
      .then((page) => {
        if (!isCurrent) {
          return;
        }
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (isCurrent) {
          setHasError(true);
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsLoading(false);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [createQuery, reloadVersion, request]);

  async function loadMore(): Promise<void> {
    if (!nextCursor || isLoadingMore) {
      return;
    }
    setIsLoadingMore(true);
    setHasError(false);
    try {
      const page = await request(createQuery(nextCursor));
      setItems((currentItems) => mergeUnique(currentItems, page.items));
      setNextCursor(page.nextCursor);
    } catch {
      setHasError(true);
    } finally {
      setIsLoadingMore(false);
    }
  }

  return (
    <section className="directory-panel" aria-labelledby="directory-title">
      <div className="directory-toolbar">
        <div>
          <p className="eyebrow">ENTITY DIRECTORY</p>
          <h2 id="directory-title">经营对象目录</h2>
          <p>统一查看当前负责人、主商机阶段与最近经营变化。</p>
        </div>
        <div className="directory-filters">
          <label>
            <span>搜索经营对象</span>
            <input
              type="search"
              value={searchInput}
              maxLength={100}
              placeholder="名称或简称"
              onChange={(event) => setSearchInput(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>经营状态</span>
            <select
              value={status}
              onChange={(event) =>
                setStatus(
                  event.currentTarget.value as BusinessEntityStatus | "",
                )
              }
            >
              <option value="">全部状态</option>
              <option value="active">经营中</option>
              <option value="inactive">已停用</option>
              <option value="archived">已归档</option>
            </select>
          </label>
        </div>
      </div>

      {isLoading ? (
        <div className="directory-state" role="status">
          <span className="loading-mark" aria-hidden="true" />
          正在加载经营对象…
        </div>
      ) : null}

      {hasError ? (
        <div className="directory-error" role="alert">
          <div>
            <strong>经营对象加载失败</strong>
            <span>请检查网络或服务状态，已有筛选条件会保留。</span>
          </div>
          <button
            type="button"
            onClick={() => setReloadVersion((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      ) : null}

      {!isLoading && !hasError && items.length === 0 ? (
        <div className="directory-empty">
          <span aria-hidden="true">◇</span>
          <h3>暂时没有符合条件的经营对象</h3>
          <p>可以调整搜索词或经营状态后重试</p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="directory-table-wrap">
          <table className="business-entity-table" aria-label="经营对象目录">
            <thead>
              <tr>
                <th scope="col">经营对象</th>
                <th scope="col">负责人</th>
                <th scope="col">主商机</th>
                <th scope="col">阶段</th>
                <th scope="col">状态</th>
                <th scope="col">最新跟进</th>
                <th scope="col">最近更新</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <BusinessEntityRow item={item} key={item.id} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {nextCursor ? (
        <div className="directory-pagination">
          <button type="button" disabled={isLoadingMore} onClick={loadMore}>
            {isLoadingMore ? "正在加载…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function BusinessEntityRow({ item }: { item: BusinessEntityListItem }) {
  return (
    <tr
      data-testid="business-entity-row"
      data-entity-id={item.id}
      className={item.isT0 ? "is-t0" : undefined}
    >
      <td data-label="经营对象">
        <div className="entity-name-cell">
          <div>
            <strong>{item.name}</strong>
            <span>{item.shortName ?? item.typeCode}</span>
          </div>
          {item.isT0 ? <span className="t0-badge">T0</span> : null}
        </div>
      </td>
      <td data-label="负责人">
        {item.primaryOwnerName ?? (
          <span className="data-gap">待补充负责人</span>
        )}
      </td>
      <td data-label="主商机">
        {item.primaryOpportunity?.name ?? (
          <span className="data-gap">暂无主商机</span>
        )}
      </td>
      <td data-label="阶段">
        {item.primaryOpportunity ? (
          <span className="stage-pill">
            {item.primaryOpportunity.stageLabel} ·{" "}
            {item.primaryOpportunity.stageProgress}%
          </span>
        ) : (
          <span className="data-gap">待补充阶段</span>
        )}
      </td>
      <td data-label="状态">
        <span className={`status-badge status-${item.status}`}>
          {statusLabel[item.status]}
        </span>
      </td>
      <td data-label="最新跟进" className="latest-followup-cell">
        {item.latestFollowup ? (
          <div>
            <a href={`/followups/${item.latestFollowup.followupId}`}>
              {item.latestFollowup.summary}
            </a>
            <time dateTime={item.latestFollowup.confirmedAt}>
              {formatDate(item.latestFollowup.confirmedAt)}
            </time>
          </div>
        ) : (
          <span className="data-gap">暂无正式跟进</span>
        )}
      </td>
      <td data-label="最近更新">
        <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
      </td>
    </tr>
  );
}

const statusLabel: Record<BusinessEntityStatus, string> = {
  active: "经营中",
  inactive: "已停用",
  archived: "已归档",
};

function mergeUnique(
  currentItems: BusinessEntityListItem[],
  nextItems: BusinessEntityListItem[],
): BusinessEntityListItem[] {
  const byId = new Map(currentItems.map((item) => [item.id, item]));
  for (const item of nextItems) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
