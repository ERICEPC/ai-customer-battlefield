"use client";

import type {
  BattleRuleSet,
  BattleRuleVersion,
  BattleRuleVersionPage,
  CreateBattleRuleVersionRequest,
  ReleasedBattleRule,
} from "@battlefield/contracts";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import {
  createBattleRuleVersion,
  listBattleRuleVersions,
  releaseBattleRuleVersion,
} from "./api-client";

export interface BattleRuleManagementApi {
  listVersions(): Promise<BattleRuleVersionPage>;
  createVersion(
    input: CreateBattleRuleVersionRequest,
  ): Promise<BattleRuleVersion>;
  releaseVersion(
    versionId: string,
    reason: string,
  ): Promise<ReleasedBattleRule>;
}

const defaultApi: BattleRuleManagementApi = {
  listVersions: listBattleRuleVersions,
  createVersion: createBattleRuleVersion,
  releaseVersion: releaseBattleRuleVersion,
};

export function BattleRuleManagementSection({
  api = defaultApi,
}: {
  api?: BattleRuleManagementApi;
}) {
  const [page, setPage] = useState<BattleRuleVersionPage | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftRules, setDraftRules] = useState<BattleRuleSet | null>(null);
  const [stageLabelsText, setStageLabelsText] = useState("");
  const [releaseVersionId, setReleaseVersionId] = useState("");
  const [releaseReason, setReleaseReason] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    void reloadToken;
    let active = true;
    setPage(null);
    setError(null);
    void api
      .listVersions()
      .then((loaded) => {
        if (!active) return;
        setPage(loaded);
        const baseline =
          loaded.items.find(
            (version) => version.versionId === loaded.currentVersionId,
          ) ?? loaded.items[0];
        if (baseline) {
          setDraftName(`${baseline.name} · 新版本`);
          setDraftRules(cloneRules(baseline.rules));
          setStageLabelsText(formatStageLabels(baseline.rules.stageLabels));
          setReleaseVersionId(baseline.versionId);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [api, reloadToken]);

  const currentVersion = useMemo(
    () =>
      page?.items.find(
        (version) => version.versionId === page.currentVersionId,
      ) ?? null,
    [page],
  );
  const selectedReleaseVersion = page?.items.find(
    (version) => version.versionId === releaseVersionId,
  );
  const releaseIsRollback = Boolean(
    currentVersion &&
      selectedReleaseVersion &&
      Number(selectedReleaseVersion.versionNo) <
        Number(currentVersion.versionNo),
  );

  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftRules || isCreating) return;
    setIsCreating(true);
    setError(null);
    setMessage(null);
    try {
      const created = await api.createVersion({
        name: draftName,
        rules: {
          ...draftRules,
          stageLabels: parseStageLabels(stageLabelsText),
        },
      });
      const loaded = await api.listVersions();
      setPage(loaded);
      setReleaseVersionId(created.versionId);
      setMessage(`规则 V${created.versionNo} 已创建，尚未影响新的作战分析。`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsCreating(false);
    }
  }

  async function releaseVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !page ||
      isReleasing ||
      !releaseVersionId ||
      releaseVersionId === page.currentVersionId ||
      !releaseReason.trim()
    ) {
      return;
    }
    setIsReleasing(true);
    setError(null);
    setMessage(null);
    try {
      const released = await api.releaseVersion(
        releaseVersionId,
        releaseReason,
      );
      setPage(await api.listVersions());
      setReleaseReason("");
      setMessage(
        `${releaseIsRollback ? "回滚" : "发布"}完成：${released.ruleVersion}，下一次分析开始生效。`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsReleasing(false);
    }
  }

  function updateScore(
    dimension: "relationshipScore" | "potentialScore",
    field: "base" | "perFact" | "maximum",
    value: string,
  ) {
    setDraftRules((current) =>
      current
        ? {
            ...current,
            [dimension]: {
              ...current[dimension],
              [field]: Number(value),
            },
          }
        : current,
    );
  }

  return (
    <section className="admin-section" aria-labelledby="battle-rules-title">
      <div className="admin-section-heading">
        <div>
          <span>BATTLE RULES</span>
          <h2 id="battle-rules-title">作战分析规则</h2>
        </div>
        <p>
          规则版本不可覆盖；发布或回滚只影响下一次分析，历史地图保留原回执。
        </p>
      </div>

      {message ? <p className="admin-message">{message}</p> : null}
      {error ? (
        <div className="admin-section-state admin-section-state-error">
          <div>
            <strong>作战规则暂不可用</strong>
            <p>{error}</p>
          </div>
          {!page ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => setReloadToken((current) => current + 1)}
            >
              重新读取
            </button>
          ) : null}
        </div>
      ) : null}

      {!page ? (
        error ? null : (
          <div className="admin-section-state" role="status">
            <span className="directory-spinner" aria-hidden="true" />
            <div>
              <strong>正在读取当前作战规则</strong>
              <p>其他系统管理区域可以继续使用。</p>
            </div>
          </div>
        )
      ) : (
        <>
          <div className="battle-rule-release-summary">
            <div>
              <span>当前运行回执</span>
              <strong>
                V{currentVersion?.versionNo ?? "-"} / R{page.currentReleaseNo}
              </strong>
            </div>
            <p>
              API 与 Worker
              都会在新分析开始时解析这个发布，并把版本写入分析记录。
            </p>
          </div>

          <div className="runtime-version-grid battle-rule-version-grid">
            {page.items.map((version) => (
              <article
                className={
                  version.versionId === page.currentVersionId
                    ? "runtime-version current"
                    : "runtime-version"
                }
                key={version.versionId}
              >
                <div>
                  <span>V{version.versionNo}</span>
                  {version.versionId === page.currentVersionId ? (
                    <strong>R{page.currentReleaseNo} 当前发布</strong>
                  ) : null}
                </div>
                <h3>{version.name}</h3>
                <p>
                  关系 {formatScore(version.rules.relationshipScore)} · 潜力{" "}
                  {formatScore(version.rules.potentialScore)}
                </p>
                <dl>
                  <div>
                    <dt>最低事实数</dt>
                    <dd>{version.rules.minimumFactCount}</dd>
                  </div>
                  <div>
                    <dt>象限</dt>
                    <dd>{version.rules.sufficientResult.quadrantCode}</dd>
                  </div>
                  <div>
                    <dt>信号强度</dt>
                    <dd>{version.rules.sufficientResult.signalStrength}</dd>
                  </div>
                </dl>
                <details>
                  <summary>查看阶段名称与建议动作</summary>
                  <div className="battle-rule-stage-list">
                    {Object.entries(version.rules.stageLabels).map(
                      ([code, label]) => (
                        <p key={code}>
                          <code>{code}</code>
                          <span>{label}</span>
                        </p>
                      ),
                    )}
                  </div>
                  <p className="battle-rule-action-copy">
                    <strong>{version.rules.actionProposal.title}</strong>
                    {version.rules.actionProposal.description}
                  </p>
                </details>
              </article>
            ))}
          </div>

          <div className="admin-form-grid battle-rule-form-grid">
            <form
              className="admin-card admin-release"
              onSubmit={releaseVersion}
            >
              <div>
                <span>发布控制</span>
                <h3>发布新版本或回滚</h3>
              </div>
              <label>
                待发布规则
                <select
                  aria-label="待发布作战规则"
                  value={releaseVersionId}
                  onChange={(event) => setReleaseVersionId(event.target.value)}
                >
                  {page.items.map((version) => (
                    <option value={version.versionId} key={version.versionId}>
                      V{version.versionNo} · {version.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                发布或回滚原因
                <input
                  aria-label="作战规则发布原因"
                  value={releaseReason}
                  onChange={(event) => setReleaseReason(event.target.value)}
                  placeholder="例如：评分口径已由业务负责人验收"
                />
              </label>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  isReleasing ||
                  !releaseReason.trim() ||
                  releaseVersionId === page.currentVersionId
                }
              >
                {releaseVersionId === page.currentVersionId
                  ? "当前已发布"
                  : isReleasing
                    ? "正在切换…"
                    : releaseIsRollback
                      ? "回滚到此版本"
                      : "发布此版本"}
              </button>
            </form>

            {draftRules ? (
              <form
                className="admin-card admin-create"
                onSubmit={createVersion}
              >
                <div>
                  <span>新建不可变版本</span>
                  <h3>调整评分与业务阶段</h3>
                </div>
                <label>
                  版本名称
                  <input
                    aria-label="作战规则版本名称"
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                  />
                </label>
                <label>
                  最低正式事实数
                  <input
                    aria-label="最低正式事实数"
                    type="number"
                    min="1"
                    max="100"
                    value={draftRules.minimumFactCount}
                    onChange={(event) =>
                      setDraftRules((current) =>
                        current
                          ? {
                              ...current,
                              minimumFactCount: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
                <ScoreEditor
                  label="关系得分"
                  prefix="关系"
                  value={draftRules.relationshipScore}
                  onChange={(field, value) =>
                    updateScore("relationshipScore", field, value)
                  }
                />
                <ScoreEditor
                  label="潜力得分"
                  prefix="潜力"
                  value={draftRules.potentialScore}
                  onChange={(field, value) =>
                    updateScore("potentialScore", field, value)
                  }
                />
                <div className="admin-parameter-grid">
                  <label>
                    充分数据象限
                    <input
                      aria-label="充分数据象限"
                      value={draftRules.sufficientResult.quadrantCode}
                      onChange={(event) =>
                        setDraftRules((current) =>
                          current
                            ? {
                                ...current,
                                sufficientResult: {
                                  ...current.sufficientResult,
                                  quadrantCode: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    信号强度
                    <input
                      aria-label="作战信号强度"
                      type="number"
                      min="0"
                      max="100"
                      value={draftRules.sufficientResult.signalStrength}
                      onChange={(event) =>
                        setDraftRules((current) =>
                          current
                            ? {
                                ...current,
                                sufficientResult: {
                                  ...current.sufficientResult,
                                  signalStrength: Number(event.target.value),
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                </div>
                <label>
                  默认建议动作标题
                  <input
                    aria-label="默认建议动作标题"
                    value={draftRules.actionProposal.title}
                    onChange={(event) =>
                      setDraftRules((current) =>
                        current
                          ? {
                              ...current,
                              actionProposal: {
                                ...current.actionProposal,
                                title: event.target.value,
                              },
                            }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="admin-prompt-field">
                  阶段名称（每行 code=中文名）
                  <textarea
                    aria-label="作战阶段名称"
                    rows={7}
                    value={stageLabelsText}
                    onChange={(event) => setStageLabelsText(event.target.value)}
                  />
                </label>
                <button
                  className="secondary-button"
                  type="submit"
                  disabled={isCreating || !draftName.trim()}
                >
                  {isCreating ? "正在创建…" : "创建规则版本"}
                </button>
              </form>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function ScoreEditor({
  label,
  prefix,
  value,
  onChange,
}: {
  label: string;
  prefix: string;
  value: { base: number; perFact: number; maximum: number };
  onChange(field: "base" | "perFact" | "maximum", value: string): void;
}) {
  return (
    <fieldset className="battle-score-editor">
      <legend>{label}</legend>
      <label>
        起始分
        <input
          aria-label={`${prefix}起始分`}
          type="number"
          min="0"
          max="100"
          value={value.base}
          onChange={(event) => onChange("base", event.target.value)}
        />
      </label>
      <label>
        每条事实加分
        <input
          aria-label={`${prefix}每条事实加分`}
          type="number"
          min="0"
          max="100"
          value={value.perFact}
          onChange={(event) => onChange("perFact", event.target.value)}
        />
      </label>
      <label>
        封顶分
        <input
          aria-label={`${prefix}封顶分`}
          type="number"
          min="0"
          max="100"
          value={value.maximum}
          onChange={(event) => onChange("maximum", event.target.value)}
        />
      </label>
    </fieldset>
  );
}

function cloneRules(rules: BattleRuleSet): BattleRuleSet {
  return structuredClone(rules);
}

function formatScore(score: {
  base: number;
  perFact: number;
  maximum: number;
}) {
  return `${score.base} + ${score.perFact}/条，封顶 ${score.maximum}`;
}

function formatStageLabels(labels: Record<string, string>) {
  return Object.entries(labels)
    .map(([code, label]) => `${code}=${label}`)
    .join("\n");
}

function parseStageLabels(value: string): Record<string, string> {
  const entries = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1 || separator === line.length - 1) {
        throw new Error(`阶段名称格式无效：${line}`);
      }
      return [
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      ];
    });
  return Object.fromEntries(entries);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "作战规则操作失败，请稍后重试。";
}
