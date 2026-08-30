"use client";

import type {
  BattleAnalysisResult,
  BattleMapItem,
  BattleMapPage,
  BattleMapQuery,
  BattleStateDetail,
} from "@battlefield/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getBattleState,
  listBattleMap,
  requestBattleAnalysis,
} from "./api-client";

export interface BattleMapWorkspaceApi {
  listMap(input: BattleMapQuery): Promise<BattleMapPage>;
  getState(
    entityId: string,
    battleStateVersionId?: string,
  ): Promise<BattleStateDetail>;
  requestAnalysis(entityId: string): Promise<BattleAnalysisResult>;
}

const defaultApi: BattleMapWorkspaceApi = {
  listMap: listBattleMap,
  getState: getBattleState,
  requestAnalysis: requestBattleAnalysis,
};

type SufficiencyFilter = "" | "insufficient" | "partial" | "sufficient";

export function BattleMapWorkspace({
  api = defaultApi,
  initialEntityId,
  sourceStateVersionId,
}: {
  api?: BattleMapWorkspaceApi;
  initialEntityId?: string | undefined;
  sourceStateVersionId?: string | undefined;
}) {
  const [items, setItems] = useState<BattleMapItem[]>([]);
  const [sourceTarget, setSourceTarget] = useState<BattleMapItem | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BattleStateDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisReceipt, setAnalysisReceipt] = useState<string | null>(null);
  const [sufficiency, setSufficiency] = useState<SufficiencyFilter>("");
  const [t0Only, setT0Only] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const mapRequestVersion = useRef(0);
  const analysisRequestVersion = useRef(0);
  const activeAnalysisEntityId = useRef<string | undefined>(undefined);

  const query = useMemo<BattleMapQuery>(
    () => ({
      ...(t0Only ? { isT0: true } : {}),
      ...(sufficiency ? { dataSufficiency: sufficiency } : {}),
      limit: 100,
    }),
    [sufficiency, t0Only],
  );

  const fetchFirstPage = useCallback(() => api.listMap(query), [api, query]);

  const commitFirstPage = useCallback(
    (
      page: BattleMapPage,
      targetPage: BattleMapPage | null,
      targetId: string | undefined,
    ) => {
      const target = targetPage?.items[0] ?? null;
      setItems(page.items);
      setSourceTarget(target);
      setNextCursor(page.nextCursor);
      setSelectedId((current) => {
        if (targetId && target?.entityId === targetId) {
          return targetId;
        }
        if (targetId) return null;
        if (current && page.items.some((item) => item.entityId === current)) {
          return current;
        }
        return page.items[0]?.entityId ?? null;
      });
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadVersion intentionally triggers a request retry.
  useEffect(() => {
    let current = true;
    const requestVersion = mapRequestVersion.current + 1;
    mapRequestVersion.current = requestVersion;
    setIsLoading(true);
    setIsLoadingMore(false);
    setNextCursor(null);
    setLoadError(null);
    Promise.all([
      fetchFirstPage(),
      initialEntityId
        ? api.listMap({ entityId: initialEntityId, limit: 1 })
        : Promise.resolve(null),
    ])
      .then(([page, targetPage]) => {
        if (current && requestVersion === mapRequestVersion.current)
          commitFirstPage(page, targetPage, initialEntityId);
      })
      .catch((error: unknown) => {
        if (current && requestVersion === mapRequestVersion.current)
          setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (current && requestVersion === mapRequestVersion.current)
          setIsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, commitFirstPage, fetchFirstPage, initialEntityId, reloadVersion]);

  const selected =
    items.find((item) => item.entityId === selectedId) ??
    (sourceTarget?.entityId === selectedId ? sourceTarget : null);
  const selectedEntityId = selected?.entityId;
  const selectedStateId = selected?.state?.battleStateVersionId;
  const requestedSourceVersionId =
    selectedEntityId === initialEntityId ? sourceStateVersionId : undefined;

  useEffect(() => {
    if (activeAnalysisEntityId.current === selectedEntityId) return;
    activeAnalysisEntityId.current = selectedEntityId;
    analysisRequestVersion.current += 1;
    setIsAnalyzing(false);
    setAnalysisError(null);
    setAnalysisReceipt(null);
  }, [selectedEntityId]);

  useEffect(() => {
    let current = true;
    setDetail(null);
    if (!selectedEntityId || (!selectedStateId && !requestedSourceVersionId))
      return () => undefined;
    setIsDetailLoading(true);
    api
      .getState(selectedEntityId, requestedSourceVersionId)
      .then((value) => {
        if (current) setDetail(value);
      })
      .catch((error: unknown) => {
        if (current) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (current) setIsDetailLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, requestedSourceVersionId, selectedEntityId, selectedStateId]);

  async function analyzeSelected(): Promise<void> {
    if (!selected || isAnalyzing) return;
    const analyzedEntityId = selected.entityId;
    const requestVersion = analysisRequestVersion.current + 1;
    analysisRequestVersion.current = requestVersion;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setAnalysisReceipt(null);
    try {
      const result = await api.requestAnalysis(analyzedEntityId);
      if (requestVersion !== analysisRequestVersion.current) return;
      reloadMap();
      try {
        const latest = await api.getState(analyzedEntityId);
        if (requestVersion !== analysisRequestVersion.current) return;
        setDetail(latest);
      } catch (error) {
        if (requestVersion !== analysisRequestVersion.current) return;
        if (result.status === "completed") throw error;
        setDetail(null);
      }
      if (requestVersion !== analysisRequestVersion.current) return;
      setAnalysisReceipt(
        result.status === "completed"
          ? `分析已更新至版本 ${result.battleStateVersionNo}`
          : "事实已变化，本次旧分析未覆盖当前状态。",
      );
    } catch (error) {
      if (requestVersion === analysisRequestVersion.current)
        setAnalysisError(errorMessage(error));
    } finally {
      if (requestVersion === analysisRequestVersion.current)
        setIsAnalyzing(false);
    }
  }

  function reloadMap(): void {
    mapRequestVersion.current += 1;
    setNextCursor(null);
    setIsLoadingMore(false);
    setIsLoading(true);
    setReloadVersion((value) => value + 1);
  }

  function changeSufficiency(value: SufficiencyFilter): void {
    mapRequestVersion.current += 1;
    setNextCursor(null);
    setIsLoadingMore(false);
    setIsLoading(true);
    setSufficiency(value);
  }

  function changeT0Only(value: boolean): void {
    mapRequestVersion.current += 1;
    setNextCursor(null);
    setIsLoadingMore(false);
    setIsLoading(true);
    setT0Only(value);
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || isLoadingMore) return;
    const requestVersion = mapRequestVersion.current;
    setIsLoadingMore(true);
    setLoadError(null);
    try {
      const page = await api.listMap({ ...query, cursor: nextCursor });
      if (requestVersion !== mapRequestVersion.current) return;
      setItems((current) => mergeById(current, page.items, "entityId"));
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (requestVersion === mapRequestVersion.current)
        setLoadError(errorMessage(error));
    } finally {
      if (requestVersion === mapRequestVersion.current) setIsLoadingMore(false);
    }
  }

  const mapped = items.filter(hasCoordinates);
  const t0Items = items.filter((item) => item.isT0);
  const insufficientCount = items.filter(
    (item) => item.state?.dataSufficiency === "insufficient",
  ).length;

  return (
    <section className="battle-map-workspace" aria-label="客户作战地图工作区">
      <div className="battle-filterbar">
        <div>
          <span>数据充分度</span>
          <select
            aria-label="数据充分度"
            value={sufficiency}
            onChange={(event) =>
              changeSufficiency(event.currentTarget.value as SufficiencyFilter)
            }
          >
            <option value="">全部</option>
            <option value="sufficient">充分</option>
            <option value="partial">部分</option>
            <option value="insufficient">不足</option>
          </select>
        </div>
        <label className="compact-check">
          <input
            type="checkbox"
            checked={t0Only}
            onChange={(event) => changeT0Only(event.currentTarget.checked)}
          />
          只看 T0
        </label>
        <button type="button" className="secondary-button" onClick={reloadMap}>
          刷新地图
        </button>
      </div>

      {isLoading ? (
        <div className="battle-page-state" role="status">
          <span className="loading-mark" aria-hidden="true" />
          正在加载作战地图…
        </div>
      ) : null}
      {loadError ? (
        <div className="battle-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={reloadMap}>
            重新加载
          </button>
        </div>
      ) : null}
      {!isLoading && !loadError && items.length === 0 ? (
        <div className="battle-empty">
          <span aria-hidden="true">◇</span>
          <h2>当前筛选下还没有经营对象</h2>
          <p>调整充分度或 T0 条件，或先在经营对象目录补充数据。</p>
        </div>
      ) : null}

      {items.length > 0 || sourceTarget ? (
        <>
          <section className="battle-kpis" aria-label="地图关键指标">
            <Kpi label="已加载对象" value={items.length} />
            <Kpi label="T0 战略对象" value={t0Items.length} />
            <Kpi label="已定位" value={mapped.length} />
            <Kpi label="数据不足" value={insufficientCount} />
          </section>

          <section className="t0-section" aria-labelledby="t0-title">
            <div className="section-heading-inline">
              <div>
                <p className="eyebrow">STRATEGIC ACCOUNTS</p>
                <h2 id="t0-title">T0 战略对象</h2>
              </div>
              <span>{t0Items.length} 个重点对象</span>
            </div>
            {t0Items.length ? (
              <div className="t0-card-row">
                {t0Items.map((item) => (
                  <button
                    className={
                      item.entityId === selectedId
                        ? "t0-card selected"
                        : "t0-card"
                    }
                    type="button"
                    key={item.entityId}
                    onClick={() => setSelectedId(item.entityId)}
                  >
                    <span>T0 · {item.entityTypeCode}</span>
                    <strong>{item.entityName}</strong>
                    <small>{item.primaryOwnerName ?? "待补充负责人"}</small>
                    <em>{statePosition(item)}</em>
                  </button>
                ))}
              </div>
            ) : (
              <p className="section-empty">当前筛选结果中没有 T0 对象。</p>
            )}
          </section>

          <div className="battle-main-grid">
            <section className="plot-panel" aria-labelledby="plot-title">
              <div className="section-heading-inline">
                <div>
                  <p className="eyebrow">POSITION MAP</p>
                  <h2 id="plot-title">关系深度 × 规模潜力</h2>
                </div>
                <span>形状与标签提供非颜色编码</span>
              </div>
              <fieldset className="quadrant-plot" aria-label="二维作战位置图">
                <span className="axis-label axis-y">规模潜力 ↑</span>
                <span className="axis-label axis-x">关系深度 →</span>
                <span className="quadrant-label q1">重点推进</span>
                <span className="quadrant-label q2">潜力培育</span>
                <span className="quadrant-label q3">持续观察</span>
                <span className="quadrant-label q4">关系深化</span>
                {mapped.map((item) => (
                  <MapPoint
                    item={item}
                    selected={item.entityId === selectedId}
                    key={item.entityId}
                    onSelect={() => setSelectedId(item.entityId)}
                  />
                ))}
                {!mapped.length ? (
                  <p className="plot-empty">没有足够事实可形成点位。</p>
                ) : null}
              </fieldset>
              <p className="plot-caption">
                坐标仅来自已确认事实的当前分析版本；数据不足的对象不会被强行放入象限。
              </p>
            </section>

            <BattleExplanation
              item={selected}
              detail={detail}
              loading={isDetailLoading}
              analyzing={isAnalyzing}
              analysisError={analysisError}
              analysisReceipt={analysisReceipt}
              sourceStateVersionId={
                selected?.entityId === initialEntityId
                  ? sourceStateVersionId
                  : undefined
              }
              onAnalyze={analyzeSelected}
            />
          </div>

          <BattleMapTable
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          {nextCursor ? (
            <div className="battle-load-more">
              <button
                type="button"
                disabled={isLoading || isLoadingMore}
                onClick={loadMore}
              >
                {isLoadingMore ? "正在加载…" : "加载更多地图对象"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <section aria-label={`${label} ${value}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

function hasCoordinates(item: BattleMapItem): boolean {
  return Boolean(
    item.state?.relationshipScore !== null &&
      item.state?.relationshipScore !== undefined &&
      item.state.potentialScore !== null &&
      item.state.potentialScore !== undefined,
  );
}

function MapPoint({
  item,
  selected,
  onSelect,
}: {
  item: BattleMapItem;
  selected: boolean;
  onSelect(): void;
}) {
  const relationship = item.state?.relationshipScore ?? "0";
  const potential = item.state?.potentialScore ?? "0";
  const shape = item.isT0 ? "diamond" : "circle";
  return (
    <button
      type="button"
      data-testid="battle-map-point"
      data-shape={shape}
      className={`map-point ${shape} ${selected ? "selected" : ""}`}
      style={{ left: `${relationship}%`, bottom: `${potential}%` }}
      aria-label={`${item.entityName}，关系 ${relationship}，潜力 ${potential}，${item.isT0 ? "T0 菱形" : "普通圆点"}`}
      onClick={onSelect}
    >
      <span>{item.entityName}</span>
    </button>
  );
}

function BattleExplanation({
  item,
  detail,
  loading,
  analyzing,
  analysisError,
  analysisReceipt,
  sourceStateVersionId,
  onAnalyze,
}: {
  item: BattleMapItem | null;
  detail: BattleStateDetail | null;
  loading: boolean;
  analyzing: boolean;
  analysisError: string | null;
  analysisReceipt: string | null;
  sourceStateVersionId?: string | undefined;
  onAnalyze(): void;
}) {
  if (!item)
    return <aside className="battle-explanation">请选择经营对象。</aside>;
  const state = detail?.state ?? item.state;
  return (
    <aside className="battle-explanation" aria-label="选中对象位置解释">
      <div className="explanation-heading">
        <div>
          <span>{item.isT0 ? "T0 战略对象" : item.entityTypeCode}</span>
          <h2>{item.entityName}</h2>
          <p>{item.primaryOwnerName ?? "待补充负责人"}</p>
        </div>
        <button type="button" disabled={analyzing} onClick={onAnalyze}>
          {analyzing ? "分析中…" : "重新计算战场位置"}
        </button>
      </div>
      {sourceStateVersionId ? (
        <p className="analysis-message success" role="status">
          {state?.battleStateVersionId === sourceStateVersionId
            ? "已定位到该建议的来源状态版本。"
            : `无法读取该建议的来源状态 ${sourceStateVersionId}。`}
        </p>
      ) : null}
      {analysisError ? (
        <div className="analysis-message error" role="alert">
          <span>{analysisError}</span>
          <button type="button" className="text-button" onClick={onAnalyze}>
            重试分析
          </button>
        </div>
      ) : null}
      {analysisReceipt ? (
        <p className="analysis-message success" role="status">
          {analysisReceipt}
        </p>
      ) : null}
      {loading ? <p className="detail-loading">正在读取证据链…</p> : null}
      {!state ? (
        <div className="unanalysed-state">
          <strong>尚未形成作战位置</strong>
          <p>完成一次正式跟进后运行分析，系统才会依据确认事实生成位置。</p>
        </div>
      ) : (
        <>
          <div className={`sufficiency-banner ${state.dataSufficiency}`}>
            <span>{sufficiencyLabel(state.dataSufficiency)}</span>
            <small>分析版本 v{state.versionNo}</small>
          </div>
          <p className="battle-summary">{state.summary}</p>
          <dl className="score-grid">
            <div>
              <dt>关系</dt>
              <dd>{state.relationshipScore ?? "—"}</dd>
            </div>
            <div>
              <dt>潜力</dt>
              <dd>{state.potentialScore ?? "—"}</dd>
            </div>
            <div>
              <dt>风险</dt>
              <dd>{riskLabel(state.riskLevel)}</dd>
            </div>
            <div>
              <dt>计算时间</dt>
              <dd>{formatDateTime(state.effectiveAt)}</dd>
            </div>
          </dl>
          {state.dataGaps.length ? (
            <div className="evidence-block data-gaps-block">
              <h3>数据缺口</h3>
              <ul>
                {state.dataGaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="evidence-block">
            <h3>位置证据</h3>
            {detail?.evidenceFacts.length ? (
              <ul>
                {detail.evidenceFacts.map((fact) => (
                  <li key={fact.factId}>
                    <span>{fact.factType}</span>
                    <strong>{fact.factValue}</strong>
                    <time dateTime={fact.occurredAt}>
                      {formatDateTime(fact.occurredAt)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p>当前版本没有可展示的证据事实。</p>
            )}
          </div>
          <div className="evidence-block">
            <h3>判断信号</h3>
            {detail?.signals.length ? (
              <ul>
                {detail.signals.map((signal) => (
                  <li key={signal.signalId}>
                    <span>
                      {signal.dimension} · {signal.direction} ·{" "}
                      {signal.strength}
                    </span>
                    <strong>{signal.reason}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p>当前版本没有衍生判断信号。</p>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function BattleMapTable({
  items,
  selectedId,
  onSelect,
}: {
  items: BattleMapItem[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  return (
    <section className="map-list-panel" aria-labelledby="map-list-title">
      <div className="section-heading-inline">
        <div>
          <p className="eyebrow">ACCESSIBLE VIEW</p>
          <h2 id="map-list-title">对象位置列表</h2>
        </div>
        <span>与二维图使用同一数据</span>
      </div>
      <div className="map-table-wrap">
        <table aria-label="作战地图等价列表" className="battle-map-table">
          <thead>
            <tr>
              <th>经营对象</th>
              <th>负责人</th>
              <th>充分度</th>
              <th>关系 / 潜力</th>
              <th>象限</th>
              <th>版本</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.entityId}
                className={
                  item.entityId === selectedId ? "selected" : undefined
                }
              >
                <td data-label="经营对象">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onSelect(item.entityId)}
                  >
                    {item.entityName}
                  </button>
                </td>
                <td data-label="负责人">
                  {item.primaryOwnerName ?? "待补充负责人"}
                </td>
                <td data-label="充分度">
                  {item.state
                    ? sufficiencyLabel(item.state.dataSufficiency)
                    : "数据未计算"}
                </td>
                <td data-label="关系 / 潜力">
                  {hasCoordinates(item)
                    ? `${item.state?.relationshipScore} / ${item.state?.potentialScore}`
                    : "—"}
                </td>
                <td data-label="象限">{item.state?.quadrantCode ?? "—"}</td>
                <td data-label="版本">
                  {item.state ? `v${item.state.versionNo}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function statePosition(item: BattleMapItem): string {
  if (!item.state) return "数据未计算";
  if (!hasCoordinates(item))
    return sufficiencyLabel(item.state.dataSufficiency);
  return `${item.state.relationshipScore} / ${item.state.potentialScore}`;
}

function sufficiencyLabel(value: "insufficient" | "partial" | "sufficient") {
  return {
    insufficient: "数据不足",
    partial: "数据部分充分",
    sufficient: "数据充分",
  }[value];
}

function riskLabel(value: "low" | "medium" | "high" | "critical") {
  return { low: "低", medium: "中", high: "高", critical: "严重" }[value];
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

function mergeById<T, K extends keyof T>(
  current: T[],
  additions: T[],
  key: K,
): T[] {
  const merged = new Map(current.map((item) => [item[key], item]));
  for (const item of additions) merged.set(item[key], item);
  return [...merged.values()];
}
