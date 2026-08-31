"use client";

import type {
  AcceptActionProposalRequest,
  ActionDecisionResponse,
  ActionOwnerListQuery,
  ActionOwnerOption,
  ActionOwnerPage,
  ActionProposalListQuery,
  ActionProposalPage,
  ActionProposalRecord,
  ActionTransitionResponse,
  BusinessActionListQuery,
  BusinessActionPage,
  BusinessActionRecord,
  RejectActionProposalRequest,
  TransitionBusinessActionRequest,
} from "@battlefield/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useOptionalSession } from "../auth/session-provider";
import {
  acceptActionProposal,
  getActionProposal,
  getBusinessAction,
  listActionOwners,
  listActionProposals,
  listBusinessActions,
  rejectActionProposal,
  transitionBusinessAction,
} from "./api-client";
import {
  instantToLocalDateTimeInput,
  localDateTimeInputToInstant,
} from "./date-time";

export interface ActionWorkspaceApi {
  listOwners(input: ActionOwnerListQuery): Promise<ActionOwnerPage>;
  listProposals(input: ActionProposalListQuery): Promise<ActionProposalPage>;
  getProposal(proposalId: string): Promise<ActionProposalRecord>;
  acceptProposal(
    proposalId: string,
    input: AcceptActionProposalRequest,
    idempotencyKey: string,
  ): Promise<ActionDecisionResponse>;
  rejectProposal(
    proposalId: string,
    input: RejectActionProposalRequest,
    idempotencyKey: string,
  ): Promise<ActionDecisionResponse>;
  listActions(input: BusinessActionListQuery): Promise<BusinessActionPage>;
  getAction(actionId: string): Promise<BusinessActionRecord>;
  transitionAction(
    actionId: string,
    input: TransitionBusinessActionRequest,
  ): Promise<ActionTransitionResponse>;
}

const defaultApi: ActionWorkspaceApi = {
  listOwners: listActionOwners,
  listProposals: listActionProposals,
  getProposal: getActionProposal,
  acceptProposal: acceptActionProposal,
  rejectProposal: rejectActionProposal,
  listActions: listBusinessActions,
  getAction: getBusinessAction,
  transitionAction: transitionBusinessAction,
};

type Priority = "low" | "medium" | "high" | "urgent";
type AcceptAttempt = {
  key: string;
  input: AcceptActionProposalRequest;
};
type RejectAttempt = {
  key: string;
  input: RejectActionProposalRequest;
};
type ActionActor = {
  userId: string;
  displayName: string;
};

const isolatedTestActor: ActionActor = {
  userId: "30000000-0000-4000-8000-000000000001",
  displayName: "当前用户",
};

