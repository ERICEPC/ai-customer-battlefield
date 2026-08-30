"use client";

import type {
  BusinessEntityPage,
  ConfirmFollowupDraftRequest,
  CreateFollowupDraftRequest,
  FollowupConfirmationResponse,
  FollowupDraftCandidate,
  FollowupDraftResponse,
  FormalFollowupRecord,
  ReviseFollowupDraftRequest,
} from "@battlefield/contracts";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { listBusinessEntities } from "../business-entities/api-client";
import {
  cancelFollowupDraft,
  confirmFollowupDraft,
  createFollowupDraft,
  FollowupApiError,
  getFollowupDraft,
  getFormalFollowup,
  reviseFollowupDraft,
} from "./api-client";

export interface FollowupWorkbenchApi {
  listEntities(): Promise<BusinessEntityPage>;
  createDraft(
    request: CreateFollowupDraftRequest,
  ): Promise<FollowupDraftResponse>;
  getDraft(draftId: string): Promise<FollowupDraftResponse>;
  getFormalFollowup(followupId: string): Promise<FormalFollowupRecord>;
  reviseDraft(
    draftId: string,
    request: ReviseFollowupDraftRequest,
  ): Promise<FollowupDraftResponse>;
  cancelDraft(
    draftId: string,
    request: ConfirmFollowupDraftRequest,
    idempotencyKey: string,
  ): Promise<FollowupDraftResponse>;
  confirmDraft(
    draftId: string,
    request: ConfirmFollowupDraftRequest,
    idempotencyKey: string,
  ): Promise<FollowupConfirmationResponse>;
}

const defaultApi: FollowupWorkbenchApi = {
  listEntities: () => listBusinessEntities({ status: "active", limit: 100 }),
  createDraft: createFollowupDraft,
  getDraft: getFollowupDraft,
  getFormalFollowup,
  reviseDraft: reviseFollowupDraft,
  cancelDraft: cancelFollowupDraft,
  confirmDraft: confirmFollowupDraft,
};

type Operation = "creating" | "confirming" | "cancelling" | "reloading";

