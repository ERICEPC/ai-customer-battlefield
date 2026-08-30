"use client";

import type {
  CreateFollowupDraftRequest,
  FollowupDraftResponse,
} from "@battlefield/contracts";
import type { FormEvent } from "react";
import { useState } from "react";

import { createFollowupDraft as createFollowupDraftViaApi } from "./api-client";

type CreateDraft = (
  request: CreateFollowupDraftRequest,
) => Promise<FollowupDraftResponse>;

interface FollowupDraftFormProps {
  createDraft?: CreateDraft;
  entityId?: string;
}

export function FollowupDraftForm({
  createDraft = createFollowupDraftViaApi,
  entityId = process.env.NEXT_PUBLIC_DEV_ENTITY_ID ??
    "50000000-0000-4000-8000-000000000001",
}: FollowupDraftFormProps) {
  const [rawInput, setRawInput] = useState("");
  const [draft, setDraft] = useState<FollowupDraftResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasError, setHasError] = useState(false);
  const canSubmit = rawInput.trim().length > 0 && !isSubmitting;

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    setIsSubmitting(true);
    setHasError(false);
    try {
      const nextDraft = await createDraft({
        entityId,
        rawInput: rawInput.trim(),
      });
      setDraft(nextDraft);
    } catch {
      setHasError(true);
    } finally {
      setIsSubmitting(false);
    }
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

        <label className="field-label" htmlFor="followup-input">
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
          <button type="submit" disabled={!canSubmit}>
            {isSubmitting ? "正在生成…" : "生成跟进草稿"}
          </button>
        </div>

        {hasError ? (
          <div className="error-message" role="alert">
            生成失败，请稍后重试。你的输入已保留。
          </div>
        ) : null}
      </form>

      <section
        className="result-region"
        aria-live="polite"
        aria-label="AI 草稿结果"
      >
        {draft ? (
          <article className="result-card">
            <div className="result-accent" />
            <div className="result-content">
              <div className="card-heading">
                <div>
                  <p className="eyebrow">结构化建议</p>
                  <h2>跟进摘要</h2>
                </div>
                <span className="pending-badge">待确认</span>
              </div>
              <p className="summary-text">{draft.candidate.summary}</p>
              <div className="result-meta">
                <span>AI 生成</span>
                <span aria-hidden="true">·</span>
                <span>尚未形成正式业务事实</span>
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
