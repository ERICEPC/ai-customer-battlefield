"use client";

import type {
  GenerateWeeklyReportRequest,
  ReviewWeeklyReportRequest,
  WeeklyReportDetail,
  WeeklyReportEvidence,
  WeeklyReportListItem,
  WeeklyReportListQuery,
  WeeklyReportPage,
  WeeklyReportSectionKind,
  WeeklyReportTransitionRequest,
} from "@battlefield/contracts";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  generateWeeklyReport,
  getWeeklyReport,
  listWeeklyReports,
  publishWeeklyReport,
  reviewWeeklyReport,
  reviseWeeklyReport,
  WeeklyReportApiError,
} from "./api-client";

export interface WeeklyReportWorkspaceApi {
  list(input: WeeklyReportListQuery): Promise<WeeklyReportPage>;
  get(versionId: string): Promise<WeeklyReportDetail>;
  generate(
    input: GenerateWeeklyReportRequest,
    idempotencyKey: string,
  ): Promise<WeeklyReportDetail>;
  review(
    versionId: string,
    input: ReviewWeeklyReportRequest,
  ): Promise<WeeklyReportDetail>;
  publish(
    versionId: string,
    input: WeeklyReportTransitionRequest,
    idempotencyKey: string,
  ): Promise<WeeklyReportDetail>;
  revise(
    versionId: string,
    input: WeeklyReportTransitionRequest,
    idempotencyKey: string,
  ): Promise<WeeklyReportDetail>;
}

const defaultApi: WeeklyReportWorkspaceApi = {
  list: listWeeklyReports,
  get: getWeeklyReport,
  generate: generateWeeklyReport,
  review: reviewWeeklyReport,
  publish: publishWeeklyReport,
  revise: reviseWeeklyReport,
};

type Operation = "generate" | "review" | "publish" | "revise" | null;

