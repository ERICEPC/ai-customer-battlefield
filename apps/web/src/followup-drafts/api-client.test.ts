import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelFollowupDraft,
  confirmFollowupDraft,
  createFollowupDraft,
  getFollowupDraft,
  getFormalFollowup,
  reviseFollowupDraft,
} from "./api-client";

const entityId = "50000000-0000-4000-8000-000000000001";
const draftId = "70000000-0000-4000-8000-000000000001";
const followupId = "80000000-0000-4000-8000-000000000001";
const actorId = "30000000-0000-4000-8000-000000000001";

const candidate = {
  entityId,
  summary: "客户确认预算",
  occurredAt: "2026-08-31T02:30:00.000Z",
  followupType: "other" as const,
  relatedOpportunityIds: [],
  primaryOpportunityId: null,
  facts: [],
};

const pendingDraft = {
  draftId,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("follow-up API client", () => {
  it("uses the versioned create, read, and revise routes with actor headers", async () => {
    const revised = {
      ...pendingDraft,
      candidate: { ...candidate, summary: "客户预算已经确认" },
      versionNo: "2",
      updatedAt: "2026-08-31T02:31:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pendingDraft))
      .mockResolvedValueOnce(jsonResponse(pendingDraft))
      .mockResolvedValueOnce(jsonResponse(revised));
    vi.stubGlobal("fetch", fetchMock);

    await createFollowupDraft({ entityId, rawInput: " 客户确认预算 " });
    await getFollowupDraft(draftId);
    await reviseFollowupDraft(draftId, {
      versionNo: "1",
      candidate: revised.candidate,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/v1/followup-drafts",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "content-type": "application/json",
        "x-tenant-id": "10000000-0000-4000-8000-000000000001",
        "x-user-id": actorId,
      }),
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://localhost:3001/api/v1/followup-drafts/${draftId}`,
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "PATCH" });
  });

  it("sends explicit idempotency keys for cancel and confirm", async () => {
    const cancelled = {
      ...pendingDraft,
      status: "cancelled" as const,
      versionNo: "2",
      updatedAt: "2026-08-31T02:32:00.000Z",
      cancelledAt: "2026-08-31T02:32:00.000Z",
    };
    const confirmation = {
      draftId,
      status: "confirmed" as const,
      followupId,
      eventId: "90000000-0000-4000-8000-000000000001",
      versionNo: "2",
      confirmedAt: "2026-08-31T02:35:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cancelled))
      .mockResolvedValueOnce(jsonResponse(confirmation));
    vi.stubGlobal("fetch", fetchMock);

    await cancelFollowupDraft(draftId, { versionNo: "1" }, "cancel-key-1");
    await confirmFollowupDraft(draftId, { versionNo: "2" }, "confirm-key-1");

    expect(fetchMock.mock.calls[0]?.[0]).toContain(`/${draftId}/cancel`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "idempotency-key": "cancel-key-1" }),
    });
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`/${draftId}/confirm`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "idempotency-key": "confirm-key-1" }),
    });
  });

  it("retrieves and validates the immutable formal follow-up", async () => {
    const formalFollowup = {
      followupId,
      sourceDraftId: draftId,
      entityId,
      occurredAt: candidate.occurredAt,
      followupType: candidate.followupType,
      summary: candidate.summary,
      submittedBy: actorId,
      confirmedBy: actorId,
      confirmedAt: "2026-08-31T02:35:00.000Z",
      relatedOpportunityIds: [],
      primaryOpportunityId: null,
      facts: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(formalFollowup));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFormalFollowup(followupId)).resolves.toEqual(
      formalFollowup,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://localhost:3001/api/v1/followups/${followupId}`,
    );
  });

  it("preserves stable API error codes for conflict recovery", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: "DRAFT_VERSION_CONFLICT",
          message: "草稿已被其他操作更新。",
          requestId: "request-001",
          issues: [{ path: "versionNo", reason: "expected 2, received 1" }],
        },
        409,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFollowupDraft(draftId)).rejects.toMatchObject({
      status: 409,
      code: "DRAFT_VERSION_CONFLICT",
      message: "草稿已被其他操作更新。",
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
