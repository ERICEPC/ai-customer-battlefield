import { describe, expect, it, vi } from "vitest";

import { CreateFollowupDraft } from "./create-followup-draft.js";
import { InvalidRawInputError } from "./errors.js";

const actor = {
  tenantId: "tenant-demo",
  userId: "user-demo",
};
const entityId = "50000000-0000-4000-8000-000000000001";

describe("CreateFollowupDraft", () => {
  it("rejects whitespace-only input before invoking an Agent", async () => {
    const propose = vi.fn();
    const useCase = new CreateFollowupDraft({
      agent: { propose },
      idGenerator: { next: () => "draft-should-not-exist" },
      clock: { now: () => new Date("2026-08-31T02:30:00.000Z") },
    });

    await expect(
      useCase.execute({ actor, entityId, rawInput: "   " }),
    ).rejects.toBeInstanceOf(InvalidRawInputError);
    expect(propose).not.toHaveBeenCalled();
  });

  it("returns a deterministic pending-confirmation draft proposed in actor scope", async () => {
    const propose = vi.fn().mockResolvedValue({
      summary: "客户已确认预算，下一步提交方案",
      followupType: "meeting",
      relatedOpportunityIds: ["opportunity-001"],
    });
    const useCase = new CreateFollowupDraft({
      agent: { propose },
      idGenerator: { next: () => "draft-001" },
      clock: { now: () => new Date("2026-08-31T02:30:00.000Z") },
    });

    const draft = await useCase.execute({
      actor,
      entityId,
      rawInput: "  客户确认预算，下一步提交方案  ",
    });

    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith({
      actor,
      entityId,
      rawInput: "客户确认预算，下一步提交方案",
      occurredAt: "2026-08-31T02:30:00.000Z",
    });
    expect(draft).toEqual({
      draftId: "draft-001",
      status: "pending_confirmation",
      rawInput: "客户确认预算，下一步提交方案",
      candidate: {
        entityId,
        summary: "客户已确认预算，下一步提交方案",
        occurredAt: "2026-08-31T02:30:00.000Z",
        followupType: "meeting",
        relatedOpportunityIds: ["opportunity-001"],
        primaryOpportunityId: null,
        facts: [],
      },
      versionNo: "1",
      createdAt: "2026-08-31T02:30:00.000Z",
      updatedAt: "2026-08-31T02:30:00.000Z",
      expiresAt: "2026-09-07T02:30:00.000Z",
      confirmedAt: null,
      confirmedBy: null,
      cancelledAt: null,
      followupId: null,
    });
  });
});
