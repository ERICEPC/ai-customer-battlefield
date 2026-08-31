import type { WorkspaceSnapshot } from "@battlefield/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { getWorkspaceSnapshot, WorkspaceApiError } from "./api-client";

const snapshot: WorkspaceSnapshot = {
  generatedAt: "2026-09-01T00:00:00.000Z",
  scopeMode: "personal",
  kpis: {
    assignedEntityCount: 0,
    pendingDraftCount: 0,
    pendingProposalCount: 0,
    overdueActionCount: 0,
    unreadNotificationCount: 0,
    highRiskEntityCount: 0,
    dataIncompleteEntityCount: 0,
  },
  priorityActions: [],
  recentBattleChanges: [],
  quadrantDistribution: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace API client", () => {
  test("loads and validates the server-derived workspace snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWorkspaceSnapshot()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/v1/workspace",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  test("preserves stable workspace errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "WORKSPACE_UNAVAILABLE",
            message: "工作台服务暂不可用。",
            requestId: "request-workspace-1",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const error = await getWorkspaceSnapshot().catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect(error).toMatchObject({
      status: 503,
      code: "WORKSPACE_UNAVAILABLE",
      message: "工作台服务暂不可用。",
      requestId: "request-workspace-1",
    });
  });

  test("rejects a payload that violates the shared workspace contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...snapshot, unexpected: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(getWorkspaceSnapshot()).rejects.toThrow();
  });
});
