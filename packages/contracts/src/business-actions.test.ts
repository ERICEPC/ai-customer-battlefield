import { describe, expect, it } from "vitest";

import {
  acceptActionProposalRequestSchema,
  actionApiErrorSchema,
  actionDecisionResponseSchema,
  actionProposalListQuerySchema,
  actionProposalPageSchema,
  actionProposalRecordSchema,
  actionTransitionResponseSchema,
  businessActionListQuerySchema,
  businessActionPageSchema,
  businessActionRecordSchema,
  rejectActionProposalRequestSchema,
  transitionBusinessActionRequestSchema,
} from "./business-actions.js";

const entityId = "50000000-0000-4000-8000-000000000001";
const proposalId = "c0000000-0000-4000-8000-000000000001";
const stateId = "b0000000-0000-4000-8000-000000000001";
const actionId = "d0000000-0000-4000-8000-000000000001";
const actorId = "30000000-0000-4000-8000-000000000001";

function proposal() {
  return {
    proposalId,
    entityId,
    opportunityId: null,
    title: "提交解决方案",
    description: "按客户要求补充实施排期。",
    suggestedOwnerId: actorId,
    suggestedPriority: "high" as const,
    suggestedPlannedAt: "2026-09-03T09:00:00.000Z",
    sourceBattleStateVersionId: stateId,
    status: "pending_confirmation" as const,
    versionNo: "1",
    proposedAt: "2026-08-31T03:00:02.000Z",
    expiresAt: "2026-09-07T03:00:02.000Z",
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    actionId: null,
  };
}

describe("business action contracts", () => {
  it("validates a pending proposal with an explicit source", () => {
    expect(actionProposalRecordSchema.parse(proposal())).toEqual(proposal());
    expect(
      actionProposalRecordSchema.safeParse({
        ...proposal(),
        sourceBattleStateVersionId: null,
      }).success,
    ).toBe(false);
  });

  it("requires complete editable fields when accepting a proposal", () => {
    const request = {
      versionNo: "1",
      title: "提交正式解决方案",
      description: "包含安全方案与实施排期。",
      ownerUserId: actorId,
      priority: "urgent" as const,
      plannedAt: "2026-09-03T09:00:00.000Z",
    };
    expect(acceptActionProposalRequestSchema.parse(request)).toEqual(request);
    expect(
      acceptActionProposalRequestSchema.safeParse({
        ...request,
        ownerUserId: null,
      }).success,
    ).toBe(false);
    expect(
      acceptActionProposalRequestSchema.safeParse({ ...request, extra: true })
        .success,
    ).toBe(false);
  });

  it("requires a meaningful reason for rejection", () => {
    expect(
      rejectActionProposalRequestSchema.parse({
        versionNo: "1",
        reason: "客户已经取消该需求",
      }),
    ).toEqual({ versionNo: "1", reason: "客户已经取消该需求" });
    expect(
      rejectActionProposalRequestSchema.safeParse({
        versionNo: "1",
        reason: "   ",
      }).success,
    ).toBe(false);
  });

  it("keeps accepted and rejected receipts structurally distinct", () => {
    expect(
      actionDecisionResponseSchema.parse({
        proposalId,
        status: "accepted",
        actionId,
        versionNo: "2",
        decidedAt: "2026-08-31T03:05:00.000Z",
      }).actionId,
    ).toBe(actionId);
    expect(
      actionDecisionResponseSchema.safeParse({
        proposalId,
        status: "rejected",
        actionId,
        versionNo: "2",
        decidedAt: "2026-08-31T03:05:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates formal actions and optimistic transitions", () => {
    const action = {
      actionId,
      entityId,
      opportunityId: null,
      title: "提交正式解决方案",
      description: "包含安全方案与实施排期。",
      ownerUserId: actorId,
      priority: "urgent" as const,
      status: "planned" as const,
      plannedAt: "2026-09-03T09:00:00.000Z",
      completedAt: null,
      sourceProposalId: proposalId,
      confirmedBy: actorId,
      confirmedAt: "2026-08-31T03:05:00.000Z",
      versionNo: "1",
    };
    expect(businessActionRecordSchema.parse(action)).toEqual(action);
    expect(
      transitionBusinessActionRequestSchema.parse({
        versionNo: "1",
        toStatus: "in_progress",
        reason: "已开始准备材料",
      }),
    ).toEqual({
      versionNo: "1",
      toStatus: "in_progress",
      reason: "已开始准备材料",
    });
  });

  it("keeps proposal queue filters bounded and rejects unknown input", () => {
    expect(
      actionProposalListQuerySchema.parse({
        status: "pending_confirmation",
        priority: "high",
        limit: "50",
      }),
    ).toEqual({
      status: "pending_confirmation",
      priority: "high",
      limit: 50,
    });
    expect(
      actionProposalListQuerySchema.safeParse({ limit: 101 }).success,
    ).toBe(false);
    expect(
      actionProposalPageSchema.parse({ items: [proposal()], nextCursor: null })
        .items,
    ).toHaveLength(1);
    expect(
      businessActionListQuerySchema.parse({
        status: "planned",
        ownerUserId: actorId,
        limit: "20",
      }),
    ).toEqual({ status: "planned", ownerUserId: actorId, limit: 20 });
    expect(
      businessActionPageSchema.parse({
        items: [
          {
            actionId,
            entityId,
            opportunityId: null,
            title: "提交正式解决方案",
            description: "包含安全方案与实施排期。",
            ownerUserId: actorId,
            priority: "urgent",
            status: "planned",
            plannedAt: "2026-09-03T09:00:00.000Z",
            completedAt: null,
            sourceProposalId: proposalId,
            confirmedBy: actorId,
            confirmedAt: "2026-08-31T03:05:00.000Z",
            versionNo: "1",
          },
        ],
        nextCursor: null,
      }).items,
    ).toHaveLength(1);
    expect(
      actionTransitionResponseSchema.parse({
        actionId,
        status: "in_progress",
        versionNo: "2",
        changedAt: "2026-08-31T03:06:00.000Z",
      }).status,
    ).toBe("in_progress");
  });

  it("provides stable conflict codes without accepting arbitrary errors", () => {
    expect(
      actionApiErrorSchema.parse({
        code: "ACTION_PROPOSAL_VERSION_CONFLICT",
        message: "建议动作已被其他操作更新。",
        requestId: "request-001",
        issues: [{ path: "versionNo", reason: "expected 2, received 1" }],
      }).code,
    ).toBe("ACTION_PROPOSAL_VERSION_CONFLICT");
    expect(
      actionApiErrorSchema.safeParse({
        code: "SQL_ERROR",
        message: "leaked",
        requestId: "request-001",
      }).success,
    ).toBe(false);
  });
});
