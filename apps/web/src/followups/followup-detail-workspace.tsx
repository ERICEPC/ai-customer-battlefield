"use client";

import type { FormalFollowupRecord } from "@battlefield/contracts";
import { useEffect, useState } from "react";

import { getFormalFollowup } from "../followup-drafts/api-client";

export type FollowupDetailRequest = (
  followupId: string,
) => Promise<FormalFollowupRecord>;

export function FollowupDetailWorkspace({
  followupId,
  request = getFormalFollowup,
}: {
  followupId: string;
  request?: FollowupDetailRequest;
}) {
  const [record, setRecord] = useState<FormalFollowupRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadVersion intentionally retries the same formal record.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(false);
    request(followupId)
      .then((value) => {
        if (current) setRecord(value);
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [followupId, reloadVersion, request]);

  if (loading) {
    return (
      <section className="followup-detail-state" role="status">
        正在读取正式跟进…
      </section>
    );
  }
  if (error || !record) {
    return (
      <section className="followup-detail-state error" role="alert">
        <strong>正式跟进读取失败</strong>
        <p>记录可能不存在，或当前身份没有查看权限。</p>
        <button
          type="button"
          onClick={() => setReloadVersion((value) => value + 1)}
        >
          重新读取
        </button>
      </section>
    );
  }

  return (
    <article className="followup-detail-card">
      <header className="followup-detail-heading">
        <div>
          <p className="eyebrow">CONFIRMED FOLLOW-UP</p>
          <h2>正式跟进详情</h2>
          <p>{record.summary}</p>
        </div>
        <span>{followupTypeLabel[record.followupType]}</span>
      </header>

      <dl className="followup-detail-metadata">
        <div>
          <dt>发生时间</dt>
          <dd>{formatDateTime(record.occurredAt)}</dd>
        </div>
        <div>
          <dt>确认时间</dt>
          <dd>{formatDateTime(record.confirmedAt)}</dd>
        </div>
        <div>
          <dt>正式记录编号</dt>
          <dd>
            <code>{record.followupId}</code>
          </dd>
        </div>
        <div>
          <dt>来源草稿</dt>
          <dd>
            <code>{record.sourceDraftId}</code>
          </dd>
        </div>
      </dl>

      <section className="followup-fact-section">
        <div>
          <p className="eyebrow">CONFIRMED FACTS</p>
          <h3>本次确认的经营事实</h3>
        </div>
        {record.facts.length > 0 ? (
          <ul aria-label="本次确认的经营事实">
            {record.facts.map((fact) => (
              <li
                key={`${fact.factType}:${fact.factValue}:${fact.opportunityId ?? "entity"}`}
              >
                <code>{fact.factType}</code>
                <span>{fact.factValue}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="data-gap">本次跟进未拆出独立经营事实。</p>
        )}
      </section>

      <footer className="followup-detail-actions">
        <a href="/entities">返回经营对象表格</a>
        <a className="primary" href={`/battle-map?entityId=${record.entityId}`}>
          查看对应作战地图
        </a>
      </footer>
    </article>
  );
}

const followupTypeLabel: Record<FormalFollowupRecord["followupType"], string> =
  {
    meeting: "会议",
    call: "电话",
    message: "即时消息",
    email: "邮件",
    other: "其他",
  };

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}
