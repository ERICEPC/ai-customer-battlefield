import { describe, expect, it } from "vitest";

import {
  confirmFollowupDraftRequestSchema,
  createFollowupDraftRequestSchema,
  followupAgentExecutionSchema,
  followupApiErrorSchema,
  followupAutomationStatusSchema,
  followupConfirmationResponseSchema,
  followupDraftCandidateSchema,
  followupDraftResponseSchema,
  idempotencyKeySchema,
  reviseFollowupDraftRequestSchema,
} from "./followup-draft.js";

const entityId = "50000000-0000-4000-8000-000000000001";
const opportunityId = "60000000-0000-4000-8000-000000000001";

const candidate = {
  entityId,
  summary: "客户已确认本年度预算范围",
  occurredAt: "2026-08-31T02:30:00.000Z",
  followupType: "meeting" as const,
  relatedOpportunityIds: [opportunityId],
  primaryOpportunityId: opportunityId,
  facts: [{ factType: "budget_status", factValue: "预算范围已确认" }],
};

describe("createFollowupDraftRequestSchema", () => {
  it("requires a UUID business entity and meaningful raw input", () => {
    expect(
      createFollowupDraftRequestSchema.safeParse({ entityId, rawInput: "" })
        .success,
    ).toBe(false);
    expect(
      createFollowupDraftRequestSchema.safeParse({
        entityId: "entity-from-client",
        rawInput: "客户确认预算",
      }).success,
    ).toBe(false);
  });

  it("trims input and accepts an optional ISO occurrence time", () => {
    expect(
      createFollowupDraftRequestSchema.parse({
        entityId,
        rawInput: "  客户确认预算  ",
        occurredAt: "2026-08-31T02:30:00.000Z",
      }),
    ).toEqual({
      entityId,
      rawInput: "客户确认预算",
      occurredAt: "2026-08-31T02:30:00.000Z",
    });
  });

  it("rejects fields outside the public request contract", () => {
    expect(
      createFollowupDraftRequestSchema.safeParse({
        entityId,
        rawInput: "客户确认预算",
        tenantId: "tenant-from-client",
      }).success,
    ).toBe(false);
  });
});

describe("followupDraftCandidateSchema", () => {
  it("accepts structured, searchable candidate facts", () => {
    expect(followupDraftCandidateSchema.parse(candidate)).toEqual(candidate);
  });

  it("requires the primary opportunity to be related", () => {
    expect(
      followupDraftCandidateSchema.safeParse({
        ...candidate,
        primaryOpportunityId: "60000000-0000-4000-8000-000000000002",
      }).success,
    ).toBe(false);
  });

  it("requires a primary opportunity when several are related", () => {
    expect(
      followupDraftCandidateSchema.safeParse({
        ...candidate,
        relatedOpportunityIds: [
          opportunityId,
          "60000000-0000-4000-8000-000000000002",
        ],
        primaryOpportunityId: null,
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate opportunity links and unknown fact fields", () => {
    expect(
      followupDraftCandidateSchema.safeParse({
        ...candidate,
        relatedOpportunityIds: [opportunityId, opportunityId],
      }).success,
    ).toBe(false);
    expect(
      followupDraftCandidateSchema.safeParse({
        ...candidate,
        facts: [{ factType: "budget", factValue: "confirmed", score: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("draft mutation contracts", () => {
  it("requires an optimistic version for revision and confirmation", () => {
    expect(
      reviseFollowupDraftRequestSchema.parse({ versionNo: "2", candidate }),
    ).toEqual({ versionNo: "2", candidate });
    expect(
      reviseFollowupDraftRequestSchema.safeParse({ candidate }).success,
    ).toBe(false);
    expect(confirmFollowupDraftRequestSchema.parse({ versionNo: "3" })).toEqual(
      { versionNo: "3" },
    );
  });

  it("accepts bounded idempotency keys and rejects unsafe values", () => {
    expect(idempotencyKeySchema.parse("confirm-draft-20260831-001")).toBe(
      "confirm-draft-20260831-001",
    );
    expect(idempotencyKeySchema.safeParse(" spaces are unsafe ").success).toBe(
      false,
    );
    expect(idempotencyKeySchema.safeParse("x".repeat(201)).success).toBe(false);
  });
});

describe("follow-up draft responses", () => {
  it("accepts a versioned pending draft and rejects unknown fields", () => {
    const draft = {
      draftId: "70000000-0000-4000-8000-000000000001",
      status: "pending_confirmation" as const,
      rawInput: "客户确认预算",
      candidate,
      versionNo: "1",
      createdAt: "2026-08-31T02:30:00.000Z",
      updatedAt: "2026-08-31T02:30:00.000Z",
      expiresAt: "2026-09-07T02:30:00.000Z",
      confirmedAt: null,
      confirmedBy: null,
      cancelledAt: null,
      followupId: null,
    };

    expect(followupDraftResponseSchema.parse(draft)).toEqual(draft);
    expect(
      followupDraftResponseSchema.safeParse({ ...draft, internalPayload: {} })
        .success,
    ).toBe(false);
  });

  it("requires formal identifiers for a confirmed terminal response", () => {
    const response = {
      draftId: "70000000-0000-4000-8000-000000000001",
      status: "confirmed" as const,
      followupId: "80000000-0000-4000-8000-000000000001",
      eventId: "90000000-0000-4000-8000-000000000001",
      versionNo: "2",
      confirmedAt: "2026-08-31T02:35:00.000Z",
    };

    expect(followupConfirmationResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(
      followupConfirmationResponseSchema.safeParse({
        ...response,
        followupId: null,
      }).success,
    ).toBe(false);
  });

  it("accepts a visible completed follow-up automation receipt", () => {
    expect(
      followupAutomationStatusSchema.parse({
        eventId: "90000000-0000-4000-8000-000000000001",
        followupId: "80000000-0000-4000-8000-000000000001",
        overallStatus: "completed",
        battleMapStatus: "completed",
        leaderNotificationStatus: "completed",
        outboxStatus: "published",
        outboxMessageId: "a0000000-0000-4000-8000-000000000001",
        analysisRunId: "c0000000-0000-4000-8000-000000000001",
        battleStateVersionId: "b0000000-0000-4000-8000-000000000001",
        leaderNotificationIds: ["d0000000-0000-4000-8000-000000000001"],
        leaderNotificationCount: 1,
        attemptCount: 1,
        errorMessage: null,
        updatedAt: "2026-09-01T03:00:00.000Z",
      }),
    ).toMatchObject({
      overallStatus: "completed",
      analysisRunId: "c0000000-0000-4000-8000-000000000001",
      leaderNotificationCount: 1,
    });
  });
});

describe("followupApiErrorSchema", () => {
  it("accepts a safe Agent-unavailable error for visible retry guidance", () => {
    expect(
      followupApiErrorSchema.parse({
        code: "AGENT_UNAVAILABLE",
        message: "AI 拆解服务暂时不可用，请稍后重试。你的输入尚未入库。",
        requestId: "request-agent-001",
      }),
    ).toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });
});

describe("followupAgentExecutionSchema", () => {
  it("accepts a bounded successful model receipt", () => {
    expect(
      followupAgentExecutionSchema.parse({
        provider: "senseaudio",
        model: "senseaudio-s2-flash",
        promptVersion: "followup-extraction-v1",
        status: "succeeded",
        providerRequestId: "resp-demo",
        durationMs: 1234,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    ).toMatchObject({
      model: "senseaudio-s2-flash",
      promptVersion: "followup-extraction-v1",
      status: "succeeded",
    });
  });
});
