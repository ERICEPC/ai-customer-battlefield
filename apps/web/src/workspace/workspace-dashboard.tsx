"use client";

import type {
  WorkspaceBattleChange,
  WorkspaceKpis,
  WorkspacePriorityAction,
  WorkspaceScopeMode,
  WorkspaceSnapshot,
} from "@battlefield/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useOptionalSession } from "../auth/session-provider";
import { getWorkspaceSnapshot } from "./api-client";

export interface WorkspaceDashboardApi {
  get(): Promise<WorkspaceSnapshot>;
}

const defaultApi: WorkspaceDashboardApi = { get: getWorkspaceSnapshot };

export function WorkspaceDashboard({
  api = defaultApi,
}: {
  api?: WorkspaceDashboardApi;
}) {
  const sessionContext = useOptionalSession();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSlowLoading, setIsSlowLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestVersion = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadVersion intentionally triggers recovery.
  useEffect(() => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setIsLoading(true);
    setIsSlowLoading(false);
    setLoadError(null);
    const slowLoadingTimer = window.setTimeout(() => {
      if (requestVersion.current === version) setIsSlowLoading(true);
    }, 2_000);
    api
      .get()
      .then((nextSnapshot) => {
        if (requestVersion.current === version) setSnapshot(nextSnapshot);
      })
      .catch((error: unknown) => {
        if (requestVersion.current !== version) return;
        setSnapshot(null);
        setLoadError(errorMessage(error));
      })
      .finally(() => {
        window.clearTimeout(slowLoadingTimer);
        if (requestVersion.current === version) {
          setIsLoading(false);
          setIsSlowLoading(false);
        }
      });
    return () => window.clearTimeout(slowLoadingTimer);
  }, [api, reloadVersion]);

  if (isLoading && !snapshot) {
    return (
      <div
        className="workspace-loading"
        role="status"
        aria-live="polite"
        data-testid="workspace-loading-skeleton"
      >
        <p>
          <span className="loading-mark" aria-hidden="true" />
          正在加载经营工作台…
        </p>
        {isSlowLoading ? <p>仍在汇总你的责任范围与经营变化…</p> : null}
        <div className="workspace-skeleton-heading" aria-hidden="true">
          <span />
          <span />
        </div>
        <div className="workspace-skeleton-kpis" aria-hidden="true">
          {["scope", "draft", "action", "risk"].map((item) => (
            <span key={item} />
          ))}
        </div>
        <div className="workspace-skeleton-panels" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>
    );
  }

  if (loadError || !snapshot) {
    return (
      <div className="battle-error workspace-load-error" role="alert">
        <span>{loadError ?? "工作台暂时无法读取。"}</span>
        <button
          type="button"
          onClick={() => setReloadVersion((value) => value + 1)}
        >
          重新加载
        </button>
      </div>
    );
  }

  const presentation = scopePresentation(snapshot.scopeMode);
  const noVisibleEntities = snapshot.kpis.assignedEntityCount === 0;

  return (
    <div className="workspace-dashboard">
      <section className="page-heading workspace-heading">
        <div>
          <p className="eyebrow">ROLE-SCOPED WORKSPACE</p>
          <h1>{presentation.title}</h1>
          <p>{presentation.description}</p>
        </div>
        <div className="workspace-generated-at">
          <span>数据时间</span>
          <time dateTime={snapshot.generatedAt}>
            {formatDateTime(snapshot.generatedAt)}
          </time>
        </div>
      </section>

      <div className={`workspace-scope-note scope-${snapshot.scopeMode}`}>
        <span aria-hidden="true">◎</span>
        <div>
          <strong>{presentation.boundaryTitle}</strong>
          <p>{presentation.boundaryCopy}</p>
        </div>
        {sessionContext?.session?.role !== "sales" ? (
          <Link className="workspace-query-entry" href="/ask">
            查看销售进展
          </Link>
        ) : null}
      </div>

      <KpiGrid kpis={snapshot.kpis} />

      {noVisibleEntities ? (
        <section className="workspace-empty-scope">
          <span aria-hidden="true">○</span>
          <h2>当前没有可见经营对象</h2>
          <p>
            工作台不会显示租户内其他人的对象。请由管理员配置负责人、协作人或管理观察关系。
          </p>
          <Link href="/entities">查看经营对象目录</Link>
        </section>
      ) : (
        <>
          <div className="workspace-main-grid">
            <PriorityActionPanel actions={snapshot.priorityActions} />
            <BattleChangePanel
              changes={snapshot.recentBattleChanges}
              incompleteCount={snapshot.kpis.dataIncompleteEntityCount}
            />
          </div>
          <QuadrantPanel snapshot={snapshot} />
        </>
      )}
    </div>
  );
}