export function WeeklyReportWorkspace({
  api = defaultApi,
  initialVersionId,
  now = () => new Date(),
  idempotencyKeyFactory = defaultIdempotencyKey,
}: {
  api?: WeeklyReportWorkspaceApi;
  initialVersionId?: string;
  now?: () => Date;
  idempotencyKeyFactory?: () => string;
}) {
  const initialPeriod = useRef(thisWeekDates(now()));
  const [reportType, setReportType] =
    useState<GenerateWeeklyReportRequest["reportType"]>("personal");
  const [startDate, setStartDate] = useState(initialPeriod.current.start);
  const [endDate, setEndDate] = useState(initialPeriod.current.end);
  const [history, setHistory] = useState<WeeklyReportListItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState(
    initialVersionId ?? "",
  );
  const [detail, setDetail] = useState<WeeklyReportDetail | null>(null);
  const [note, setNote] = useState("");
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historySlow, setHistorySlow] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyReload, setHistoryReload] = useState(0);
  const [detailLoading, setDetailLoading] = useState(Boolean(initialVersionId));
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [operation, setOperation] = useState<Operation>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const historyRequestVersion = useRef(0);
  const detailRequestVersion = useRef(0);
  const hydratedSelection = useRef("");
  const operationInFlight = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: historyReload intentionally triggers recovery.
  useEffect(() => {
    const version = historyRequestVersion.current + 1;
    historyRequestVersion.current = version;
    setHistoryLoading(true);
    setHistorySlow(false);
    setHistoryError(null);
    const timer = window.setTimeout(() => {
      if (historyRequestVersion.current === version) setHistorySlow(true);
    }, 2_000);
    api
      .list({ limit: 50 })
      .then((page) => {
        if (historyRequestVersion.current !== version) return;
        setHistory(page.items);
        setHistoryCursor(page.nextCursor);
        setSelectedVersionId(
          (current) => current || page.items[0]?.versionId || "",
        );
      })
      .catch((error: unknown) => {
        if (historyRequestVersion.current !== version) return;
        setHistory([]);
        setHistoryCursor(null);
        setHistoryError(errorMessage(error, "周报历史读取失败，请重试。"));
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (historyRequestVersion.current === version) {
          setHistoryLoading(false);
          setHistorySlow(false);
        }
      });
    return () => window.clearTimeout(timer);
  }, [api, historyReload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: detailReload intentionally triggers conflict recovery.
  useEffect(() => {
    if (!selectedVersionId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    if (hydratedSelection.current === selectedVersionId) {
      hydratedSelection.current = "";
      setDetailLoading(false);
      return;
    }
    const version = detailRequestVersion.current + 1;
    detailRequestVersion.current = version;
    setDetailLoading(true);
    setDetailError(null);
    setOperationError(null);
    setOperationMessage(null);
    setNeedsReload(false);
    api
      .get(selectedVersionId)
      .then((report) => {
        if (detailRequestVersion.current !== version) return;
        applyDetail(report, setDetail, setNote, setIncluded);
      })
      .catch((error: unknown) => {
        if (detailRequestVersion.current !== version) return;
        setDetail(null);
        setDetailError(errorMessage(error, "周报版本读取失败，请重试。"));
      })
      .finally(() => {
        if (detailRequestVersion.current === version) setDetailLoading(false);
      });
  }, [api, selectedVersionId, detailReload]);

  async function loadMoreHistory(): Promise<void> {
    if (!historyCursor || historyLoadingMore) return;
    setHistoryLoadingMore(true);
    setHistoryError(null);
    try {
      const page = await api.list({ cursor: historyCursor, limit: 50 });
      setHistory((current) => mergeHistory(current, page.items));
      setHistoryCursor(page.nextCursor);
    } catch (error) {
      setHistoryError(errorMessage(error, "更多周报读取失败，请重试。"));
    } finally {
      setHistoryLoadingMore(false);
    }
  }

  async function generate(event: FormEvent): Promise<void> {
    event.preventDefault();
    const request = generationRequest(reportType, startDate, endDate, now());
    if (typeof request === "string") {
      setOperationError(request);
      return;
    }
    await runOperation("generate", async () => {
      const report = await api.generate(request, idempotencyKeyFactory());
      showReport(report, "周报已生成，等待人工审阅。", true);
    });
  }

  async function saveReview(): Promise<void> {
    if (!detail) return;
    await runOperation("review", async () => {
      const report = await api.review(detail.versionId, {
        lockVersion: detail.lockVersion,
        note,
        items: detail.sections.flatMap((section) =>
          section.items.map((item) => ({
            itemId: item.itemId,
            included: included[item.itemId] ?? item.included,
          })),
        ),
      });
      showReport(report, "审阅已保存", true);
    });
  }

  async function publish(): Promise<void> {
    if (!detail) return;
    await runOperation("publish", async () => {
      const report = await api.publish(
        detail.versionId,
        { lockVersion: detail.lockVersion },
        idempotencyKeyFactory(),
      );
      showReport(report, "发布完成 · 通知独立投递", true);
    });
  }

  async function revise(): Promise<void> {
    if (!detail) return;
    await runOperation("revise", async () => {
      const report = await api.revise(
        detail.versionId,
        { lockVersion: detail.lockVersion },
        idempotencyKeyFactory(),
      );
      showReport(report, "修订版已创建，原发布版本保持不变。", true);
    });
  }

  async function runOperation(
    kind: Exclude<Operation, null>,
    execute: () => Promise<void>,
  ): Promise<void> {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setOperation(kind);
    setOperationError(null);
    setOperationMessage(null);
    setNeedsReload(false);
    try {
      await execute();
    } catch (error) {
      const conflict = isReportConflict(error);
      setNeedsReload(conflict);
      setOperationError(
        conflict
          ? "版本已变化，请重新载入后再审阅或发布。"
          : errorMessage(error, "周报操作失败，请重试。"),
      );
    } finally {
      operationInFlight.current = false;
      setOperation(null);
    }
  }

  function showReport(
    report: WeeklyReportDetail,
    message: string,
    updateHistory: boolean,
  ): void {
    applyDetail(report, setDetail, setNote, setIncluded);
    if (report.versionId !== selectedVersionId) {
      hydratedSelection.current = report.versionId;
      setSelectedVersionId(report.versionId);
    }
    if (updateHistory) {
      setHistory((current) => mergeHistory([toHistoryItem(report)], current));
    }
    setOperationMessage(message);
  }

  if (historyLoading) {
    return (
      <section className="report-loading" role="status" aria-live="polite">
        <span className="loading-mark" aria-hidden="true" />
        <h1>正在读取周报中心…</h1>
        <p>
          {historySlow
            ? "仍在读取周报历史与当前权限，请稍候…"
            : "正在核对你可查看的版本。"}
        </p>
      </section>
    );
  }

  if (historyError && history.length === 0) {
    return (
      <section className="report-state report-error" role="alert">
        <span aria-hidden="true">!</span>
        <h1>周报中心暂不可用</h1>
        <p>{historyError}</p>
        <button
          type="button"
          onClick={() => setHistoryReload((value) => value + 1)}
        >
          重新加载周报
        </button>
      </section>
    );
  }

  return (
    <div className="weekly-report-workspace">
      <ReportComposer
        reportType={reportType}
        startDate={startDate}
        endDate={endDate}
        busy={operation === "generate"}
        onType={setReportType}
        onStart={setStartDate}
        onEnd={setEndDate}
        onSubmit={generate}
      />

      <div className="report-layout">
        <aside className="report-history" aria-label="周报历史">
          <div className="report-panel-heading">
            <div>
              <p className="eyebrow">VERSION HISTORY</p>
              <h2>版本记录</h2>
            </div>
            <span>{history.length}</span>
          </div>
          {history.length === 0 ? (
            <div className="report-history-empty">
              <strong>还没有周报版本</strong>
              <p>选择明确周期生成第一份可审阅快照。</p>
            </div>
          ) : (
            <ol>
              {history.map((item) => (
                <li className="report-history-item" key={item.versionId}>
                  <button
                    type="button"
                    className={
                      item.versionId === selectedVersionId
                        ? "active"
                        : undefined
                    }
                    aria-pressed={item.versionId === selectedVersionId}
                    onClick={() => setSelectedVersionId(item.versionId)}
                  >
                    <span>
                      {reportTypeLabel(item.reportType)} · 第{item.revisionNo}版
                    </span>
                    <strong>{formatPeriod(item.period)}</strong>
                    <small className="report-history-meta">
                      {statusLabel(item.status)} · {item.entityCount} 个对象
                    </small>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {historyCursor ? (
            <button
              type="button"
              className="secondary-button report-load-more"
              disabled={historyLoadingMore}
              onClick={() => void loadMoreHistory()}
            >
              {historyLoadingMore ? "正在加载…" : "加载更早版本"}
            </button>
          ) : null}
        </aside>

        <section className="report-detail-column" aria-label="周报版本详情">
          {historyError ? (
            <div className="report-inline-error" role="alert">
              {historyError}
            </div>
          ) : null}
          {detailLoading ? (
            <div className="report-detail-state" role="status">
              <span className="loading-mark" aria-hidden="true" />
              正在读取版本快照…
            </div>
          ) : null}
          {detailError ? (
            <div className="report-inline-error" role="alert">
              <span>{detailError}</span>
              <button
                type="button"
                onClick={() => setDetailReload((value) => value + 1)}
              >
                重试读取
              </button>
            </div>
          ) : null}
          {!detailLoading && !detailError && detail ? (
            <ReportDetail
              report={detail}
              note={note}
              included={included}
              operation={operation}
              operationError={operationError}
              operationMessage={operationMessage}
              needsReload={needsReload}
              onNote={setNote}
              onIncluded={(itemId, value) =>
                setIncluded((current) => ({ ...current, [itemId]: value }))
              }
              onSave={() => void saveReview()}
              onPublish={() => void publish()}
              onRevise={() => void revise()}
              onReload={() => setDetailReload((value) => value + 1)}
            />
          ) : null}
          {!detailLoading && !detailError && !detail ? (
            <div className="report-detail-state empty">
              <span aria-hidden="true">◇</span>
              <strong>选择历史版本，或生成新的周报</strong>
              <p>快照生成后才能审阅、发布与保留修订历史。</p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ReportComposer(props: {
  reportType: GenerateWeeklyReportRequest["reportType"];
  startDate: string;
  endDate: string;
  busy: boolean;
  onType: (value: GenerateWeeklyReportRequest["reportType"]) => void;
  onStart: (value: string) => void;
  onEnd: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <section className="report-composer" aria-label="生成周报">
      <div className="report-composer-copy">
        <p className="eyebrow">NEW SNAPSHOT</p>
        <h2>生成一份可核验周报</h2>
        <p className="report-composer-scope">
          {props.reportType === "personal"
            ? "只汇总本人当前负责或协作的经营对象。"
            : "仅汇总当前管理关注范围，不代表未确认的组织或全团队。"}
        </p>
      </div>
      <form onSubmit={props.onSubmit}>
        <label className="report-composer-type">
          周报类型
          <select
            aria-label="周报类型"
            value={props.reportType}
            disabled={props.busy}
            onChange={(event) =>
              props.onType(
                event.currentTarget
                  .value as GenerateWeeklyReportRequest["reportType"],
              )
            }
          >
            <option value="personal">个人周报</option>
            <option value="managed_portfolio">管理范围周报</option>
          </select>
        </label>
        <label>
          开始日期
          <input
            aria-label="开始日期"
            type="date"
            value={props.startDate}
            disabled={props.busy}
            onChange={(event) => props.onStart(event.currentTarget.value)}
          />
        </label>
        <label>
          结束日期（不含）
          <input
            aria-label="结束日期（不含）"
            type="date"
            value={props.endDate}
            disabled={props.busy}
            onChange={(event) => props.onEnd(event.currentTarget.value)}
          />
        </label>
        <button type="submit" disabled={props.busy}>
          {props.busy ? "正在生成…" : "生成周报"}
        </button>
      </form>
    </section>
  );
}

function ReportDetail(props: {
  report: WeeklyReportDetail;
  note: string;
  included: Record<string, boolean>;
  operation: Operation;
  operationError: string | null;
  operationMessage: string | null;
  needsReload: boolean;
  onNote: (value: string) => void;
  onIncluded: (itemId: string, included: boolean) => void;
  onSave: () => void;
  onPublish: () => void;
  onRevise: () => void;
  onReload: () => void;
}) {
  const { report } = props;
  const busy = props.operation !== null;
  return (
    <section
      className="report-detail"
      aria-label={`${reportTypeLabel(report.reportType)} 第${report.revisionNo}版`}
    >
      <header className="report-detail-heading">
        <div>
          <div className="report-title-line">
            <span className={`report-status status-${report.status}`}>
              {statusLabel(report.status)}
            </span>
            <span>第 {report.revisionNo} 版</span>
          </div>
          <h2>{report.title}</h2>
          <p>
            {report.scope.label} · {report.scope.entityCount} 个对象
          </p>
        </div>
        <div className="report-version-meta">
          <span>数据截止</span>
          <time dateTime={report.dataCutoffAt}>
            {formatDateTime(report.dataCutoffAt)}
          </time>
          <small>确定性生成 · {report.generator.version}</small>
        </div>
      </header>

      <ReportMetrics report={report} />

      <div className="report-section-grid">
        {report.sections.map((section) => (
          <section
            className={`report-section section-${section.kind}`}
            aria-label={sectionLabel(section.kind)}
            key={section.kind}
          >
            <div className="report-section-heading">
              <div>
                <span aria-hidden="true">{sectionMark(section.kind)}</span>
                <h3>{sectionLabel(section.kind)}</h3>
              </div>
              <small>{section.items.length} 项</small>
            </div>
            {section.items.length === 0 ? (
              <div className="report-section-empty">
                本周期没有该类正式记录。
              </div>
            ) : (
              <ol className="report-section-list">
                {section.items.map((item) => {
                  const itemIncluded =
                    props.included[item.itemId] ?? item.included;
                  return (
                    <li
                      className={itemIncluded ? undefined : "excluded"}
                      key={item.itemId}
                    >
                      <article>
                        <div className="report-item-heading">
                          <div>
                            <span
                              className={`report-severity severity-${item.severity}`}
                            >
                              {item.entityName}
                            </span>
                            <h4>{item.title}</h4>
                          </div>
                          {report.capabilities.canReview ? (
                            <label className="report-include-toggle">
                              <input
                                type="checkbox"
                                checked={itemIncluded}
                                aria-label={`${itemIncluded ? "不纳入" : "纳入"}：${item.title}`}
                                onChange={(event) =>
                                  props.onIncluded(
                                    item.itemId,
                                    event.currentTarget.checked,
                                  )
                                }
                              />
                              {itemIncluded ? "纳入" : "不纳入"}
                            </label>
                          ) : (
                            <span className="report-inclusion-state">
                              {itemIncluded ? "已纳入" : "未纳入"}
                            </span>
                          )}
                        </div>
                        <p>{item.summary}</p>
                        {item.contributors.length > 0 ? (
                          <div className="report-contributors">
                            {item.contributors.map((contributor) => (
                              <span key={contributor.userId}>
                                {contributor.displayName}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <EvidenceList evidence={item.evidence} />
                      </article>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        ))}
      </div>

      <section className="report-review" aria-label="人工审阅">
        <div>
          <p className="eyebrow">HUMAN REVIEW</p>
          <h3>
            {report.status === "published"
              ? "正式版本已冻结"
              : "人工审阅与发布"}
          </h3>
          <p>
            来源事实与证据不可改写；审阅者只能决定是否纳入项目，并补充整份周报备注。
          </p>
        </div>
        <label>
          审阅备注
          <textarea
            aria-label="审阅备注"
            value={props.note}
            maxLength={2_000}
            readOnly={!report.capabilities.canReview}
            onChange={(event) => props.onNote(event.currentTarget.value)}
          />
          <small className="report-note-count">
            {props.note.length} / 2000
          </small>
        </label>
        {props.operationError ? (
          <div className="report-inline-error" role="alert">
            <span>{props.operationError}</span>
            {props.needsReload ? (
              <button type="button" onClick={props.onReload}>
                重新载入当前版本
              </button>
            ) : null}
          </div>
        ) : null}
        {props.operationMessage ? (
          <div className="report-operation-success" role="status">
            {props.operationMessage}
          </div>
        ) : null}
        <div className="report-review-actions">
          {report.capabilities.canReview ? (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={props.onSave}
            >
              {props.operation === "review" ? "正在保存…" : "保存审阅"}
            </button>
          ) : null}
          {report.capabilities.canPublish ? (
            <button type="button" disabled={busy} onClick={props.onPublish}>
              {props.operation === "publish" ? "正在发布…" : "发布正式版本"}
            </button>
          ) : null}
          {report.capabilities.canRevise ? (
            <button type="button" disabled={busy} onClick={props.onRevise}>
              {props.operation === "revise" ? "正在创建…" : "创建修订版"}
            </button>
          ) : null}
        </div>
        {report.status === "published" ? (
          <p className="report-delivery-note">
            发布完成 · 通知独立投递；外部渠道失败不会回滚该版本。
          </p>
        ) : null}
      </section>
    </section>
  );
}

function ReportMetrics({ report }: { report: WeeklyReportDetail }) {
  const items = [
    ["确认跟进", report.metrics.confirmedFollowupCount],
    ["有效事实", report.metrics.validFactCount],
    ["阶段变化", report.metrics.stageChangeCount],
    ["完成动作", report.metrics.completedActionCount],
    ["开放动作", report.metrics.openActionCount],
    ["逾期动作", report.metrics.overdueActionCount],
  ] as const;
  return (
    <section className="report-metrics" aria-label="周报指标">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function EvidenceList({ evidence }: { evidence: WeeklyReportEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="report-evidence">
      {evidence.map((item) => (
        <li
          className="report-evidence-item"
          key={`${item.kind}:${item.evidenceId}`}
        >
          <span>{evidenceLabel(item.kind)}</span>
          <Link className="report-evidence-link" href={item.deepLink}>
            {item.label}
          </Link>
          <time dateTime={item.occurredAt}>
            {formatDateTime(item.occurredAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}

function applyDetail(
  report: WeeklyReportDetail,
  setDetail: (report: WeeklyReportDetail) => void,
  setNote: (note: string) => void,
  setIncluded: (included: Record<string, boolean>) => void,
): void {
  setDetail(report);
  setNote(report.note);
  setIncluded(
    Object.fromEntries(
      report.sections.flatMap((section) =>
        section.items.map((item) => [item.itemId, item.included]),
      ),
    ),
  );
}

function generationRequest(
  reportType: GenerateWeeklyReportRequest["reportType"],
  startDate: string,
  endDate: string,
  now: Date,
): GenerateWeeklyReportRequest | string {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end))
    return "请选择有效周期。";
  if (end <= start) return "结束日期必须晚于开始日期。";
  if (end - start > 31 * 24 * 60 * 60 * 1_000)
    return "周报周期不能超过 31 天。";
  if (!Number.isFinite(now.getTime()) || start > now.getTime())
    return "开始日期不能晚于当前时间。";
  return {
    reportType,
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
  return {
    start: monday.toISOString().slice(0, 10),
    end: new Date(monday.getTime() + 7 * 86_400_000).toISOString().slice(0, 10),
  };
}

function defaultIdempotencyKey(): string {
  return `weekly-report-${crypto.randomUUID()}`;
}

function isReportConflict(error: unknown): boolean {
  return (
    error instanceof WeeklyReportApiError &&
    error.status === 409 &&
    ["WEEKLY_REPORT_VERSION_CONFLICT", "WEEKLY_REPORT_SCOPE_CONFLICT"].includes(
      error.code,
    )
  );
}

function mergeHistory(
  primary: WeeklyReportListItem[],
  secondary: WeeklyReportListItem[],
): WeeklyReportListItem[] {
  const merged = new Map<string, WeeklyReportListItem>();
  for (const item of [...primary, ...secondary]) {
    if (!merged.has(item.versionId)) merged.set(item.versionId, item);
  }
  return [...merged.values()];
}

function toHistoryItem(report: WeeklyReportDetail): WeeklyReportListItem {
  return {
    reportId: report.reportId,
    versionId: report.versionId,
    reportType: report.reportType,
    revisionNo: report.revisionNo,
    status: report.status,
    title: report.title,
    period: report.period,
    dataCutoffAt: report.dataCutoffAt,
    entityCount: report.scope.entityCount,
    createdAt: report.createdAt,
    publishedAt: report.publishedAt,
  };
}

function reportTypeLabel(type: WeeklyReportDetail["reportType"]): string {
  return type === "personal" ? "个人周报" : "管理范围周报";
}

function statusLabel(status: WeeklyReportDetail["status"]): string {
  return {
    draft: "草稿",
    in_review: "待审阅",
    published: "已发布",
    cancelled: "已取消",
  }[status];
}

function sectionLabel(kind: WeeklyReportSectionKind): string {
  return {
    progress: "本周进展",
    risk: "风险与阻塞",
    next_action: "下一步动作",
    data_gap: "数据缺口",
  }[kind];
}

function sectionMark(kind: WeeklyReportSectionKind): string {
  return { progress: "↗", risk: "!", next_action: "→", data_gap: "?" }[kind];
}

function evidenceLabel(kind: WeeklyReportEvidence["kind"]): string {
  return {
    followup: "确认跟进",
    fact: "有效事实",
    stage_change: "阶段变化",
    action: "正式动作",
    battle_state: "作战状态",
  }[kind];
}

function formatPeriod(period: WeeklyReportDetail["period"]): string {
  return `${period.start.slice(0, 10)} — ${period.end.slice(0, 10)}`;
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
