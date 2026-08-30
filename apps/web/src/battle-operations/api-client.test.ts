import type {
  ActionDecisionResponse,
  BattleMapPage,
} from "@battlefield/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptActionProposal,
  BattleOperationsApiError,
  listBattleMap,
} from "./api-client";

const entityId = "50000000-0000-4000-8000-000000000001";
const proposalId = "c0000000-0000-4000-8000-000000000001";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("battle operations API client", () => {
  it("serializes map filters and validates the response", async () => {
    const page: BattleMapPage = { items: [], nextCursor: null };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listBattleMap({ isT0: true, dataSufficiency: "partial", limit: 40 }),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/v1/battle-map?isT0=true&dataSufficiency=partial&limit=40",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("sends a stable caller-provided idempotency key when accepting", async () => {
    const response: ActionDecisionResponse = {
      proposalId,
      status: "accepted",
      actionId: "d0000000-0000-4000-8000-000000000001",
      versionNo: "2",
      decidedAt: "2026-08-31T06:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await acceptActionProposal(
      proposalId,
      {
        versionNo: "1",
        title: "提交正式方案",
        description: "附上安全与交付计划。",
        ownerUserId: "30000000-0000-4000-8000-000000000001",
        priority: "high",
        plannedAt: "2026-09-03T09:00:00.000Z",
      },
      "accept-stable-001",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3001/api/v1/action-proposals/${proposalId}/accept`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "idempotency-key": "accept-stable-001",
        }),
      }),
    );
  });

  it("preserves stable API errors without exposing arbitrary response text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "ANALYSIS_INPUT_STALE",
            message: "经营事实已更新，请重新计算。",
            requestId: "request-001",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const error = await listBattleMap({ limit: 20 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BattleOperationsApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "ANALYSIS_INPUT_STALE",
      message: "经营事实已更新，请重新计算。",
    });
    expect(String(error)).not.toContain(entityId);
  });
});
