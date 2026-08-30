import { describe, expect, it } from "vitest";

import {
  createFollowupDraftRequestSchema,
  followupDraftResponseSchema,
} from "./followup-draft.js";

describe("createFollowupDraftRequestSchema", () => {
  it("rejects an empty raw follow-up input", () => {
    expect(
      createFollowupDraftRequestSchema.safeParse({ rawInput: "" }).success,
    ).toBe(false);
  });

  it("accepts and trims a meaningful raw follow-up input", () => {
    const result = createFollowupDraftRequestSchema.parse({
      rawInput: "  客户确认预算  ",
    });

    expect(result).toEqual({ rawInput: "客户确认预算" });
  });

  it("rejects fields outside the public request contract", () => {
    expect(
      createFollowupDraftRequestSchema.safeParse({
        rawInput: "客户确认预算",
        tenantId: "tenant-from-client",
      }).success,
    ).toBe(false);
  });
});

describe("followupDraftResponseSchema", () => {
  it("accepts only a human-confirmation-pending draft shape", () => {
    const validDraft = {
      draftId: "draft-001",
      status: "pending_confirmation",
      rawInput: "客户确认预算",
      candidate: {
        summary: "客户已确认本年度预算范围",
        relatedOpportunityIds: ["opportunity-001"],
      },
      createdAt: "2026-08-31T02:30:00.000Z",
    };

    expect(followupDraftResponseSchema.parse(validDraft)).toEqual(validDraft);
  });

  it("rejects an AI result presented as a committed business fact", () => {
    const result = followupDraftResponseSchema.safeParse({
      draftId: "draft-001",
      status: "confirmed",
      rawInput: "客户确认预算",
      candidate: {
        summary: "客户已确认本年度预算范围",
        relatedOpportunityIds: [],
      },
      createdAt: "2026-08-31T02:30:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});