function KpiGrid({ kpis }: { kpis: WorkspaceKpis }) {
  const cards = [
    {
      label: "可见经营对象",
      value: kpis.assignedEntityCount,
      detail: "按当前有效责任关系裁剪",
      href: "/entities",
      tone: "blue",
    },
    {
      label: "待确认草稿",
      value: kpis.pendingDraftCount,
      detail: "只统计由我提交的草稿",
      href: "/",
      tone: "violet",
    },
    {
      label: "待决策建议",
      value: kpis.pendingProposalCount,
      detail: "等待业务确认后才会成为动作",
      href: "/actions",
      tone: "violet",
    },
    {
      label: "已到计划时间",
      value: kpis.overdueActionCount,
      detail: "基于服务端快照时间判断",
      href: "/actions",
      tone: "orange",
    },
    {
      label: "未读通知",
      value: kpis.unreadNotificationCount,
      detail: "仅统计我的站内通知",
      href: "/inbox",
      tone: "blue",
    },
    {
      label: "高风险对象",
      value: kpis.highRiskEntityCount,
      detail: "当前分析为高或严重风险",
      href: "/battle-map",
      tone: "red",
    },
    {
      label: "数据不完整",
      value: kpis.dataIncompleteEntityCount,
      detail: "需要补充事实后再判断",
      href: "/battle-map",
      tone: "gray",
    },
  ] as const;

  return (
    <section className="workspace-kpi-grid" aria-label="经营概况">
      {cards.map((card) => (
        <Link
          className={`workspace-kpi-card tone-${card.tone}`}
          href={card.href}
          aria-label={`${card.label} ${card.value}`}
          key={card.label}
        >
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.detail}</small>
        </Link>
      ))}
    </section>
  );
}