export function FollowupDraftForm({
  api = defaultApi,
}: {
  api?: FollowupWorkbenchApi;
}) {
  const [entities, setEntities] = useState<BusinessEntityPage["items"]>([]);
  const [entityLoadState, setEntityLoadState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [entityId, setEntityId] = useState("");
  const [rawInput, setRawInput] = useState("");
  const [draft, setDraft] = useState<FollowupDraftResponse | null>(null);
  const [candidate, setCandidate] = useState<FollowupDraftCandidate | null>(
    null,
  );
  const [confirmation, setConfirmation] =
    useState<FollowupConfirmationResponse | null>(null);
  const [formalFollowup, setFormalFollowup] =
    useState<FormalFollowupRecord | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const confirmKey = useRef<string | null>(null);
  const cancelKey = useRef<string | null>(null);

  const loadEntities = useCallback(async (): Promise<void> => {
    setEntityLoadState("loading");
    try {
      const page = await api.listEntities();
      setEntities(page.items);
      setEntityLoadState("ready");
    } catch {
      setEntityLoadState("error");
    }
  }, [api]);

  useEffect(() => {
    void loadEntities();
  }, [loadEntities]);

  const canCreate =
    entityLoadState === "ready" &&
    entityId.length > 0 &&
    rawInput.trim().length > 0 &&
    operation === null;
  const candidateIsValid =
    candidate !== null &&
    candidate.summary.trim().length > 0 &&
    candidate.facts.every(
      (fact) =>
        /^[a-z][a-z0-9_.-]{0,99}$/.test(fact.factType.trim()) &&
        fact.factValue.trim().length > 0,
    );
  const canConfirm =
    draft?.status === "pending_confirmation" &&
    acknowledged &&
    candidateIsValid &&
    operation === null;

  function clearOperationError(): void {
    setErrorMessage(null);
    setHasConflict(false);
  }

  function handleOperationError(error: unknown): void {
    if (
      error instanceof FollowupApiError &&
      error.code === "DRAFT_VERSION_CONFLICT"
    ) {
      setHasConflict(true);
      setErrorMessage("草稿已被其他操作更新，请重新加载后核对。");
      return;
    }
    setErrorMessage(
      error instanceof Error ? error.message : "操作失败，请稍后重试。",
    );
  }

  function updateCandidate(patch: Partial<FollowupDraftCandidate>): void {
    setCandidate((current) => (current ? { ...current, ...patch } : current));
    setAcknowledged(false);
    confirmKey.current = null;
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!canCreate) return;

    setOperation("creating");
    clearOperationError();
    setConfirmation(null);
    setFormalFollowup(null);
    try {
      const nextDraft = await api.createDraft({
        entityId,
        rawInput: rawInput.trim(),
      });
      setDraft(nextDraft);
      setCandidate(cloneCandidate(nextDraft.candidate));
      setAcknowledged(false);
      confirmKey.current = null;
      cancelKey.current = null;
    } catch {
      setErrorMessage("生成失败，请稍后重试。你的输入已保留。");
    } finally {
      setOperation(null);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!(canConfirm && draft && candidate)) return;

    setOperation("confirming");
    clearOperationError();
    try {
      let currentDraft = draft;
      if (!sameCandidate(candidate, draft.candidate)) {
        currentDraft = await api.reviseDraft(draft.draftId, {
          versionNo: draft.versionNo,
          candidate: normalizedCandidate(candidate),
        });
        setDraft(currentDraft);
        setCandidate(cloneCandidate(currentDraft.candidate));
      }
      const nextConfirmation = await api.confirmDraft(
        currentDraft.draftId,
        { versionNo: currentDraft.versionNo },
        stableClientId(confirmKey, "confirm"),
      );
      setConfirmation(nextConfirmation);
      try {
        setFormalFollowup(
          await api.getFormalFollowup(nextConfirmation.followupId),
        );
      } catch {
        // The formal write already succeeded. Keep the receipt recoverable even
        // if its optional details cannot be hydrated on the first attempt.
      }
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperation(null);
    }
  }

  async function handleCancel(): Promise<void> {
    if (!(draft && draft.status === "pending_confirmation" && !operation))
      return;

    setOperation("cancelling");
    clearOperationError();
    try {
      const cancelled = await api.cancelDraft(
        draft.draftId,
        { versionNo: draft.versionNo },
        stableClientId(cancelKey, "cancel"),
      );
      setDraft(cancelled);
      setCandidate(cloneCandidate(cancelled.candidate));
    } catch (error) {
      handleOperationError(error);
    } finally {
      setOperation(null);
    }
  }

  async function handleReloadDraft(): Promise<void> {
    if (!draft) return;

    setOperation("reloading");
    clearOperationError();
    try {
      const latest = await api.getDraft(draft.draftId);
      setDraft(latest);
      setCandidate(cloneCandidate(latest.candidate));
      setAcknowledged(false);
      confirmKey.current = null;
      cancelKey.current = null;
    } catch {
      setErrorMessage("草稿重新加载失败，请稍后重试。");
    } finally {
      setOperation(null);
    }
  }

  function updateFact(
    index: number,
    field: "factType" | "factValue",
    value: string,
  ): void {
    if (!candidate) return;
    updateCandidate({
      facts: candidate.facts.map((fact, factIndex) =>
        factIndex === index ? { ...fact, [field]: value } : fact,
      ),
    });
  }

  return (
    <div className="followup-flow">
      <form className="input-card" onSubmit={handleSubmit}>
        <div className="card-heading">
          <div>
            <p className="eyebrow">AI 跟进助手</p>
            <h2>记录客户最新进展</h2>
          </div>
          <span className="draft-badge">草稿模式</span>
        </div>
        <p className="card-description">
          写下本次沟通的关键信息。系统只生成结构化建议，确认前不会写入正式经营记录。
        </p>

        <label className="field-label" htmlFor="followup-entity">
          经营对象
        </label>
        {entityLoadState === "loading" ? (
          <div className="entity-loader" role="status">
            正在加载经营对象…
          </div>
        ) : null}
        {entityLoadState === "error" ? (
          <div className="error-message" role="alert">
            经营对象加载失败。
            <button
              className="inline-button"
              type="button"
              onClick={() => void loadEntities()}
            >
              重新加载经营对象
            </button>
          </div>
        ) : null}
        <select
          id="followup-entity"
          value={entityId}
          disabled={entityLoadState !== "ready" || operation !== null}
          onChange={(event) => setEntityId(event.currentTarget.value)}
        >
          <option value="">请选择客户或经营对象</option>
          {entities.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.name}
            </option>
          ))}
        </select>

        <label className="field-label source-label" htmlFor="followup-input">
          本次客户跟进
        </label>
        <textarea
          id="followup-input"
          value={rawInput}
          onChange={(event) => setRawInput(event.currentTarget.value)}
          placeholder="例如：客户已确认预算范围，希望下周三前收到解决方案与实施排期……"
          rows={7}
          maxLength={10_000}
        />

        <div className="form-footer">
          <span className="input-hint">
            支持自然语言，建议包含进展、风险和下一步
          </span>
          <button type="submit" disabled={!canCreate}>
            {operation === "creating" ? "正在生成…" : "生成跟进草稿"}
          </button>
        </div>
        {errorMessage && !hasConflict ? (
          <div className="error-message" role="alert">
            {errorMessage}
          </div>
        ) : null}
      </form>

      <section
        className="result-region"
        aria-live="polite"
        aria-label="AI 草稿结果"
      >
        {confirmation ? (
          <ConfirmationReceipt
            confirmation={confirmation}
            formalFollowup={formalFollowup}
          />
        ) : draft?.status === "cancelled" ? (
          <TerminalDraft />
        ) : draft && candidate ? (
          <article className="result-card confirmation-editor">
            <div className="result-accent" />
            <div className="result-content">
              <div className="card-heading">
                <div>
                  <p className="eyebrow">人工确认区</p>
                  <h2>核对后写入正式跟进</h2>
                </div>
                <span className="pending-badge">版本 {draft.versionNo}</span>
              </div>

              <label className="field-label" htmlFor="confirmed-summary">
                确认摘要
              </label>
              <textarea
                id="confirmed-summary"
                className="summary-editor"
                value={candidate.summary}
                rows={4}
                maxLength={5_000}
                onChange={(event) =>
                  updateCandidate({ summary: event.currentTarget.value })
                }
              />

              <div className="editor-grid">
                <label>
                  <span className="field-label">跟进方式</span>
                  <select
                    value={candidate.followupType}
                    onChange={(event) =>
                      updateCandidate({
                        followupType: event.currentTarget
                          .value as FollowupDraftCandidate["followupType"],
                      })
                    }
                  >
                    <option value="meeting">会议</option>
                    <option value="call">电话</option>
                    <option value="message">即时消息</option>
                    <option value="email">邮件</option>
                    <option value="other">其他</option>
                  </select>
                </label>
                <label>
                  <span className="field-label">发生时间</span>
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(candidate.occurredAt)}
                    onChange={(event) => {
                      const occurredAt = toIsoDateTime(
                        event.currentTarget.value,
                      );
                      if (occurredAt) updateCandidate({ occurredAt });
                    }}
                  />
                </label>
              </div>

              <div className="fact-heading">
                <div>
                  <span className="field-label">经营事实</span>
                  <p>仅把已核实的信息写成事实；建议动作不在此处确认。</p>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    updateCandidate({
                      facts: [
                        ...candidate.facts,
                        { factType: "note", factValue: "" },
                      ],
                    })
                  }
                >
                  添加经营事实
                </button>
              </div>

              <div className="fact-list">
                {candidate.facts.map((fact, index) => (
                  // Contract facts are ordered value objects without identifiers.
                  // biome-ignore lint/suspicious/noArrayIndexKey: removal is index-based by contract.
                  <div className="fact-row" key={`${index}-${draft.draftId}`}>
                    <label>
                      <span className="field-label">事实类型 {index + 1}</span>
                      <input
                        value={fact.factType}
                        placeholder="例如 budget_status"
                        onChange={(event) =>
                          updateFact(
                            index,
                            "factType",
                            event.currentTarget.value,
                          )
                        }
                      />
                    </label>
                    <label>
                      <span className="field-label">事实内容 {index + 1}</span>
                      <input
                        value={fact.factValue}
                        placeholder="填写已经确认的事实"
                        onChange={(event) =>
                          updateFact(
                            index,
                            "factValue",
                            event.currentTarget.value,
                          )
                        }
                      />
                    </label>
                    <button
                      className="text-button danger-button"
                      type="button"
                      aria-label={`删除经营事实 ${index + 1}`}
                      onClick={() =>
                        updateCandidate({
                          facts: candidate.facts.filter(
                            (_, factIndex) => factIndex !== index,
                          ),
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>

              {hasConflict && errorMessage ? (
                <div className="error-message conflict-panel" role="alert">
                  <span>{errorMessage}</span>
                  <button
                    className="inline-button"
                    type="button"
                    disabled={operation === "reloading"}
                    onClick={() => void handleReloadDraft()}
                  >
                    {operation === "reloading" ? "正在加载…" : "重新加载草稿"}
                  </button>
                </div>
              ) : null}

              <label className="acknowledgement">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) =>
                    setAcknowledged(event.currentTarget.checked)
                  }
                />
                <span>我已核对以上内容</span>
              </label>
              <p className="boundary-note">
                本次确认只写入跟进事实。风险、提醒和建议动作仍需单独确认。
              </p>

              <div className="confirmation-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={operation !== null}
                  onClick={() => void handleCancel()}
                >
                  {operation === "cancelling" ? "正在取消…" : "取消草稿"}
                </button>
                <button
                  type="button"
                  disabled={!canConfirm}
                  onClick={() => void handleConfirm()}
                >
                  {operation === "confirming"
                    ? "正在写入…"
                    : "确认并写入正式跟进"}
                </button>
              </div>
            </div>
          </article>
        ) : (
          <div className="empty-result">
            <div className="empty-icon" aria-hidden="true">
              ✦
            </div>
            <h2>等待生成草稿</h2>
            <p>提交跟进信息后，结构化摘要会在这里出现。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ConfirmationReceipt({
  confirmation,
  formalFollowup,
}: {
  confirmation: FollowupConfirmationResponse;
  formalFollowup: FormalFollowupRecord | null;
}) {
  return (
    <article className="result-card confirmation-receipt">
      <div className="result-accent" />
      <div className="result-content">
        <p className="eyebrow">人工确认完成</p>
        <h2>已写入正式跟进</h2>
        <p>正式跟进编号</p>
        <code>{confirmation.followupId}</code>
        <dl className="receipt-details">
          <div>
            <dt>确认人</dt>
            <dd>{formalFollowup?.confirmedBy ?? "当前登录销售"}</dd>
          </div>
          <div>
            <dt>来源草稿</dt>
            <dd>{formalFollowup?.sourceDraftId ?? confirmation.draftId}</dd>
          </div>
        </dl>
        <p className="boundary-note">
          经营事实已留痕；风险、提醒和建议动作仍需单独确认。
        </p>
      </div>
    </article>
  );
}

function TerminalDraft() {
  return (
    <div className="empty-result terminal-draft">
      <div className="empty-icon" aria-hidden="true">
        ✓
      </div>
      <h2>草稿已取消</h2>
      <p>未写入任何正式经营事实。</p>
    </div>
  );
}

function cloneCandidate(
  candidate: FollowupDraftCandidate,
): FollowupDraftCandidate {
  return {
    ...candidate,
    relatedOpportunityIds: [...candidate.relatedOpportunityIds],
    facts: candidate.facts.map((fact) => ({ ...fact })),
  };
}

function normalizedCandidate(
  candidate: FollowupDraftCandidate,
): FollowupDraftCandidate {
  return {
    ...cloneCandidate(candidate),
    summary: candidate.summary.trim(),
    facts: candidate.facts.map((fact) => ({
      factType: fact.factType.trim(),
      factValue: fact.factValue.trim(),
    })),
  };
}

function sameCandidate(
  left: FollowupDraftCandidate,
  right: FollowupDraftCandidate,
): boolean {
  return JSON.stringify(normalizedCandidate(left)) === JSON.stringify(right);
}

function stableClientId(
  reference: { current: string | null },
  prefix: "confirm" | "cancel",
): string {
  if (!reference.current) {
    const suffix =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    reference.current = `${prefix}-${suffix}`;
  }
  return reference.current;
}

function toLocalDateTime(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  const timezoneOffset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - timezoneOffset).toISOString().slice(0, 16);
}

function toIsoDateTime(localDateTime: string): string | null {
  const date = new Date(localDateTime);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