export function ActionWorkspace({
  api = defaultApi,
  actor,
  initialActionId,
}: {
  api?: ActionWorkspaceApi;
  actor?: ActionActor;
  initialActionId?: string;
}) {
  const sessionContext = useOptionalSession();
  const currentActor =
    actor ??
    (sessionContext?.session
      ? {
          userId: sessionContext.session.user.id,
          displayName: sessionContext.session.user.displayName,
        }
      : isolatedTestActor);
  const [proposals, setProposals] = useState<ActionProposalRecord[]>([]);
  const [actions, setActions] = useState<BusinessActionRecord[]>([]);
  const [owners, setOwners] = useState<ActionOwnerOption[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [decisionReceipt, setDecisionReceipt] =
    useState<ActionDecisionResponse | null>(null);
  const [proposalCursor, setProposalCursor] = useState<string | null>(null);
  const [ownerCursor, setOwnerCursor] = useState<string | null>(null);
  const [actionCursor, setActionCursor] = useState<string | null>(null);
  const [isLoadingMoreProposals, setIsLoadingMoreProposals] = useState(false);
  const [isLoadingMoreOwners, setIsLoadingMoreOwners] = useState(false);
  const [isLoadingMoreActions, setIsLoadingMoreActions] = useState(false);
  const [decisionProposalId, setDecisionProposalId] = useState<string | null>(
    null,
  );
  const proposalRequestVersion = useRef(0);
  const ownerRequestVersion = useRef(0);
  const actionRequestVersion = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadVersion intentionally triggers recovery.
  useEffect(() => {
    let current = true;
    const proposalVersion = proposalRequestVersion.current + 1;
    const ownerVersion = ownerRequestVersion.current + 1;
    const actionVersion = actionRequestVersion.current + 1;
    proposalRequestVersion.current = proposalVersion;
    ownerRequestVersion.current = ownerVersion;
    actionRequestVersion.current = actionVersion;
    setIsLoading(true);
    setProposalCursor(null);
    setOwnerCursor(null);
    setActionCursor(null);
    setIsLoadingMoreProposals(false);
    setIsLoadingMoreOwners(false);
    setIsLoadingMoreActions(false);
    setLoadError(null);
    setOperationError(null);
    Promise.all([
      (async () => {
        const proposalPage = await api.listProposals({
          status: "pending_confirmation",
          limit: 50,
        });
        const initialProposal = proposalPage.items[0] ?? null;
        const ownerPage = initialProposal?.canDecide
          ? await api.listOwners({
              entityId: initialProposal.entityId,
              limit: 50,
            })
          : { items: [], nextCursor: null };
        return { proposalPage, initialProposal, ownerPage };
      })(),
      api.listActions({ limit: 50 }),
      initialActionId ? api.getAction(initialActionId) : Promise.resolve(null),
    ])
      .then(([proposalLoad, actionPage, targetAction]) => {
        if (
          !current ||
          ownerVersion !== ownerRequestVersion.current ||
          proposalVersion !== proposalRequestVersion.current ||
          actionVersion !== actionRequestVersion.current
        )
          return;
        const { proposalPage, initialProposal, ownerPage } = proposalLoad;
        setProposals(proposalPage.items);
        setActions(actionsWithTargetFirst(actionPage.items, targetAction));
        setOwners(ownerPage.items);
        setOwnerCursor(ownerPage.nextCursor);
        setProposalCursor(proposalPage.nextCursor);
        setActionCursor(actionPage.nextCursor);
        setSelectedProposalId(initialProposal?.proposalId ?? null);
      })
      .catch((error: unknown) => {
        if (
          current &&
          ownerVersion === ownerRequestVersion.current &&
          proposalVersion === proposalRequestVersion.current &&
          actionVersion === actionRequestVersion.current
        )
          setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (
          current &&
          ownerVersion === ownerRequestVersion.current &&
          proposalVersion === proposalRequestVersion.current &&
          actionVersion === actionRequestVersion.current
        )
          setIsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, initialActionId, reloadVersion]);

  const selected =
    proposals.find((proposal) => proposal.proposalId === selectedProposalId) ??
    null;

  function refresh(): void {
    if (decisionProposalId) return;
    proposalRequestVersion.current += 1;
    ownerRequestVersion.current += 1;
    actionRequestVersion.current += 1;
    setProposalCursor(null);
    setOwnerCursor(null);
    setActionCursor(null);
    setIsLoadingMoreProposals(false);
    setIsLoadingMoreOwners(false);
    setIsLoadingMoreActions(false);
    setIsLoading(true);
    setReloadVersion((value) => value + 1);
  }

  async function refreshActions(): Promise<void> {
    const requestVersion = actionRequestVersion.current + 1;
    actionRequestVersion.current = requestVersion;
    setActionCursor(null);
    setIsLoadingMoreActions(false);
    try {
      const [page, targetAction] = await Promise.all([
        api.listActions({ limit: 50 }),
        initialActionId
          ? api.getAction(initialActionId)
          : Promise.resolve(null),
      ]);
      if (requestVersion !== actionRequestVersion.current) return;
      setActions(actionsWithTargetFirst(page.items, targetAction));
      setActionCursor(page.nextCursor);
    } catch (error) {
      if (requestVersion !== actionRequestVersion.current) return;
      throw error;
    }
  }

  async function loadMoreProposals(): Promise<void> {
    if (!proposalCursor || isLoadingMoreProposals) return;
    const requestVersion = proposalRequestVersion.current;
    setIsLoadingMoreProposals(true);
    try {
      const page = await api.listProposals({
        status: "pending_confirmation",
        limit: 50,
        cursor: proposalCursor,
      });
      if (requestVersion !== proposalRequestVersion.current) return;
      setProposals((current) => mergeById(current, page.items, "proposalId"));
      setProposalCursor(page.nextCursor);
    } catch (error) {
      if (requestVersion === proposalRequestVersion.current)
        setOperationError(errorMessage(error));
    } finally {
      if (requestVersion === proposalRequestVersion.current)
        setIsLoadingMoreProposals(false);
    }
  }

  async function selectProposal(proposal: ActionProposalRecord): Promise<void> {
    const requestVersion = ownerRequestVersion.current + 1;
    ownerRequestVersion.current = requestVersion;
    setSelectedProposalId(proposal.proposalId);
    setDecisionReceipt(null);
    setOwners([]);
    setOwnerCursor(null);
    setOperationError(null);
    setIsLoadingMoreOwners(proposal.canDecide);
    if (!proposal.canDecide) return;
    try {
      const page = await api.listOwners({
        entityId: proposal.entityId,
        limit: 50,
      });
      if (requestVersion !== ownerRequestVersion.current) return;
      setOwners(page.items);
      setOwnerCursor(page.nextCursor);
    } catch (error) {
      if (requestVersion === ownerRequestVersion.current)
        setOperationError(errorMessage(error));
    } finally {
      if (requestVersion === ownerRequestVersion.current)
        setIsLoadingMoreOwners(false);
    }
  }

  async function loadMoreOwners(): Promise<void> {
    if (!selected?.canDecide || !ownerCursor || isLoadingMoreOwners) return;
    const requestVersion = ownerRequestVersion.current;
    setIsLoadingMoreOwners(true);
    try {
      const page = await api.listOwners({
        entityId: selected.entityId,
        limit: 50,
        cursor: ownerCursor,
      });
      if (requestVersion !== ownerRequestVersion.current) return;
      setOwners((current) => mergeById(current, page.items, "userId"));
      setOwnerCursor(page.nextCursor);
    } catch (error) {
      if (requestVersion === ownerRequestVersion.current)
        setOperationError(errorMessage(error));
    } finally {
      if (requestVersion === ownerRequestVersion.current)
        setIsLoadingMoreOwners(false);
    }
  }

  async function loadMoreActions(): Promise<void> {
    if (!actionCursor || isLoadingMoreActions) return;
    const requestVersion = actionRequestVersion.current;
    setIsLoadingMoreActions(true);
    try {
      const page = await api.listActions({ limit: 50, cursor: actionCursor });
      if (requestVersion !== actionRequestVersion.current) return;
      setActions((current) => mergeById(current, page.items, "actionId"));
      setActionCursor(page.nextCursor);
    } catch (error) {
      if (requestVersion === actionRequestVersion.current)
        setOperationError(errorMessage(error));
    } finally {
      if (requestVersion === actionRequestVersion.current)
        setIsLoadingMoreActions(false);
    }
  }

  return (
    <section className="action-workspace" aria-label="经营动作工作区">
      <div className="action-boundary-banner">
        <div>
          <strong>建议不是任务，尚未启用提醒</strong>
          <span>
            只有逐条确认责任人、时间与优先级后，才会创建正式经营动作。
          </span>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={decisionProposalId !== null}
          onClick={refresh}
        >
          刷新工作区
        </button>
      </div>
      {isLoading ? (
        <div className="battle-page-state" role="status">
          <span className="loading-mark" aria-hidden="true" />
          正在加载经营动作…
        </div>
      ) : null}
      {loadError ? (
        <div className="battle-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={refresh}>
            重新加载
          </button>
        </div>
      ) : null}
      {operationError && !loadError ? (
        <div className="battle-error" role="alert">
          <span>{operationError}</span>
          <button type="button" onClick={() => setOperationError(null)}>
            关闭
          </button>
        </div>
      ) : null}
      {!isLoading && !loadError ? (
        <>
          <section
            className="proposal-workbench"
            aria-labelledby="proposal-title"
          >
            <div className="section-heading-inline">
              <div>
                <p className="eyebrow">HUMAN DECISION GATE</p>
                <h2 id="proposal-title">待确认建议</h2>
              </div>
              <span>{proposals.length} 条待逐一判断</span>
            </div>
            {proposals.length === 0 ? (
              <div className="action-empty">
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>没有待确认建议</strong>
                  <p>新的分析建议会先进入这里，不会直接成为任务。</p>
                </div>
              </div>
            ) : (
              <div className="proposal-layout">
                <nav className="proposal-queue" aria-label="待确认建议队列">
                  {proposals.map((proposal, index) => (
                    <button
                      type="button"
                      key={proposal.proposalId}
                      className={
                        proposal.proposalId === selectedProposalId
                          ? "selected"
                          : undefined
                      }
                      disabled={decisionProposalId !== null}
                      onClick={() => void selectProposal(proposal)}
                    >
                      <span>建议 {index + 1}</span>
                      <strong>{proposal.title}</strong>
                      <small>
                        {proposal.status === "expired"
                          ? "建议已过期"
                          : `${priorityLabel(proposal.suggestedPriority)} · ${formatDateTime(proposal.expiresAt)} 前确认`}
                      </small>
                    </button>
                  ))}
                  {proposalCursor ? (
                    <button
                      type="button"
                      className="proposal-load-more"
                      disabled={
                        isLoadingMoreProposals || decisionProposalId !== null
                      }
                      onClick={loadMoreProposals}
                    >
                      {isLoadingMoreProposals ? "正在加载…" : "加载更多建议"}
                    </button>
                  ) : null}
                </nav>
                {selected ? (
                  <ProposalDecisionCard
                    key={selected.proposalId}
                    proposal={selected}
                    api={api}
                    actor={currentActor}
                    owners={owners}
                    hasMoreOwners={ownerCursor !== null}
                    isLoadingMoreOwners={isLoadingMoreOwners}
                    onLoadMoreOwners={loadMoreOwners}
                    receipt={decisionReceipt}
                    onReceipt={(value) => {
                      setDecisionReceipt(value);
                      setDecisionProposalId(null);
                      if (value.status === "accepted") {
                        void refreshActions().catch((error: unknown) =>
                          setOperationError(errorMessage(error)),
                        );
                      }
                    }}
                    onBusyChange={(busy) =>
                      setDecisionProposalId(busy ? selected.proposalId : null)
                    }
                    onRecover={async () => {
                      const latest = await api.getProposal(selected.proposalId);
                      setProposals((current) =>
                        current.map((item) =>
                          item.proposalId === latest.proposalId ? latest : item,
                        ),
                      );
                      if (latest.status === "accepted") {
                        if (!latest.actionId) {
                          throw new Error("已接受建议缺少正式动作标识。");
                        }
                        setDecisionReceipt({
                          proposalId: latest.proposalId,
                          status: "accepted",
                          actionId: latest.actionId,
                          versionNo: latest.versionNo,
                          decidedAt:
                            latest.decidedAt ?? new Date().toISOString(),
                        });
                        await refreshActions();
                      } else if (latest.status === "rejected") {
                        setDecisionReceipt({
                          proposalId: latest.proposalId,
                          status: "rejected",
                          actionId: null,
                          versionNo: latest.versionNo,
                          decidedAt:
                            latest.decidedAt ?? new Date().toISOString(),
                        });
                      }
                      return latest;
                    }}
                  />
                ) : null}
              </div>
            )}
          </section>

          <FormalActionList
            actions={actions}
            api={api}
            highlightedActionId={initialActionId ?? null}
            nextCursor={actionCursor}
            isLoadingMore={isLoadingMoreActions}
            onLoadMore={loadMoreActions}
            onChange={(changed) =>
              setActions((current) =>
                current.map((item) =>
                  item.actionId === changed.actionId
                    ? {
                        ...item,
                        status: changed.status,
                        versionNo: changed.versionNo,
                        completedAt:
                          changed.status === "completed"
                            ? changed.changedAt
                            : null,
                      }
                    : item,
                ),
              )
            }
          />
        </>
      ) : null}
    </section>
  );
}

function ProposalDecisionCard({
  proposal,
  api,
  actor,
  owners,
  hasMoreOwners,
  isLoadingMoreOwners,
  onLoadMoreOwners,
  receipt,
  onReceipt,
  onRecover,
  onBusyChange,
}: {
  proposal: ActionProposalRecord;
  api: ActionWorkspaceApi;
  actor: ActionActor;
  owners: ActionOwnerOption[];
  hasMoreOwners: boolean;
  isLoadingMoreOwners: boolean;
  onLoadMoreOwners(): Promise<void>;
  receipt: ActionDecisionResponse | null;
  onReceipt(value: ActionDecisionResponse): void;
  onRecover(): Promise<ActionProposalRecord>;
  onBusyChange(busy: boolean): void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [description, setDescription] = useState(proposal.description);
  const [ownerId, setOwnerId] = useState(() =>
    initialActiveOwnerId(actor, owners, proposal),
  );
  const [priority, setPriority] = useState<Priority>(
    proposal.suggestedPriority,
  );
  const [plannedAt, setPlannedAt] = useState(
    proposal.suggestedPlannedAt
      ? instantToLocalDateTimeInput(proposal.suggestedPlannedAt)
      : "",
  );
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [acceptAttempt, setAcceptAttempt] = useState<AcceptAttempt | null>(
    null,
  );
  const [rejectAttempt, setRejectAttempt] = useState<RejectAttempt | null>(
    null,
  );

  const fieldsLocked =
    isSubmitting || acceptAttempt !== null || rejectAttempt !== null;
  const ownerOptions = owners;
  const suggestedOwnerUnavailable = Boolean(
    proposal.suggestedOwnerId &&
      !owners.some((owner) => owner.userId === proposal.suggestedOwnerId),
  );
  const currentActorUnavailable = !owners.some(
    (owner) => owner.userId === actor.userId,
  );

  const canAccept =
    proposal.canDecide &&
    !isSubmitting &&
    (acceptAttempt !== null ||
      (title.trim().length > 0 &&
        description.trim().length > 0 &&
        ownerId.trim().length > 0 &&
        plannedAt.length > 0));

  async function accept(): Promise<void> {
    if (!canAccept) return;
    setIsSubmitting(true);
    setError(null);
    const attempt =
      acceptAttempt ??
      ({
        key: operationKey("accept"),
        input: {
          versionNo: proposal.versionNo,
          title: title.trim(),
          description: description.trim(),
          ownerUserId: ownerId.trim(),
          priority,
          plannedAt: localDateTimeInputToInstant(plannedAt),
        },
      } satisfies AcceptAttempt);
    setAcceptAttempt(attempt);
    onBusyChange(true);
    try {
      const value = await api.acceptProposal(
        proposal.proposalId,
        attempt.input,
        attempt.key,
      );
      setAcceptAttempt(null);
      onReceipt(value);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function reject(): Promise<void> {
    if (!proposal.canDecide || !rejectionReason.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    const attempt =
      rejectAttempt ??
      ({
        key: operationKey("reject"),
        input: {
          versionNo: proposal.versionNo,
          reason: rejectionReason.trim(),
        },
      } satisfies RejectAttempt);
    setRejectAttempt(attempt);
    onBusyChange(true);
    try {
      const value = await api.rejectProposal(
        proposal.proposalId,
        attempt.input,
        attempt.key,
      );
      setRejectAttempt(null);
      onReceipt(value);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function recover(): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    try {
      const latest = await onRecover();
      setAcceptAttempt(null);
      setRejectAttempt(null);
      setRejecting(false);
      if (latest.status === "pending_confirmation") {
        setRecoveryNotice(
          `已读取服务器版本 v${latest.versionNo}，你的编辑已保留，请重新确认后提交。`,
        );
      }
      onBusyChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (receipt?.proposalId === proposal.proposalId) {
    return (
      <article className="decision-receipt" role="status">
        <span aria-hidden="true">
          {receipt.status === "accepted" ? "✓" : "×"}
        </span>
        <h3>
          {receipt.status === "accepted"
            ? "已创建正式经营动作"
            : "建议已拒绝，未创建行动"}
        </h3>
        <p>
          {receipt.status === "accepted"
            ? "建议与正式动作继续作为两个可追溯对象保存。"
            : "拒绝结果已留痕，该建议不会进入任务或提醒。"}
        </p>
        {receipt.actionId ? <code>{receipt.actionId}</code> : null}
        <button type="button" className="secondary-button" onClick={recover}>
          读取服务器最终状态
        </button>
      </article>
    );
  }

  if (proposal.status === "expired") {
    return (
      <article className="decision-receipt expired" role="status">
        <span aria-hidden="true">!</span>
        <h3>建议已过期</h3>
        <p>
          该建议已越过确认窗口，不能再创建经营动作；重新分析后可生成新建议。
        </p>
      </article>
    );
  }

  if (!proposal.canDecide) {
    return (
      <article className="proposal-decision-card">
        <div className="proposal-source">
          <span className="pending-badge">待负责人确认</span>
          <span>来源状态版本</span>
          <code>{proposal.sourceBattleStateVersionId}</code>
          <span>经营对象</span>
          <strong>{proposal.entityName}</strong>
          <Link
            className="proposal-source-link"
            href={`/battle-map?entityId=${encodeURIComponent(proposal.entityId)}&stateVersion=${encodeURIComponent(proposal.sourceBattleStateVersionId)}`}
          >
            在地图查看来源与证据
          </Link>
        </div>
        <h3>{proposal.title}</h3>
        <p>{proposal.description}</p>
        <p className="source-boundary" role="status">
          仅可查看，不能代替负责人做决策
        </p>
      </article>
    );
  }

  return (
    <article className="proposal-decision-card">
      <div className="proposal-source">
        <span className="pending-badge">待人工确认</span>
        <span>来源状态版本</span>
        <code>{proposal.sourceBattleStateVersionId}</code>
        <span>经营对象</span>
        <strong>{proposal.entityName}</strong>
        <Link
          className="proposal-source-link"
          href={`/battle-map?entityId=${encodeURIComponent(proposal.entityId)}&stateVersion=${encodeURIComponent(proposal.sourceBattleStateVersionId)}`}
        >
          在地图查看来源与证据
        </Link>
      </div>
      {recoveryNotice ? (
        <p className="analysis-message success" role="status">
          {recoveryNotice}
        </p>
      ) : null}
      <label>
        <span>动作标题</span>
        <input
          value={title}
          disabled={fieldsLocked}
          maxLength={300}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>动作说明</span>
        <textarea
          value={description}
          disabled={fieldsLocked}
          maxLength={5_000}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </label>
      <div className="proposal-fields">
        <label>
          <span>责任人</span>
          <select
            aria-label="责任人"
            value={ownerId}
            disabled={fieldsLocked}
            onChange={(event) => setOwnerId(event.currentTarget.value)}
          >
            <option value="">请选择责任人</option>
            {ownerOptions.map((owner) => (
              <option value={owner.userId} key={owner.userId}>
                {owner.displayName}
                {owner.userId === actor.userId ? "（当前用户）" : ""}
              </option>
            ))}
          </select>
          <small>标识：{ownerId || "尚未选择"}</small>
          {suggestedOwnerUnavailable ? (
            <small className="field-warning">
              {hasMoreOwners
                ? `建议负责人“${proposal.suggestedOwnerName ?? "未知用户"}”尚未载入；可继续加载负责人。`
                : `建议负责人“${proposal.suggestedOwnerName ?? "未知用户"}”当前不可用；请选择仍为 active 的负责人。`}
            </small>
          ) : null}
          {currentActorUnavailable ? (
            <small className="field-warning">
              当前用户“{actor.displayName}”不在 active
              负责人目录中，不能被提交为责任人。
            </small>
          ) : null}
          {hasMoreOwners ? (
            <button
              type="button"
              className="text-button"
              disabled={fieldsLocked || isLoadingMoreOwners}
              onClick={() => void onLoadMoreOwners()}
            >
              {isLoadingMoreOwners ? "正在加载负责人…" : "加载更多负责人"}
            </button>
          ) : null}
        </label>
        <label>
          <span>优先级</span>
          <select
            value={priority}
            disabled={fieldsLocked}
            onChange={(event) =>
              setPriority(event.currentTarget.value as Priority)
            }
          >
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
            <option value="urgent">紧急</option>
          </select>
        </label>
        <div className="planned-field">
          <label>
            <span>计划时间</span>
            <input
              type="datetime-local"
              value={plannedAt}
              disabled={fieldsLocked}
              onChange={(event) => setPlannedAt(event.currentTarget.value)}
            />
          </label>
          {!plannedAt ? (
            <button
              type="button"
              className="text-button"
              disabled={fieldsLocked}
              onClick={() => setPlannedAt(tomorrowMorning())}
            >
              设为明日 09:00
            </button>
          ) : null}
        </div>
      </div>
      <p className="source-boundary">
        有效期至 {formatDateTime(proposal.expiresAt)}
        。创建后才进入正式动作列表；本阶段不宣称提醒已开启。
      </p>
      {error ? (
        <div className="decision-error" role="alert">
          <span>{error}</span>
          <button type="button" className="text-button" onClick={recover}>
            读取最新版本
          </button>
        </div>
      ) : null}
      {rejecting ? (
        <div className="reject-panel">
          <label>
            <span>拒绝原因</span>
            <textarea
              value={rejectionReason}
              disabled={fieldsLocked}
              maxLength={1_000}
              onChange={(event) =>
                setRejectionReason(event.currentTarget.value)
              }
            />
          </label>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={fieldsLocked}
              onClick={() => setRejecting(false)}
            >
              返回编辑
            </button>
            <button
              type="button"
              className="danger-action"
              disabled={
                isSubmitting ||
                (rejectAttempt === null && !rejectionReason.trim())
              }
              onClick={reject}
            >
              确认拒绝
            </button>
          </div>
        </div>
      ) : (
        <div className="decision-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={fieldsLocked}
            onClick={() => setRejecting(true)}
          >
            拒绝建议
          </button>
          <button type="button" disabled={!canAccept} onClick={accept}>
            创建经营动作
          </button>
        </div>
      )}
    </article>
  );
}

function FormalActionList({
  actions,
  api,
  highlightedActionId,
  onChange,
  nextCursor,
  isLoadingMore,
  onLoadMore,
}: {
  actions: BusinessActionRecord[];
  api: ActionWorkspaceApi;
  highlightedActionId: string | null;
  onChange(value: ActionTransitionResponse): void;
  nextCursor: string | null;
  isLoadingMore: boolean;
  onLoadMore(): Promise<void>;
}) {
  return (
    <section
      className="formal-actions"
      aria-labelledby="formal-action-title"
      aria-label="正式经营动作"
    >
      <div className="section-heading-inline">
        <div>
          <p className="eyebrow">FORMAL OPERATIONS</p>
          <h2 id="formal-action-title">正式经营动作</h2>
        </div>
        <span>{actions.length} 条已确认动作</span>
      </div>
      {actions.length === 0 ? (
        <div className="action-empty">
          <span aria-hidden="true">○</span>
          <div>
            <strong>暂时没有正式动作</strong>
            <p>接受一条建议后，正式动作会出现在这里。</p>
          </div>
        </div>
      ) : (
        <div className="formal-action-list">
          {actions.map((action) => (
            <FormalActionCard
              action={action}
              api={api}
              isTarget={action.actionId === highlightedActionId}
              key={action.actionId}
              onChange={onChange}
            />
          ))}
        </div>
      )}
      {nextCursor ? (
        <div className="battle-load-more">
          <button type="button" disabled={isLoadingMore} onClick={onLoadMore}>
            {isLoadingMore ? "正在加载…" : "加载更多正式动作"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function FormalActionCard({
  action,
  api,
  isTarget,
  onChange,
}: {
  action: BusinessActionRecord;
  api: ActionWorkspaceApi;
  isTarget: boolean;
  onChange(value: ActionTransitionResponse): void;
}) {
  const [isChanging, setIsChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!isTarget) return;
    cardRef.current?.focus({ preventScroll: true });
    cardRef.current?.scrollIntoView?.({ block: "center" });
  }, [isTarget]);
  async function transition(
    toStatus: "in_progress" | "completed" | "cancelled",
  ) {
    if (!action.canTransition) return;
    setIsChanging(true);
    setError(null);
    try {
      onChange(
        await api.transitionAction(action.actionId, {
          versionNo: action.versionNo,
          toStatus,
        }),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsChanging(false);
    }
  }
  return (
    <article
      ref={cardRef}
      className={`formal-action-card${isTarget ? " is-deep-link-target" : ""}`}
      aria-label={`${action.title}${isTarget ? "（工作台定位）" : ""}`}
      tabIndex={isTarget ? -1 : undefined}
    >
      <div className="formal-action-title">
        <span className={`action-status ${action.status}`}>
          {statusLabel(action.status)}
        </span>
        <span className={`priority ${action.priority}`}>
          {priorityLabel(action.priority)}
        </span>
        {isTarget ? (
          <span className="action-deep-link-target">
            已从工作台定位到此动作
          </span>
        ) : null}
      </div>
      <p className="formal-action-entity">{action.entityName}</p>
      <h3>{action.title}</h3>
      <p>{action.description}</p>
      <dl>
        <div>
          <dt>责任人</dt>
          <dd>
            {action.ownerName}
            <small>{action.ownerUserId}</small>
          </dd>
        </div>
        <div>
          <dt>计划时间</dt>
          <dd>{formatDateTime(action.plannedAt)}</dd>
        </div>
        <div>
          <dt>来源建议</dt>
          <dd>
            已确认建议
            <small>{action.sourceProposalId}</small>
          </dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>v{action.versionNo}</dd>
        </div>
      </dl>
      {error ? (
        <p className="decision-error" role="alert">
          {error}
        </p>
      ) : null}
      {action.canTransition ? (
        <div className="formal-action-buttons">
          {action.status === "planned" ? (
            <button
              type="button"
              disabled={isChanging}
              onClick={() => transition("in_progress")}
            >
              开始执行
            </button>
          ) : null}
          {action.status === "in_progress" ? (
            <button
              type="button"
              disabled={isChanging}
              onClick={() => transition("completed")}
            >
              标记完成
            </button>
          ) : null}
          {action.status === "planned" || action.status === "in_progress" ? (
            <button
              type="button"
              className="secondary-button"
              disabled={isChanging}
              onClick={() => transition("cancelled")}
            >
              取消动作
            </button>
          ) : null}
        </div>
      ) : (
        <p className="source-boundary" role="status">
          仅可查看，动作状态由当前负责人维护。
        </p>
      )}
    </article>
  );
}

function operationKey(kind: "accept" | "reject"): string {
  return `${kind}-${crypto.randomUUID()}`;
}

function tomorrowMorning(): string {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  value.setHours(9, 0, 0, 0);
  const localOffset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - localOffset).toISOString().slice(0, 16);
}

function priorityLabel(value: Priority): string {
  return { low: "低优先", medium: "中优先", high: "高优先", urgent: "紧急" }[
    value
  ];
}

function statusLabel(value: BusinessActionRecord["status"]): string {
  return {
    planned: "待开始",
    in_progress: "执行中",
    completed: "已完成",
    cancelled: "已取消",
  }[value];
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

function actionsWithTargetFirst(
  actions: BusinessActionRecord[],
  target: BusinessActionRecord | null,
): BusinessActionRecord[] {
  if (!target) return actions;
  return [
    target,
    ...actions.filter((item) => item.actionId !== target.actionId),
  ];
}

function initialActiveOwnerId(
  actor: ActionActor,
  owners: ActionOwnerOption[],
  proposal: ActionProposalRecord,
): string {
  if (
    proposal.suggestedOwnerId &&
    owners.some((owner) => owner.userId === proposal.suggestedOwnerId)
  ) {
    return proposal.suggestedOwnerId;
  }
  return owners.some((owner) => owner.userId === actor.userId)
    ? actor.userId
    : "";
}
