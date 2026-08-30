import { describe, expect, it, vi } from "vitest";
import type {
  FollowupConfirmationStore,
  PersistentFollowupDraft,
} from "./followup-confirmation-store.js";
import {
  ConfirmFollowupDraft,
  CreatePersistentFollowupDraft,
  InvalidIdempotencyKeyError,
  ReviseFollowupDraft,
} from "./manage-followup-drafts.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const entityId = "50000000-0000-4000-8000-000000000001";
const draftId = "70000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-31T02:30:00.000Z");

function pendingDraft(): PersistentFollowupDraft {
  return {
    draftId,
    status: "pending_confirmation",
    rawInput: "客户确认预算",
    candidate: {
      entityId,
      summary: "客户确认预算",
      occurredAt: now.toISOString(),
      followupType: "other",
      relatedOpportunityIds: [],
      primaryOpportunityId: null,
      facts: [],
    },
    versionNo: "1",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: "2026-09-07T02:30:00.000Z",
    confirmedAt: null,
    confirmedBy: null,
    cancelledAt: null,
    followupId: null,
  };
}

function store(overrides: Partial<FollowupConfirmationStore> = {}) {
  return {
    create: vi.fn().mockResolvedValue(pendingDraft()),
    get: vi.fn().mockResolvedValue(pendingDraft()),
    revise: vi.fn().mockResolvedValue({ ...pendingDraft(), versionNo: "2" }),
    cancel: vi.fn().mockResolvedValue({
      ...pendingDraft(),
      status: "cancelled",
      versionNo: "2",
      cancelledAt: now.toISOString(),
    }),
    confirm: vi.fn().mockResolvedValue({
      draftId,
      status: "confirmed",
      followupId: "80000000-0000-4000-8000-000000000001",
      eventId: "90000000-0000-4000-8000-000000000001",
      versionNo: "2",
      confirmedAt: now.toISOString(),
    }),
    ...overrides,
  } satisfies FollowupConfirmationStore;
}

describe("CreatePersistentFollowupDraft", () => {
  it("invokes the Agent before persisting a normalized candidate", async () => {
    const persistence = store();
    const propose = vi.fn().mockResolvedValue({
      summary: "  客户确认预算  ",
      relatedOpportunityIds: [],
      primaryOpportunityId: null,
      facts: [],
    });
    const useCase = new CreatePersistentFollowupDraft({
      agent: { propose },
      store: persistence,
      idGenerator: { next: () => draftId },
      clock: { now: () => now },
    });

    const result = await useCase.execute({
      actor,
      entityId,
      rawInput: "  客户确认预算  ",
    });

    expect(propose).toHaveBeenCalledWith({
      actor,
      entityId,
      rawInput: "客户确认预算",
      occurredAt: now.toISOString(),
    });
    expect(persistence.create).toHaveBeenCalledWith({
      actor,
      draftId,
      rawInput: "客户确认预算",
      candidate: pendingDraft().candidate,
      createdAt: now.toISOString(),
      expiresAt: "2026-09-07T02:30:00.000Z",
    });
    expect(propose.mock.invocationCallOrder[0]).toBeLessThan(
      persistence.create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result).toEqual(pendingDraft());
  });

  it("does not persist anything when the Agent fails", async () => {
    const persistence = store();
    const useCase = new CreatePersistentFollowupDraft({
      agent: { propose: vi.fn().mockRejectedValue(new Error("model failed")) },
      store: persistence,
      idGenerator: { next: () => draftId },
      clock: { now: () => now },
    });

    await expect(
      useCase.execute({ actor, entityId, rawInput: "客户确认预算" }),
    ).rejects.toThrow("model failed");
    expect(persistence.create).not.toHaveBeenCalled();
  });
});

describe("draft mutation use cases", () => {
  it("passes a complete candidate and expected version through one deep port", async () => {
    const persistence = store();
    const useCase = new ReviseFollowupDraft(persistence);
    const candidate = pendingDraft().candidate;

    await useCase.execute({
      actor,
      draftId,
      versionNo: "1",
      candidate,
      changedAt: now.toISOString(),
    });

    expect(persistence.revise).toHaveBeenCalledWith({
      actor,
      draftId,
      versionNo: "1",
      candidate,
      changedAt: now.toISOString(),
    });
  });

  it("rejects an unsafe idempotency key before opening persistence", async () => {
    const persistence = store();
    const useCase = new ConfirmFollowupDraft(persistence);

    await expect(
      useCase.execute({
        actor,
        draftId,
        versionNo: "1",
        idempotencyKey: " unsafe key ",
        confirmedAt: now.toISOString(),
      }),
    ).rejects.toBeInstanceOf(InvalidIdempotencyKeyError);
    expect(persistence.confirm).not.toHaveBeenCalled();
  });

  it("preserves typed store conflicts for the transport adapter", async () => {
    const conflict = new Error("version conflict");
    const persistence = store({ confirm: vi.fn().mockRejectedValue(conflict) });
    const useCase = new ConfirmFollowupDraft(persistence);

    await expect(
      useCase.execute({
        actor,
        draftId,
        versionNo: "1",
        idempotencyKey: "confirm-draft-001",
        confirmedAt: now.toISOString(),
      }),
    ).rejects.toBe(conflict);
  });
});
