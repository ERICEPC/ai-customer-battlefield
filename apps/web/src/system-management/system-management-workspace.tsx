"use client";

import {
  type AccessControlSnapshot,
  type AiRuntimeConfigVersion,
  type AiRuntimeConfigVersionPage,
  type AsyncWorkFailurePage,
  type AsyncWorkFailureRecord,
  type AuditEntry,
  type AuditEntryListQuery,
  type AuditEntryPage,
  type CreateAiRuntimeConfigVersionRequest,
  type ManagementCapability,
  type ReleasedAiRuntimeConfig,
  type RoleCapabilityUpdate,
  type SenseAudioTextModelId,
  senseAudioTextModelIds,
  type WorkerOperationsHealth,
} from "@battlefield/contracts";
import Link from "next/link";
import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useOptionalSession } from "../auth/session-provider";
import {
  createAiRuntimeConfigVersion,
  getAccessControlSnapshot,
  getWorkerOperationsHealth,
  listAiRuntimeConfigVersions,
  listAsyncWorkFailures,
  listRecentAuditEntries,
  releaseAiRuntimeConfigVersion,
  replaceRoleCapabilities,
  replayAsyncWorkItem,
} from "./api-client";

export interface SystemManagementWorkspaceApi {
  getAccessControl(): Promise<AccessControlSnapshot>;
  replaceRoleCapabilities(
    roleCode: string,
    capabilities: ManagementCapability[],
    reason: string,
    idempotencyKey: string,
  ): Promise<RoleCapabilityUpdate>;
  listVersions(): Promise<AiRuntimeConfigVersionPage>;
  createVersion(
    input: CreateAiRuntimeConfigVersionRequest,
  ): Promise<AiRuntimeConfigVersion>;
  releaseVersion(
    versionId: string,
    reason: string,
  ): Promise<ReleasedAiRuntimeConfig>;
  getHealth(): Promise<WorkerOperationsHealth>;
  listFailures(): Promise<AsyncWorkFailurePage>;
  replayFailure(
    failure: AsyncWorkFailureRecord,
    reason: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  listAudits(query?: AuditEntryListQuery): Promise<AuditEntryPage>;
}

const defaultApi: SystemManagementWorkspaceApi = {
  getAccessControl: getAccessControlSnapshot,
  replaceRoleCapabilities,
  listVersions: listAiRuntimeConfigVersions,
  createVersion: createAiRuntimeConfigVersion,
  releaseVersion: releaseAiRuntimeConfigVersion,
  getHealth: getWorkerOperationsHealth,
  listFailures: listAsyncWorkFailures,
  replayFailure: (failure, reason, idempotencyKey) =>
    replayAsyncWorkItem(
      failure.kind,
      failure.workItemId,
      reason,
      idempotencyKey,
    ),
  listAudits: listRecentAuditEntries,
};

type ManagementLoadSection =
  | "access"
  | "runtime"
  | "health"
  | "failures"
  | "audits";

const initialReloadTokens: Record<ManagementLoadSection, number> = {
  access: 0,
  runtime: 0,
  health: 0,
  failures: 0,
  audits: 0,
};

const initialAuditQuery: AuditEntryListQuery = { limit: 20 };

export function SystemManagementWorkspace({
  api = defaultApi,
}: {
  api?: SystemManagementWorkspaceApi;
}) {
  const sessionContext = useOptionalSession();
  const sessionCapabilities = sessionContext?.session?.capabilities;
  const canManageAccess =
    sessionCapabilities?.includes("access_control.manage") ?? true;
  const canManageRuntime =
    sessionCapabilities?.includes("ai_runtime_config.manage") ?? true;
  const canReadAudits = sessionCapabilities?.includes("audit.read") ?? true;
  const canManageWorker =
    sessionCapabilities?.includes("worker_operations.manage") ?? true;
  const [versions, setVersions] = useState<AiRuntimeConfigVersionPage | null>(
    null,
  );
  const [health, setHealth] = useState<WorkerOperationsHealth | null>(null);
  const [failures, setFailures] = useState<AsyncWorkFailurePage | null>(null);
  const [audits, setAudits] = useState<AuditEntryPage | null>(null);
  const [auditQuery, setAuditQuery] =
    useState<AuditEntryListQuery>(initialAuditQuery);
  const [auditAction, setAuditAction] = useState("");
  const [auditAggregateType, setAuditAggregateType] = useState("");
  const [auditAggregateId, setAuditAggregateId] = useState("");
  const [auditActorUserId, setAuditActorUserId] = useState("");
  const [auditOccurredFrom, setAuditOccurredFrom] = useState("");
  const [auditOccurredBefore, setAuditOccurredBefore] = useState("");
  const [isLoadingOlderAudits, setIsLoadingOlderAudits] = useState(false);
  const [accessControl, setAccessControl] =
    useState<AccessControlSnapshot | null>(null);
  const [loadErrors, setLoadErrors] = useState<
    Partial<Record<ManagementLoadSection, string>>
  >({});
  const [reloadTokens, setReloadTokens] = useState(initialReloadTokens);
  const reloadTokensRef = useRef(reloadTokens);
  reloadTokensRef.current = reloadTokens;
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [savingRoleCode, setSavingRoleCode] = useState<string | null>(null);
  const [name, setName] = useState("跟进拆解新版本");
  const [model, setModel] = useState<SenseAudioTextModelId>(
    "senseaudio-s2-flash",
  );
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState("0.1");
  const [maxTokens, setMaxTokens] = useState("1200");
  const [releaseVersionId, setReleaseVersionId] = useState("");
  const [releaseReason, setReleaseReason] = useState("");
  const [replayReasons, setReplayReasons] = useState<Record<string, string>>(
    {},
  );
  const [capabilityDrafts, setCapabilityDrafts] = useState<
    Record<string, ManagementCapability[]>
  >({});
  const [capabilityReasons, setCapabilityReasons] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (!canManageRuntime) {
      setVersions(null);
      clearLoadError(setLoadErrors, "runtime");
      return;
    }
    let active = true;
    const requestToken = reloadTokens.runtime;
    setVersions(null);
    clearLoadError(setLoadErrors, "runtime");
    void api
      .listVersions()
      .then((loadedVersions) => {
        if (!active || requestToken !== reloadTokensRef.current.runtime) return;
        setVersions(loadedVersions);
        const baseline =
          loadedVersions.items.find(
            (version) => version.versionId === loadedVersions.currentVersionId,
          ) ?? loadedVersions.items[0];
        if (baseline) {
          setModel(baseline.defaultModelId);
          setSystemPrompt(baseline.systemPrompt);
          setTemperature(String(baseline.parameters.temperature));
          setMaxTokens(String(baseline.parameters.maxTokens));
          setName(`${baseline.name} · 新版本`);
          setReleaseVersionId(baseline.versionId);
        }
      })
      .catch((cause: unknown) => {
        if (active && requestToken === reloadTokensRef.current.runtime) {
          setLoadError(setLoadErrors, "runtime", cause);
        }
      });
    return () => {
      active = false;
    };
  }, [api, canManageRuntime, reloadTokens.runtime]);

  useEffect(() => {
    if (!canManageAccess) {
      setAccessControl(null);
      setCapabilityDrafts({});
      clearLoadError(setLoadErrors, "access");
      return;
    }
    let active = true;
    const requestToken = reloadTokens.access;
    setAccessControl(null);
    clearLoadError(setLoadErrors, "access");
    void api
      .getAccessControl()
      .then((loadedAccessControl) => {
        if (!active || requestToken !== reloadTokensRef.current.access) return;
        setAccessControl(loadedAccessControl);
        setCapabilityDrafts(capabilityDraftsFrom(loadedAccessControl));
      })
      .catch((cause: unknown) => {
        if (active && requestToken === reloadTokensRef.current.access) {
          setLoadError(setLoadErrors, "access", cause);
        }
      });
    return () => {
      active = false;
    };
  }, [api, canManageAccess, reloadTokens.access]);

  useEffect(() => {
    if (!canManageWorker) {
      setHealth(null);
      clearLoadError(setLoadErrors, "health");
      return;
    }
    let active = true;
    const requestToken = reloadTokens.health;
    setHealth(null);
    clearLoadError(setLoadErrors, "health");
    void api
      .getHealth()
      .then((loadedHealth) => {
        if (active && requestToken === reloadTokensRef.current.health) {
          setHealth(loadedHealth);
        }
      })
      .catch((cause: unknown) => {
        if (active && requestToken === reloadTokensRef.current.health) {
          setLoadError(setLoadErrors, "health", cause);
        }
      });
    return () => {
      active = false;
    };
  }, [api, canManageWorker, reloadTokens.health]);

  useEffect(() => {
    if (!canManageWorker) {
      setFailures(null);
      clearLoadError(setLoadErrors, "failures");
      return;
    }
    let active = true;
    const requestToken = reloadTokens.failures;
    setFailures(null);
    clearLoadError(setLoadErrors, "failures");
    void api
      .listFailures()
      .then((loadedFailures) => {
        if (active && requestToken === reloadTokensRef.current.failures) {
          setFailures(loadedFailures);
        }
      })
      .catch((cause: unknown) => {
        if (active && requestToken === reloadTokensRef.current.failures) {
          setLoadError(setLoadErrors, "failures", cause);
        }
      });
    return () => {
      active = false;
    };
  }, [api, canManageWorker, reloadTokens.failures]);

  useEffect(() => {
    if (!canReadAudits) {
      setAudits(null);
      clearLoadError(setLoadErrors, "audits");
      return;
    }
    let active = true;
    const requestToken = reloadTokens.audits;
    setAudits(null);
    clearLoadError(setLoadErrors, "audits");
    void api
      .listAudits(auditQuery)
      .then((loadedAudits) => {
        if (active && requestToken === reloadTokensRef.current.audits) {
          setAudits(loadedAudits);
        }
      })
      .catch((cause: unknown) => {
        if (active && requestToken === reloadTokensRef.current.audits) {
          setLoadError(setLoadErrors, "audits", cause);
        }
      });
    return () => {
      active = false;
    };
  }, [api, auditQuery, canReadAudits, reloadTokens.audits]);

  const currentVersion = useMemo(
    () =>
      versions?.items.find(
        (version) => version.versionId === versions.currentVersionId,
      ) ?? null,
    [versions],
  );
  const selectedReleaseVersion = versions?.items.find(
    (version) => version.versionId === releaseVersionId,
  );
  const releaseIsRollback = Boolean(
    currentVersion &&
      selectedReleaseVersion &&
      Number(selectedReleaseVersion.versionNo) <
        Number(currentVersion.versionNo),
  );

  async function refreshOperations(): Promise<void> {
    const [loadedHealth, loadedFailures] = await Promise.all([
      api.getHealth(),
      api.listFailures(),
    ]);
    setHealth(loadedHealth);
    setFailures(loadedFailures);
    if (canReadAudits) setAudits(await api.listAudits(auditQuery));
  }

  function retrySection(section: ManagementLoadSection) {
    setReloadTokens((current) => ({
      ...current,
      [section]: current[section] + 1,
    }));
  }

  function applyAuditFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuditQuery({
      limit: 20,
      ...(auditAction.trim() ? { action: auditAction.trim() } : {}),
      ...(auditAggregateType.trim()
        ? { aggregateType: auditAggregateType.trim() }
        : {}),
      ...(auditAggregateId.trim()
        ? { aggregateId: auditAggregateId.trim() }
        : {}),
      ...(auditActorUserId.trim()
        ? { actorUserId: auditActorUserId.trim() }
        : {}),
      ...(auditOccurredFrom
        ? { occurredFrom: localDateTimeToIso(auditOccurredFrom) }
        : {}),
      ...(auditOccurredBefore
        ? { occurredBefore: localDateTimeToIso(auditOccurredBefore) }
        : {}),
    });
  }

  function clearAuditFilters() {
    setAuditAction("");
    setAuditAggregateType("");
    setAuditAggregateId("");
    setAuditActorUserId("");
    setAuditOccurredFrom("");
    setAuditOccurredBefore("");
    setAuditQuery({ ...initialAuditQuery });
  }

  async function loadOlderAudits() {
    if (!audits?.nextCursor || isLoadingOlderAudits) return;
    setIsLoadingOlderAudits(true);
    setError(null);
    try {
      const older = await api.listAudits({
        ...auditQuery,
        cursor: audits.nextCursor,
      });
      setAudits((current) =>
        current
          ? {
              items: [...current.items, ...older.items],
              nextCursor: older.nextCursor,
            }
          : older,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoadingOlderAudits(false);
    }
  }

  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) return;
    setIsCreating(true);
    setError(null);
    setMessage(null);
    try {
      const created = await api.createVersion({
        name,
        defaultModelId: model,
        systemPrompt,
        parameters: {
          temperature: Number(temperature),
          maxTokens: Number(maxTokens),
        },
      });
      const next = await api.listVersions();
      setVersions(next);
      setReleaseVersionId(created.versionId);
      setMessage(`版本 ${created.versionNo} 已创建，尚未影响线上 Agent。`);
      if (canReadAudits) setAudits(await api.listAudits(auditQuery));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsCreating(false);
    }
  }

  async function releaseVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      isReleasing ||
      !releaseVersionId ||
      releaseVersionId === versions?.currentVersionId
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
      setVersions(await api.listVersions());
      if (canReadAudits) setAudits(await api.listAudits(auditQuery));
      setReleaseReason("");
      setMessage(
        `${releaseIsRollback ? "回滚" : "发布"}完成：版本 ${released.versionNo}，发布序号 ${released.releaseNo}。`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsReleasing(false);
    }
  }

  async function replay(failure: AsyncWorkFailureRecord) {
    const reason = replayReasons[failure.workItemId]?.trim() ?? "";
    if (!reason || replayingId) return;
    setReplayingId(failure.workItemId);
    setError(null);
    setMessage(null);
    try {
      await api.replayFailure(failure, reason, crypto.randomUUID());
      await refreshOperations();
      setMessage("失败任务已重新进入队列，Worker 将按正常流程处理。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setReplayingId(null);
    }
  }

  function toggleCapability(
    roleCode: string,
    capability: ManagementCapability,
    checked: boolean,
  ) {
    if (!accessControl) return;
    setCapabilityDrafts((current) => {
      const selected = new Set(current[roleCode] ?? []);
      if (checked) selected.add(capability);
      else selected.delete(capability);
      return {
        ...current,
        [roleCode]: accessControl.capabilities
          .map((item) => item.code)
          .filter((code) => selected.has(code)),
      };
    });
  }

  async function saveRoleCapabilities(roleCode: string, displayName: string) {
    const reason = capabilityReasons[roleCode]?.trim() ?? "";
    const desired = capabilityDrafts[roleCode] ?? [];
    if (!reason || savingRoleCode) return;
    setSavingRoleCode(roleCode);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.replaceRoleCapabilities(
        roleCode,
        desired,
        reason,
        crypto.randomUUID(),
      );
      setAccessControl((current) =>
        current
          ? {
              ...current,
              roles: current.roles.map((role) =>
                role.roleCode === roleCode
                  ? { ...role, capabilities: updated.capabilities }
                  : role,
              ),
            }
          : current,
      );
      setCapabilityDrafts((current) => ({
        ...current,
        [roleCode]: updated.capabilities,
      }));
      setCapabilityReasons((current) => ({ ...current, [roleCode]: "" }));
      setMessage(
        updated.changed
          ? `${displayName}的功能权限已更新。`
          : `${displayName}的功能权限没有变化。`,
      );
      if (canReadAudits) {
        try {
          setAudits(await api.listAudits(auditQuery));
        } catch {
          // The change itself succeeded. A simultaneous audit-capability revoke
          // may make this optional refresh unavailable on the same screen.
        }
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingRoleCode(null);
    }
  }

  return (
    <div className="system-management-workspace">
      <section className="page-heading admin-heading">
        <div>
          <p className="eyebrow">SYSTEM MANAGEMENT</p>
          <h1>系统管理</h1>
          <p>管理 Agent 运行版本，查看异步链路健康，并追溯关键操作。</p>
        </div>
        {canManageWorker ? (
          health ? (
            <div className={`worker-state worker-${health.worker.state}`}>
              <span aria-hidden="true" />
              <div>
                <strong>{workerStateLabel(health.worker.state)}</strong>
                <p>
                  {health.worker.lastSuccessAt
                    ? `最近成功 ${formatDateTime(health.worker.lastSuccessAt)}`
                    : "尚无成功心跳"}
                </p>
              </div>
            </div>
          ) : (
            <div
              className={`worker-state ${loadErrors.health ? "worker-degraded" : "worker-loading"}`}
              role="status"
            >
              <span aria-hidden="true" />
              <div>
                <strong>
                  {loadErrors.health ? "Worker 状态未读取" : "正在读取 Worker"}
                </strong>
                <p>
                  {loadErrors.health ? "可在下方单独重试" : "其他区域可先使用"}
                </p>
              </div>
            </div>
          )
        ) : null}
      </section>

      {message ? <p className="admin-message">{message}</p> : null}
      {error ? (
        <p className="admin-inline-error" role="alert">
          {error}
        </p>
      ) : null}

      {canManageAccess ? (
        <section className="admin-section" aria-labelledby="access-title">
          <div className="admin-section-heading">
            <div>
              <span>ACCESS CONTROL</span>
              <h2 id="access-title">角色与功能权限</h2>
            </div>
            <p>按角色配置管理功能入口；每次保存都要求说明原因并写入审计。</p>
          </div>
          {accessControl ? (
            <>
              <div className="access-scope-note">
                <strong>功能权限不会扩大客户与商机数据范围</strong>
                <p>
                  客户、商机、跟进和作战地图仍按负责人、协同人与管理观察关系独立裁剪。
                </p>
              </div>
              <div className="role-capability-grid">
                {accessControl.roles.map((role) => {
                  const draft = capabilityDrafts[role.roleCode] ?? [];
                  const changed = !sameCapabilitySet(draft, role.capabilities);
                  const reason = capabilityReasons[role.roleCode] ?? "";
                  return (
                    <article key={role.roleCode}>
                      <div className="role-capability-heading">
                        <div>
                          <span>{role.roleCode}</span>
                          <h3>{role.displayName}</h3>
                        </div>
                        <p>
                          {role.displayName} · {role.activeUserCount} 个有效账号
                        </p>
                      </div>
                      <fieldset>
                        <legend>可使用的管理功能</legend>
                        {accessControl.capabilities.map((capability) => {
                          const checked = draft.includes(capability.code);
                          return (
                            <label key={capability.code}>
                              <input
                                aria-label={`${role.displayName} · ${capability.name}`}
                                type="checkbox"
                                checked={checked}
                                disabled={savingRoleCode !== null}
                                onChange={(event) =>
                                  toggleCapability(
                                    role.roleCode,
                                    capability.code,
                                    event.target.checked,
                                  )
                                }
                              />
                              <span>
                                <strong>{capability.name}</strong>
                                <small>{capability.description}</small>
                              </span>
                              <em>{checked ? "已授权" : "未授权"}</em>
                            </label>
                          );
                        })}
                      </fieldset>
                      <div className="role-capability-save">
                        <label>
                          授权变更原因
                          <input
                            aria-label={`授权变更原因 ${role.displayName}`}
                            value={reason}
                            disabled={savingRoleCode !== null}
                            onChange={(event) =>
                              setCapabilityReasons((current) => ({
                                ...current,
                                [role.roleCode]: event.target.value,
                              }))
                            }
                            placeholder="例如：销售主管新增审计自查职责"
                          />
                        </label>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={
                            savingRoleCode !== null ||
                            !changed ||
                            !reason.trim()
                          }
                          onClick={() =>
                            void saveRoleCapabilities(
                              role.roleCode,
                              role.displayName,
                            )
                          }
                        >
                          {savingRoleCode === role.roleCode
                            ? "正在保存…"
                            : `保存${role.displayName}权限`}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <ManagementSectionState
              label="角色权限配置"
              error={loadErrors.access}
              onRetry={() => retrySection("access")}
            />
          )}
        </section>
      ) : null}

      {canManageRuntime ? (
        <section className="admin-section" aria-labelledby="runtime-title">
          <div className="admin-section-heading">
            <div>
              <span>AGENT RUNTIME</span>
              <h2 id="runtime-title">跟进拆解配置</h2>
            </div>
            <p>创建版本不会立即生效；只有发布后 Agent 才会读取。</p>
          </div>

          {versions ? (
            <>
              <div className="runtime-version-grid">
                {versions.items.map((version) => (
                  <article
                    className={
                      version.versionId === versions.currentVersionId
                        ? "runtime-version current"
                        : "runtime-version"
                    }
                    key={version.versionId}
                  >
                    <div>
                      <span>V{version.versionNo}</span>
                      {version.versionId === versions.currentVersionId ? (
                        <strong>当前发布</strong>
                      ) : null}
                    </div>
                    <h3>{version.name}</h3>
                    <p>{version.defaultModelId}</p>
                    <dl>
                      <div>
                        <dt>温度</dt>
                        <dd>{version.parameters.temperature}</dd>
                      </div>
                      <div>
                        <dt>最大 Tokens</dt>
                        <dd>{version.parameters.maxTokens}</dd>
                      </div>
                      <div>
                        <dt>创建时间</dt>
                        <dd>{formatDateTime(version.createdAt)}</dd>
                      </div>
                    </dl>
                    <details>
                      <summary>查看 Prompt</summary>
                      <pre>{version.systemPrompt}</pre>
                    </details>
                  </article>
                ))}
              </div>

              <div className="admin-form-grid">
                <form
                  className="admin-card admin-release"
                  onSubmit={releaseVersion}
                >
                  <div>
                    <span>发布控制</span>
                    <h3>切换当前版本</h3>
                  </div>
                  <label>
                    待发布版本
                    <select
                      aria-label="待发布版本"
                      value={releaseVersionId}
                      onChange={(event) =>
                        setReleaseVersionId(event.target.value)
                      }
                    >
                      {versions.items.map((version) => (
                        <option
                          value={version.versionId}
                          key={version.versionId}
                        >
                          V{version.versionNo} · {version.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    发布或回滚原因
                    <input
                      aria-label="发布或回滚原因"
                      value={releaseReason}
                      onChange={(event) => setReleaseReason(event.target.value)}
                      placeholder="例如：严格契约已完成验收"
                    />
                  </label>
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={
                      isReleasing ||
                      !releaseReason.trim() ||
                      releaseVersionId === versions.currentVersionId
                    }
                  >
                    {releaseVersionId === versions.currentVersionId
                      ? "当前已发布"
                      : isReleasing
                        ? "正在切换…"
                        : releaseIsRollback
                          ? "回滚到此版本"
                          : "发布此版本"}
                  </button>
                </form>

                <form
                  className="admin-card admin-create"
                  onSubmit={createVersion}
                >
                  <div>
                    <span>新建版本</span>
                    <h3>编辑但暂不生效</h3>
                  </div>
                  <label>
                    版本名称
                    <input
                      aria-label="版本名称"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label>
                    租户默认模型
                    <select
                      aria-label="租户默认模型"
                      value={model}
                      onChange={(event) =>
                        setModel(event.target.value as SenseAudioTextModelId)
                      }
                    >
                      {senseAudioTextModelIds.map((modelId) => (
                        <option value={modelId} key={modelId}>
                          {modelId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="admin-prompt-field">
                    System Prompt
                    <textarea
                      aria-label="System Prompt"
                      value={systemPrompt}
                      onChange={(event) => setSystemPrompt(event.target.value)}
                      rows={8}
                    />
                  </label>
                  <div className="admin-parameter-grid">
                    <label>
                      Temperature
                      <input
                        aria-label="Temperature"
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={temperature}
                        onChange={(event) => setTemperature(event.target.value)}
                      />
                    </label>
                    <label>
                      Max Tokens
                      <input
                        aria-label="Max Tokens"
                        type="number"
                        min="1"
                        max="8000"
                        value={maxTokens}
                        onChange={(event) => setMaxTokens(event.target.value)}
                      />
                    </label>
                  </div>
                  <button
                    className="secondary-button"
                    type="submit"
                    disabled={
                      isCreating || !name.trim() || !systemPrompt.trim()
                    }
                  >
                    {isCreating ? "正在创建…" : "创建不可变版本"}
                  </button>
                </form>
              </div>
            </>
          ) : (
            <ManagementSectionState
              label="Agent 运行配置"
              error={loadErrors.runtime}
              onRetry={() => retrySection("runtime")}
            />
          )}
        </section>
      ) : null}

      {canManageWorker ? (
        <section className="admin-section" aria-labelledby="worker-title">
          <div className="admin-section-heading">
            <div>
              <span>ASYNC OPERATIONS</span>
              <h2 id="worker-title">Worker 与失败队列</h2>
            </div>
            <p>人工重放会保留原始失败证据，并重新进入自动重试流程。</p>
          </div>
          {health ? (
            <div className="queue-health-grid">
              {health.queues.map((queue) => (
                <article key={queue.kind}>
                  <span>{queueLabel(queue.kind)}</span>
                  <strong>{queue.readyCount}</strong>
                  <p>待处理</p>
                  <dl>
                    <div>
                      <dt>处理中</dt>
                      <dd>{queue.processingCount}</dd>
                    </div>
                    <div>
                      <dt>失败</dt>
                      <dd>{queue.failedCount}</dd>
                    </div>
                    <div>
                      <dt>死信</dt>
                      <dd>{queue.deadLetteredCount}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          ) : (
            <ManagementSectionState
              label="Worker 运行状态"
              error={loadErrors.health}
              onRetry={() => retrySection("health")}
            />
          )}

          {!failures ? (
            <ManagementSectionState
              label="失败任务"
              error={loadErrors.failures}
              onRetry={() => retrySection("failures")}
            />
          ) : failures.items.length === 0 ? (
            <div className="admin-empty">
              <strong>当前没有失败或死信</strong>
              <p>三类异步队列均无需人工处理。</p>
            </div>
          ) : (
            <div className="failure-list">
              {failures.items.map((failure) => (
                <article key={`${failure.kind}:${failure.workItemId}`}>
                  <div className="failure-heading">
                    <span>{queueLabel(failure.kind)}</span>
                    <strong>{failure.category}</strong>
                    <em>
                      {failure.status === "dead_lettered" ? "死信" : "失败"}
                    </em>
                  </div>
                  <p>{failure.lastErrorMessage}</p>
                  <dl>
                    <div>
                      <dt>错误码</dt>
                      <dd>{failure.lastErrorCode}</dd>
                    </div>
                    <div>
                      <dt>尝试次数</dt>
                      <dd>{failure.attemptCount}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDateTime(failure.createdAt)}</dd>
                    </div>
                  </dl>
                  <div className="failure-replay">
                    <input
                      aria-label={`重放原因 ${failure.category}`}
                      value={replayReasons[failure.workItemId] ?? ""}
                      onChange={(event) =>
                        setReplayReasons((current) => ({
                          ...current,
                          [failure.workItemId]: event.target.value,
                        }))
                      }
                      placeholder="填写确认修复后的重放原因"
                    />
                    <button
                      type="button"
                      disabled={
                        replayingId !== null ||
                        !(replayReasons[failure.workItemId] ?? "").trim()
                      }
                      onClick={() => void replay(failure)}
                    >
                      {replayingId === failure.workItemId
                        ? "正在重放…"
                        : "重新进入队列"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {canReadAudits ? (
        <section className="admin-section" aria-labelledby="audit-title">
          <div className="admin-section-heading">
            <div>
              <span>AUDIT TRAIL</span>
              <h2 id="audit-title">最近操作留痕</h2>
            </div>
            <p>仅展示当前管理范围内的审计元数据，不暴露业务快照。</p>
          </div>
          <form className="admin-audit-filter" onSubmit={applyAuditFilters}>
            <fieldset disabled={isLoadingOlderAudits}>
              <label>
                审计动作
                <input
                  aria-label="审计动作"
                  value={auditAction}
                  onChange={(event) => setAuditAction(event.target.value)}
                  placeholder="例如 followup.viewed"
                />
              </label>
              <label>
                业务对象类型
                <input
                  aria-label="业务对象类型"
                  value={auditAggregateType}
                  onChange={(event) =>
                    setAuditAggregateType(event.target.value)
                  }
                  placeholder="例如 followup"
                />
              </label>
              <label>
                对象 ID
                <input
                  aria-label="审计业务对象 ID"
                  value={auditAggregateId}
                  onChange={(event) => setAuditAggregateId(event.target.value)}
                  placeholder="UUID，可选"
                />
              </label>
              <label>
                操作者 ID
                <input
                  aria-label="审计操作者 ID"
                  value={auditActorUserId}
                  onChange={(event) => setAuditActorUserId(event.target.value)}
                  placeholder="UUID，可选"
                />
              </label>
              <label>
                开始时间
                <input
                  aria-label="审计开始时间"
                  type="datetime-local"
                  value={auditOccurredFrom}
                  onChange={(event) => setAuditOccurredFrom(event.target.value)}
                />
              </label>
              <label>
                结束时间（不含）
                <input
                  aria-label="审计结束时间"
                  type="datetime-local"
                  value={auditOccurredBefore}
                  onChange={(event) =>
                    setAuditOccurredBefore(event.target.value)
                  }
                />
              </label>
            </fieldset>
            <div>
              <button
                className="primary-button"
                type="submit"
                disabled={isLoadingOlderAudits}
              >
                查询审计记录
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={isLoadingOlderAudits}
                onClick={clearAuditFilters}
              >
                清空筛选
              </button>
            </div>
          </form>
          {audits ? (
            <>
              <div className="admin-audit-list">
                {audits.items.length === 0 ? (
                  <p>当前筛选条件下暂无可见审计记录。</p>
                ) : (
                  audits.items.map((entry) => {
                    const href = auditEntryHref(entry);
                    return (
                      <article key={entry.entryId}>
                        <span>{entry.action}</span>
                        <strong>{entry.actor.displayName}</strong>
                        <p>
                          {href ? (
                            <Link
                              className="audit-deep-link"
                              href={href}
                              aria-label={`打开对应记录 ${entry.aggregateType}`}
                            >
                              {entry.aggregateType} ·{" "}
                              {entry.aggregateId.slice(0, 8)}
                              <small>打开记录</small>
                            </Link>
                          ) : (
                            <>
                              {entry.aggregateType} ·{" "}
                              {entry.aggregateId.slice(0, 8)}
                            </>
                          )}
                        </p>
                        <time dateTime={entry.occurredAt}>
                          {formatDateTime(entry.occurredAt)}
                        </time>
                        {entry.reason ? <em>{entry.reason}</em> : null}
                      </article>
                    );
                  })
                )}
              </div>
              {audits.nextCursor ? (
                <button
                  className="secondary-button admin-audit-more"
                  type="button"
                  disabled={isLoadingOlderAudits}
                  aria-label="加载更早审计记录"
                  onClick={() => void loadOlderAudits()}
                >
                  {isLoadingOlderAudits ? "正在加载…" : "加载更早记录"}
                </button>
              ) : null}
            </>
          ) : (
            <ManagementSectionState
              label="最近审计记录"
              error={loadErrors.audits}
              onRetry={() => retrySection("audits")}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}

function workerStateLabel(state: WorkerOperationsHealth["worker"]["state"]) {
  return {
    healthy: "Worker 运行正常",
    degraded: "Worker 最近有失败",
    stale: "Worker 心跳已中断",
    never_started: "Worker 尚未启动",
  }[state];
}

function ManagementSectionState({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: string | undefined;
  onRetry(): void;
}) {
  return (
    <div
      className={`admin-section-state${error ? " admin-section-state-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {error ? null : <span className="loading-mark" aria-hidden="true" />}
      <div>
        <strong>{error ? `${label}读取失败` : `正在读取 ${label}…`}</strong>
        <p>{error ?? "远端数据返回后将自动显示，不影响其他区域使用。"}</p>
      </div>
      {error ? (
        <button
          className="secondary-button"
          type="button"
          aria-label={`重试 ${label}`}
          onClick={onRetry}
        >
          重新读取
        </button>
      ) : null}
    </div>
  );
}

function queueLabel(kind: WorkerOperationsHealth["queues"][number]["kind"]) {
  return {
    outbox: "业务事件",
    reminder: "动作提醒",
    notification_delivery: "消息投递",
  }[kind];
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

function localDateTimeToIso(value: string): string {
  return new Date(value).toISOString();
}

function auditEntryHref(entry: AuditEntry): string | null {
  const id = encodeURIComponent(entry.aggregateId);
  return (
    {
      followup: `/followups/${id}`,
      business_action: `/actions?actionId=${id}`,
      business_entity: `/battle-map?entityId=${id}`,
      battle_state_version: `/battle-map?stateVersion=${id}`,
    }[entry.aggregateType] ?? null
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "系统管理操作失败。";
}

type LoadErrorSetter = Dispatch<
  SetStateAction<Partial<Record<ManagementLoadSection, string>>>
>;

function clearLoadError(
  setLoadErrors: LoadErrorSetter,
  section: ManagementLoadSection,
) {
  setLoadErrors((current) => {
    if (!(section in current)) return current;
    const next = { ...current };
    delete next[section];
    return next;
  });
}

function setLoadError(
  setLoadErrors: LoadErrorSetter,
  section: ManagementLoadSection,
  cause: unknown,
) {
  setLoadErrors((current) => ({
    ...current,
    [section]: errorMessage(cause),
  }));
}

function capabilityDraftsFrom(
  snapshot: AccessControlSnapshot,
): Record<string, ManagementCapability[]> {
  return Object.fromEntries(
    snapshot.roles.map((role) => [role.roleCode, [...role.capabilities]]),
  );
}

function sameCapabilitySet(
  left: readonly ManagementCapability[],
  right: readonly ManagementCapability[],
): boolean {
  return (
    left.length === right.length &&
    left.every((capability, index) => capability === right[index])
  );
}
