import { describe, expect, it, vi } from "vitest";

import { CreateFollowupDraft } from "./create-followup-draft.js";
import { InvalidRawInputError } from "./errors.js";

const actor = {
  tenantId: "tenant-demo",
  userId: "user-demo",
};

describe("CreateFollowupDraft", () => {
  it("rejects whitespace-only input before invoking an Agent", async () => {
    const propose = vi.fn();
    const useCase = new CreateFollowupDraft({
      agent: { propose },
      idGenerator: { next: () => "draft-should-not-exist" },
      clock: { now: () => new Date("2026-08-31T02:30:00.000Z") },
    });

    await expect(
      useCase.execute({ actor, rawInput: "   " }),
    ).rejects.toBeInstanceOf(InvalidRawInputError);
    expect(propose).not.toHaveBeenCalled();
  });

  it("returns a deterministic pending-confirmation draft proposed in actor scope", async () => {
    const propose = vi.fn().mockResolvedValue({
      summary: "客户已确认预算，下一步提交方案",
      relatedOpportunityIds: ["opportunity-001"],
    });
    const useCase = new CreateFollowupDraft({
      agent: { propose },
      idGenerator: { next: () => "draft-001" },
      clock: { now: () => new Date("2026-08-31T02:30:00.000Z") },
    });

    const draft = await useCase.execute({
      actor,
      rawInput: "  客户确认预算，下一步提交方案  ",
    });

    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith({
      actor,
      rawInput: "客户确认预算，下一步提交方案",
    });
    expect(draft).toEqual({
      draftId: "draft-001",
      status: "pending_confirmation",
      rawInput: "客户确认预算，下一步提交方案",
      candidate: {
        summary: "客户已确认预算，下一步提交方案",
        relatedOpportunityIds: ["opportunity-001"],
      },
      createdAt: "2026-08-31T02:30:00.000Z",
    });
  });
});
