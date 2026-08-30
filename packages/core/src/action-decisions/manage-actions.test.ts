import { describe, expect, it, vi } from "vitest";

import {
  type ActionDecisionStore,
  ActionProposalExpiredError,
  ActionProposalNotPendingError,
  ActionProposalVersionConflictError,
} from "./action-decision-store.js";
import {
  AcceptActionProposal,
  InvalidActionDecisionError,
  InvalidActionIdempotencyKeyError,
  isAllowedActionTransition,
  RejectActionProposal,
  TransitionBusinessAction,
} from "./manage-actions.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const ownerUserId = "30000000-0000-4000-8000-000000000002";
const proposalId = "c0000000-0000-4000-8000-000000000001";
const actionId = "d0000000-0000-4000-8000-000000000001";
const decidedAt = new Date("2026-08-31T03:05:00.000Z");

function store(overrides: Partial<ActionDecisionStore> = {}) {
  return {
    accept: vi.fn().mockResolvedValue({
      proposalId,
      status: "accepted",
      actionId,
      versionNo: "2",
      decidedAt: decidedAt.toISOString(),
    }),
    reject: vi.fn().mockResolvedValue({
      proposalId,
      status: "rejected",
      actionId: null,
      versionNo: "2",
      decidedAt: decidedAt.toISOString(),
    }),
    transition: vi.fn().mockResolvedValue({
      actionId,
      status: "in_progress",
      versionNo: "2",
      changedAt: decidedAt.toISOString(),
    }),
    ...overrides,
  } satisfies ActionDecisionStore;
}

describe("action proposal decisions", () => {
  it("normalizes an acceptance and invokes one deep transaction port", async () => {
    const persistence = store();
    const subject = new AcceptActionProposal({
      store: persistence,
      idGenerator: { next: () => actionId },
      clock: { now: () => decidedAt },
    });

    await subject.execute({
      actor,
      proposalId,
      versionNo: "1",
      idempotencyKey: "accept-proposal-001",
      title: "  提交正式解决方案  ",
      description: "  包含安全方案与实施排期。  ",
      ownerUserId,
      priority: "urgent",
      plannedAt: "2026-09-03T09:00:00.000Z",
    });

    expect(persistence.accept).toHaveBeenCalledWith({
      actor,
      proposalId,
      actionId,
      versionNo: "1",
      idempotencyKey: "accept-proposal-001",
      title: "提交正式解决方案",
      description: "包含安全方案与实施排期。",
      ownerUserId,
      priority: "urgent",
      plannedAt: "2026-09-03T09:00:00.000Z",
      decidedAt: decidedAt.toISOString(),
    });
  });

  it("rejects incomplete or non-future acceptance before persistence", async () => {
    const persistence = store();
    const subject = new AcceptActionProposal({
      store: persistence,
      idGenerator: { next: () => actionId },
      clock: { now: () => decidedAt },
    });

    await expect(
      subject.execute({
        actor,
        proposalId,
        versionNo: "1",
        idempotencyKey: "accept-proposal-001",
        title: "  ",
        description: "说明",
        ownerUserId,
        priority: "high",
        plannedAt: decidedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(InvalidActionDecisionError);
    expect(persistence.accept).not.toHaveBeenCalled();
  });

  it("runtime-validates priority instead of trusting the caller's TypeScript type", async () => {
    const persistence = store();
    const subject = new AcceptActionProposal({
      store: persistence,
      idGenerator: { next: () => actionId },
      clock: { now: () => decidedAt },
    });

    await expect(
      subject.execute({
        actor,
        proposalId,
        versionNo: "1",
        idempotencyKey: "accept-proposal-001",
        title: "提交方案",
        description: "补充实施排期",
        ownerUserId,
        priority: "blocker" as "high",
        plannedAt: "2026-09-03T09:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(InvalidActionDecisionError);
    expect(persistence.accept).not.toHaveBeenCalled();
  });

  it("requires and normalizes a rejection reason", async () => {
    const persistence = store();
    const subject = new RejectActionProposal({
      store: persistence,
      clock: { now: () => decidedAt },
    });

    await subject.execute({
      actor,
      proposalId,
      versionNo: "1",
      idempotencyKey: "reject-proposal-001",
      reason: "  客户已取消需求  ",
    });
    expect(persistence.reject).toHaveBeenCalledWith({
      actor,
      proposalId,
      versionNo: "1",
      idempotencyKey: "reject-proposal-001",
      reason: "客户已取消需求",
      decidedAt: decidedAt.toISOString(),
    });
  });

  it("rejects unsafe idempotency keys before acceptance or rejection", async () => {
    const persistence = store();
    const subject = new RejectActionProposal({
      store: persistence,
      clock: { now: () => decidedAt },
    });

    await expect(
      subject.execute({
        actor,
        proposalId,
        versionNo: "1",
        idempotencyKey: "unsafe key",
        reason: "不再需要",
      }),
    ).rejects.toBeInstanceOf(InvalidActionIdempotencyKeyError);
    expect(persistence.reject).not.toHaveBeenCalled();
  });

  it.each([
    new ActionProposalExpiredError(),
    new ActionProposalVersionConflictError("2"),
    new ActionProposalNotPendingError("accepted"),
  ])("preserves typed store decision failures: $name", async (failure) => {
    const persistence = store({
      accept: vi.fn().mockRejectedValue(failure),
    });
    const subject = new AcceptActionProposal({
      store: persistence,
      idGenerator: { next: () => actionId },
      clock: { now: () => decidedAt },
    });

    await expect(
      subject.execute({
        actor,
        proposalId,
        versionNo: "1",
        idempotencyKey: "accept-proposal-001",
        title: "提交方案",
        description: "补充实施排期",
        ownerUserId,
        priority: "high",
        plannedAt: "2026-09-03T09:00:00.000Z",
      }),
    ).rejects.toBe(failure);
  });
});

describe("formal action transitions", () => {
  it("defines the forward-only action state machine", () => {
    expect(isAllowedActionTransition("planned", "in_progress")).toBe(true);
    expect(isAllowedActionTransition("planned", "cancelled")).toBe(true);
    expect(isAllowedActionTransition("in_progress", "completed")).toBe(true);
    expect(isAllowedActionTransition("in_progress", "cancelled")).toBe(true);
    expect(isAllowedActionTransition("completed", "planned")).toBe(false);
    expect(isAllowedActionTransition("cancelled", "in_progress")).toBe(false);
    expect(isAllowedActionTransition("planned", "completed")).toBe(false);
  });

  it("passes an optimistic transition through one deep port", async () => {
    const persistence = store();
    const subject = new TransitionBusinessAction({
      store: persistence,
      clock: { now: () => decidedAt },
    });

    await subject.execute({
      actor,
      actionId,
      versionNo: "1",
      toStatus: "in_progress",
      reason: "  已开始准备材料  ",
    });
    expect(persistence.transition).toHaveBeenCalledWith({
      actor,
      actionId,
      versionNo: "1",
      toStatus: "in_progress",
      reason: "已开始准备材料",
      changedAt: decidedAt.toISOString(),
    });
  });
});
