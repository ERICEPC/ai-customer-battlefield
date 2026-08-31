"use client";

import type {
  ManagementQueryEvidence,
  ManagementQueryMetrics,
  ManagementQueryRequest,
  ManagementQueryResult,
  ManagementQuerySubject,
  ManagementQuerySubjectListQuery,
  ManagementQuerySubjectPage,
} from "@battlefield/contracts";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { listManagementQuerySubjects, runManagementQuery } from "./api-client";

export interface ManagementQueryWorkspaceApi {
  listSubjects(
    input: ManagementQuerySubjectListQuery,
  ): Promise<ManagementQuerySubjectPage>;
  run(input: ManagementQueryRequest): Promise<ManagementQueryResult>;
}

const defaultApi: ManagementQueryWorkspaceApi = {
  listSubjects: listManagementQuerySubjects,
  run: runManagementQuery,
};

export function ManagementQueryWorkspace({
  api = defaultApi,
  now = () => new Date(),
}: {
  api?: ManagementQueryWorkspaceApi;
  now?: () => Date;
}) {
  const initialPeriod = useRef(thisWeekDates(now()));
  const [subjects, setSubjects] = useState<ManagementQuerySubject[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState("");
  const [startDate, setStartDate] = useState(initialPeriod.current.start);
  const [endDate, setEndDate] = useState(initialPeriod.current.end);
  const [isSubjectLoading, setIsSubjectLoading] = useState(true);
  const [isSubjectSlow, setIsSubjectSlow] = useState(false);
  const [subjectError, setSubjectError] = useState<string | null>(null);
  const [subjectReloadVersion, setSubjectReloadVersion] = useState(0);
  const [result, setResult] = useState<ManagementQueryResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isQuerySlow, setIsQuerySlow] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const subjectRequestVersion = useRef(0);
  const queryRequestVersion = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: subjectReloadVersion intentionally triggers recovery.
  useEffect(() => {
    const version = subjectRequestVersion.current + 1;
    subjectRequestVersion.current = version;
    queryRequestVersion.current += 1;
    setIsSubjectLoading(true);
    setIsSubjectSlow(false);
    setSubjectError(null);
    setResult(null);
    setQueryError(null);
    const slowTimer = window.setTimeout(() => {
      if (subjectRequestVersion.current === version) setIsSubjectSlow(true);
    }, 2_000);
    loadAllSubjects(api)
      .then((items) => {
        if (subjectRequestVersion.current !== version) return;
        setSubjects(items);
        setSelectedSubjectId((current) =>
          items.some((item) => item.userId === current)
            ? current
            : (items[0]?.userId ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (subjectRequestVersion.current !== version) return;
        setSubjects([]);
        setSelectedSubjectId("");
        setSubjectError(errorMessage(error, "销售目录读取失败，请重试。"));
      })
      .finally(() => {
        window.clearTimeout(slowTimer);
        if (subjectRequestVersion.current === version) {
          setIsSubjectLoading(false);
          setIsSubjectSlow(false);
        }
      });
    return () => window.clearTimeout(slowTimer);
  }, [api, subjectReloadVersion]);

  function invalidateResult(): void {
    queryRequestVersion.current += 1;
    setResult(null);
    setQueryError(null);
    setValidationError(null);
    setIsRunning(false);
    setIsQuerySlow(false);
  }

  function selectSubject(userId: string): void {
    invalidateResult();
    setSelectedSubjectId(userId);
  }

  function changePeriod(setter: (value: string) => void, value: string): void {
    invalidateResult();
    setter(value);
  }

  async function submit(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const request = buildRequest({
      subjectUserId: selectedSubjectId,
      startDate,
      endDate,
      now: now(),
    });
    if (typeof request === "string") {
      setValidationError(request);
      return;
    }

    const version = queryRequestVersion.current + 1;
    queryRequestVersion.current = version;
    setValidationError(null);
    setQueryError(null);
    setIsRunning(true);
    setIsQuerySlow(false);
    const slowTimer = window.setTimeout(() => {
      if (queryRequestVersion.current === version) setIsQuerySlow(true);
    }, 2_000);
    try {
      const nextResult = await api.run(request);
      if (queryRequestVersion.current === version) setResult(nextResult);
    } catch (error) {
      if (queryRequestVersion.current === version) {
        setResult(null);
        setQueryError(errorMessage(error, "管理问数失败，请重试。"));
      }
    } finally {
      window.clearTimeout(slowTimer);
      if (queryRequestVersion.current === version) {
        setIsRunning(false);
        setIsQuerySlow(false);
      }
    }
  }

  if (isSubjectLoading) {
    return (
      <section className="ask-loading" role="status" aria-live="polite">
        <span className="loading-mark" aria-hidden="true" />
        <h1>正在读取可问销售…</h1>
        <p>
          {isSubjectSlow
            ? "仍在核对当前责任关系，请稍候…"
            : "只会返回你当前有权查看的销售。"}
        </p>
      </section>
    );
  }

  if (subjectError) {
    return (
      <section className="ask-state ask-error" role="alert">
        <span aria-hidden="true">!</span>
        <h1>销售目录暂不可用</h1>
        <p>{subjectError}</p>
        <button
          type="button"
          onClick={() => setSubjectReloadVersion((value) => value + 1)}
        >
          重新加载销售
        </button>
      </section>
    );
  }

  if (subjects.length === 0) {
    return (
      <section className="ask-state ask-empty">
        <span aria-hidden="true">○</span>
        <h1>当前没有可问销售</h1>
        <p>
          这里只按当前负责人、协作人和管理观察关系授权，不会展示同租户的未授权成员。
        </p>
        <Link href="/workspace">返回经营总览</Link>
      </section>
    );
  }

  return (
    <div className="management-query-workspace">
      <section className="page-heading ask-heading">
        <div>
          <p className="eyebrow">CONTROLLED MANAGEMENT QUERY</p>
          <h1>问进展，也要看证据</h1>
          <p>
            选择当前授权范围内的销售，按明确周期汇总经营事实。这里不开放任意
            SQL，也不会用模型补写不存在的结论。
          </p>
        </div>
        <div className="ask-boundary-note">
          <span aria-hidden="true">◎</span>
          当前责任关系实时裁剪
        </div>
      </section>

      <section className="ask-composer" aria-label="管理问数组合器">
        <div className="ask-question">
          <span>固定问题</span>
          <strong>销售本周有哪些可核验进展？</strong>
          <p>所有指标由正式业务记录确定性计算，证据链接仍会再次校验权限。</p>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            查询销售
            <select
              aria-label="查询销售"
              value={selectedSubjectId}
              onChange={(event) => selectSubject(event.currentTarget.value)}
            >
              {subjects.map((subject) => (
                <option value={subject.userId} key={subject.userId}>
                  {subject.displayName} · {scopeOptionLabel(subject.scopeKind)}
                </option>
              ))}
            </select>
          </label>
          <label>
            开始日期
            <input
              aria-label="开始日期"
              type="date"
              value={startDate}
              onChange={(event) =>
                changePeriod(setStartDate, event.currentTarget.value)
              }
            />
          </label>
          <label>
            结束日期（不含）
            <input
              aria-label="结束日期（不含）"
              type="date"
              value={endDate}
              onChange={(event) =>
                changePeriod(setEndDate, event.currentTarget.value)
              }
            />
          </label>
          <button type="submit">
            {isRunning || result || queryError
              ? "重新生成答复"
              : "生成进展答复"}
          </button>
        </form>
        <p className="ask-period-note">
          当前按 UTC 日界线计算；结束日期为不含当日的上界，单次最多 31 天。
        </p>
      </section>

      {validationError ? (
        <div className="ask-inline-error" role="alert">
          {validationError}
        </div>
      ) : null}
      {queryError ? (
        <div className="ask-inline-error" role="alert">
          <span>{queryError}</span>
          <button type="button" onClick={() => void submit()}>
            重试本次查询
          </button>
        </div>
      ) : null}
      {isRunning ? (
        <div className="ask-query-progress" role="status" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" />
          {isQuerySlow
            ? "仍在汇总责任范围内的事实与动作…"
            : "正在按责任范围汇总证据…"}
        </div>
      ) : null}
      {result ? <ManagementQueryAnswer result={result} /> : null}
    </div>
  );
}

function ManagementQueryAnswer({ result }: { result: ManagementQueryResult }) {
  return (
    <section
      className="ask-answer"
      aria-label={`${result.subject.displayName}的经营进展`}
    >
      <header className="ask-answer-heading">
        <div>
          <p className="eyebrow">EVIDENCE-BACKED ANSWER</p>
          <h2>{result.subject.displayName}的经营进展</h2>
          <p>
            {scopeResultLabel(result.scope.kind)} · {result.scope.entityCount}{" "}
            个对象
          </p>
        </div>
        <div className="ask-cutoff">
          <span>数据截止</span>
          <time dateTime={result.dataCutoffAt}>
            {formatDateTime(result.dataCutoffAt)}
          </time>
          <small>查询编号 {shortId(result.queryId)}</small>
        </div>
      </header>

      <MetricGrid metrics={result.metrics} />

      {result.scope.entityCount === 0 ? (
        <div className="ask-result-empty">
          <strong>该销售当前没有可查询的责任对象</strong>
          <p>结果没有扩大到租户内其他对象，也不会生成替代数据。</p>
        </div>
      ) : null}

      <div className="ask-answer-grid">
        <section className="ask-highlights" aria-label="经营对象进展">
          <div className="ask-section-heading">
            <div>
              <p className="eyebrow">ENTITY HIGHLIGHTS</p>
              <h3>经营对象进展</h3>
            </div>
            <span>{result.highlights.length} 个有记录对象</span>
          </div>
          {result.highlights.length === 0 ? (
            <div className="ask-result-empty">
              <strong>周期内没有可核验进展</strong>
              <p>没有记录不等于没有推进，请补充并确认正式跟进事实。</p>
            </div>
          ) : (
            <ol className="ask-highlight-list">
              {result.highlights.map((highlight) => (
                <li key={highlight.entityId}>
                  <article aria-label={`${highlight.entityName}进展`}>
                    <div className="ask-highlight-heading">
                      <div>
                        <h4>{highlight.entityName}</h4>
                        <p>{highlightMetricSummary(highlight)}</p>
                      </div>
                      {highlight.latestActivityAt ? (
                        <time dateTime={highlight.latestActivityAt}>
                          {formatDateTime(highlight.latestActivityAt)}
                        </time>
                      ) : null}
                    </div>
                    <ul className="ask-evidence-list">
                      {highlight.evidence.map((evidence) => (
                        <li key={`${evidence.kind}:${evidence.evidenceId}`}>
                          <span>{evidenceKindLabel(evidence.kind)}</span>
                          <Link href={evidence.deepLink}>{evidence.label}</Link>
                          <time dateTime={evidence.occurredAt}>
                            {formatDateTime(evidence.occurredAt)}
                          </time>
                        </li>
                      ))}
                    </ul>
                  </article>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="ask-gaps" aria-label="数据缺口">
          <div className="ask-section-heading">
            <div>
              <p className="eyebrow">DATA GAPS</p>
              <h3>不能替你判断的部分</h3>
            </div>
            <span>{result.dataGaps.length} 项</span>
          </div>
          {result.dataGaps.length === 0 ? (
            <div className="ask-result-empty compact">
              <strong>当前没有缺失的作战状态</strong>
              <p>仍应沿证据链接核对关键变化。</p>
            </div>
          ) : (
            <ul className="ask-gap-list">
              {result.dataGaps.map((gap) => (
                <li key={gap.entityId}>
                  <strong>{gap.entityName}</strong>
                  <p>{gap.message}</p>
                  <Link href="/battle-map">前往作战地图</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

function MetricGrid({ metrics }: { metrics: ManagementQueryMetrics }) {
  const items = [
    ["确认跟进", metrics.confirmedFollowupCount],
    ["有效事实", metrics.validFactCount],
    ["阶段变化", metrics.stageChangeCount],
    ["已完成动作", metrics.completedActionCount],
    ["开放动作", metrics.openActionCount],
    ["逾期动作", metrics.overdueActionCount],
  ] as const;
  return (
    <section className="ask-metric-grid" aria-label="进展指标">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

async function loadAllSubjects(
  api: ManagementQueryWorkspaceApi,
): Promise<ManagementQuerySubject[]> {
  const subjects = new Map<string, ManagementQuerySubject>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await api.listSubjects({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) subjects.set(item.userId, item);
    if (!page.nextCursor) return [...subjects.values()];
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("销售目录分页游标重复，已停止加载。");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("可问销售数量超过当前页面支持范围。");
}

function buildRequest(input: {
  subjectUserId: string;
  startDate: string;
  endDate: string;
  now: Date;
}): ManagementQueryRequest | string {
  if (!input.subjectUserId) return "请先选择要查询的销售。";
  const start = Date.parse(`${input.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${input.endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "请选择有效的开始日期和结束日期。";
  }
  if (end <= start) return "结束日期必须晚于开始日期。";
  if (end - start > 31 * 24 * 60 * 60 * 1_000) {
    return "单次查询周期不能超过 31 天。";
  }
  if (!Number.isFinite(input.now.getTime()) || start > input.now.getTime()) {
    return "开始日期不能晚于当前时间。";
  }
  return {
    capability: "sales_weekly_progress",
    subjectUserId: input.subjectUserId,
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
  };
}

function thisWeekDates(now: Date): { start: string; end: string } {
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date(0);
  const day = safeNow.getUTCDay() || 7;
  const monday = new Date(
    Date.UTC(
      safeNow.getUTCFullYear(),
      safeNow.getUTCMonth(),
      safeNow.getUTCDate() - day + 1,
    ),
  );
  const nextMonday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1_000);
  return {
    start: monday.toISOString().slice(0, 10),
    end: nextMonday.toISOString().slice(0, 10),
  };
}

function scopeOptionLabel(scope: ManagementQuerySubject["scopeKind"]): string {
  return scope === "self" ? "本人范围" : "管理观察范围";
}

function scopeResultLabel(
  scope: ManagementQueryResult["scope"]["kind"],
): string {
  return scope === "self" ? "本人责任范围" : "管理观察范围";
}

function evidenceKindLabel(kind: ManagementQueryEvidence["kind"]): string {
  return {
    followup: "确认跟进",
    fact: "有效事实",
    stage_change: "阶段变化",
    action: "经营动作",
    battle_state: "作战状态",
  }[kind];
}

function highlightMetricSummary(metrics: ManagementQueryMetrics): string {
  return [
    `跟进 ${metrics.confirmedFollowupCount}`,
    `事实 ${metrics.validFactCount}`,
    `阶段变化 ${metrics.stageChangeCount}`,
    `完成动作 ${metrics.completedActionCount}`,
    `开放动作 ${metrics.openActionCount}`,
  ].join(" · ");
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