function PriorityActionPanel({
  actions,
}: {
  actions: readonly WorkspacePriorityAction[];
}) {
  return (
    <section className="workspace-panel workspace-actions-panel">
      <div className="workspace-panel-heading">
        <div>
          <p className="eyebrow">PRIORITY ACTIONS</p>
          <h2>优先推进</h2>
        </div>
        <Link href="/actions">全部动作</Link>
      </div>
      {actions.length === 0 ? (
        <div className="workspace-panel-empty">
          <strong>当前没有待推进动作</strong>
          <p>新的正式动作会在业务确认后出现在这里。</p>
        </div>
      ) : (
        <ol className="workspace-action-list">
          {actions.map((action) => (
            <li key={action.actionId}>
              <article aria-label={action.title}>
                <div className="workspace-action-meta">
                  <span className={`priority-${action.priority}`}>
                    {priorityLabel(action.priority)}
                  </span>
                  <span className={action.isOverdue ? "is-overdue" : undefined}>
                    {action.isOverdue ? "已到计划时间" : "等待推进"}
                  </span>
                </div>
                <h3>{action.title}</h3>
                <p>
                  {action.entityName} · 负责人 {action.ownerName}
                </p>
                <div className="workspace-action-footer">
                  <time dateTime={action.plannedAt}>
                    计划 {formatDateTime(action.plannedAt)}
                  </time>
                  <Link href={action.deepLink}>查看动作</Link>
                </div>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function BattleChangePanel({
  changes,
  incompleteCount,
}: {
  changes: readonly WorkspaceBattleChange[];
  incompleteCount: number;
}) {
  return (
    <section className="workspace-panel workspace-changes-panel">
      <div className="workspace-panel-heading">
        <div>
          <p className="eyebrow">BATTLE CHANGES</p>
          <h2>近期变化</h2>
        </div>
        <Link href="/battle-map">作战地图</Link>
      </div>
      {changes.length === 0 ? (
        <div className="workspace-panel-empty">
          <strong>暂无已完成的作战分析</strong>
          <p>
            {incompleteCount > 0
              ? `${incompleteCount} 个对象的数据仍不完整。先补充事实，再形成判断。`
              : "确认跟进事实后，最新的作战变化会出现在这里。"}
          </p>
        </div>
      ) : (
        <ol className="workspace-change-list">
          {changes.map((change) => (
            <li key={change.battleStateVersionId}>
              <article aria-label={`${change.entityName}作战变化`}>
                <div className="workspace-change-heading">
                  <div>
                    <h3>{change.entityName}</h3>
                    <time dateTime={change.effectiveAt}>
                      {formatDateTime(change.effectiveAt)}
                    </time>
                  </div>
                  {change.isT0 ? <span className="t0-badge">T0</span> : null}
                </div>
                <div className="workspace-change-tags">
                  {change.changeKind === "new_baseline" ? (
                    <span>首次基线</span>
                  ) : (
                    <>
                      {change.relationshipDelta !== null ? (
                        <span>关系 {signed(change.relationshipDelta)}</span>
                      ) : null}
                      {change.potentialDelta !== null ? (
                        <span>潜力 {signed(change.potentialDelta)}</span>
                      ) : null}
                      {change.quadrantChanged ? <span>象限变化</span> : null}
                    </>
                  )}
                  <span className={`risk-${change.riskLevel}`}>
                    {riskLabel(change.riskLevel)}
                  </span>
                </div>
                <p>
                  当前象限：{quadrantLabel(change.quadrantCode)} · 数据
                  {sufficiencyLabel(change.dataSufficiency)}
                </p>
                {change.dataGaps.length > 0 ? (
                  <div className="workspace-data-gaps">
                    <strong>待补充事实</strong>
                    <ul>
                      {change.dataGaps.slice(0, 3).map((gap) => (
                        <li key={gap}>{gap}</li>
                      ))}
                    </ul>
                    {change.dataGaps.length > 3 ? (
                      <small>另有 {change.dataGaps.length - 3} 项待补充</small>
                    ) : null}
                  </div>
                ) : null}
                <Link href={change.deepLink}>查看作战状态</Link>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function QuadrantPanel({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <section className="workspace-panel workspace-quadrant-panel">
      <div className="workspace-panel-heading">
        <div>
          <p className="eyebrow">PORTFOLIO DISTRIBUTION</p>
          <h2>当前象限分布</h2>
        </div>
        <span>覆盖全部 {snapshot.kpis.assignedEntityCount} 个可见对象</span>
      </div>
      <div className="workspace-quadrant-list">
        {snapshot.quadrantDistribution.map((bucket) => (
          <div key={bucket.quadrantCode ?? "unpositioned"}>
            <div>
              <strong>{quadrantLabel(bucket.quadrantCode)}</strong>
              <span>{bucket.count}</span>
            </div>
            <progress
              aria-label={`${quadrantLabel(bucket.quadrantCode)} ${bucket.count}`}
              max={snapshot.kpis.assignedEntityCount}
              value={bucket.count}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function scopePresentation(mode: WorkspaceScopeMode): {
  title: string;
  description: string;
  boundaryTitle: string;
  boundaryCopy: string;
} {
  if (mode === "personal") {
    return {
      title: "今日工作台",
      description: "把需要确认、需要推进和需要补充的数据放在同一个工作面上。",
      boundaryTitle: "我的责任范围",
      boundaryCopy:
        "对象仅限我直接负责或协作的范围；动作仅显示由我负责的正式动作。",
    };
  }
  if (mode === "observed_portfolio") {
    return {
      title: "经营总览",
      description: "先看观察范围内的变化与风险，再决定是否需要管理介入。",
      boundaryTitle: "管理观察范围",
      boundaryCopy:
        "对象仅限我被授权观察的范围；可查看这些对象的全部开放动作，但不代表动作归我负责。",
    };
  }
  return {
    title: "我的推进与观察范围",
    description: "先完成自己的推进，再从被授权的经营组合中识别需要介入的变化。",
    boundaryTitle: "混合责任范围",
    boundaryCopy:
      "对象同时包含我的直接责任范围与授权观察范围，重复关系只计一次；动作按本人负责或观察对象的开放状态分别纳入。",
  };
}

function priorityLabel(priority: WorkspacePriorityAction["priority"]): string {
  return {
    low: "低优先级",
    medium: "中优先级",
    high: "高优先级",
    urgent: "紧急",
  }[priority];
}

function riskLabel(risk: WorkspaceBattleChange["riskLevel"]): string {
  return {
    low: "低风险",
    medium: "中风险",
    high: "高风险",
    critical: "严重风险",
  }[risk];
}

function sufficiencyLabel(
  sufficiency: WorkspaceBattleChange["dataSufficiency"],
): string {
  return {
    insufficient: "不足",
    partial: "部分完整",
    sufficient: "充分",
  }[sufficiency];
}

function quadrantLabel(code: string | null): string {
  if (code === null) return "尚未定位";
  return (
    {
      focus: "重点突破",
      develop: "发展培育",
      maintain: "稳态经营",
      observe: "持续观察",
      incubate: "长期培育",
      high_relationship_high_potential: "高关系 · 高潜力",
      high_relationship_low_potential: "高关系 · 低潜力",
      low_relationship_high_potential: "低关系 · 高潜力",
      low_relationship_low_potential: "低关系 · 低潜力",
    }[code] ?? code
  );
}

function signed(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  return normalized > 0 ? `+${normalized}` : String(normalized);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "工作台读取失败，请重试。";
}
