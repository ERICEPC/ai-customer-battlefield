import type {
  ManagementQueryRequest,
  ManagementQueryResult,
  ManagementQuerySubjectPage,
} from "@battlefield/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  listManagementQuerySubjects,
  ManagementQueryApiError,
  runManagementQuery,
} from "./api-client";

const subjectPage: ManagementQuerySubjectPage = {
  items: [
    {
      userId: "30000000-0000-4000-8000-000000000001",
      displayName: "演示销售",
      scopeKind: "observed_portfolio",
    },
  ],
  nextCursor: null,
};
const query: ManagementQueryRequest = {
  capability: "sales_weekly_progress",
  subjectUserId: subjectPage.items[0]?.userId ?? "",
  periodStart: "2026-08-31T00:00:00.000Z",
  periodEnd: "2026-09-07T00:00:00.000Z",
};
const result: ManagementQueryResult = {
  queryId: "90000000-0000-4000-8000-000000000091",
  capability: "sales_weekly_progress",
  subject: {
    userId: query.subjectUserId,
    displayName: "演示销售",
  },
  period: { start: query.periodStart, end: query.periodEnd },
  dataCutoffAt: "2026-08-31T04:00:00.000Z",
  scope: { kind: "observed_portfolio", entityCount: 1 },
  metrics: {
    confirmedFollowupCount: 1,
    validFactCount: 1,
    stageChangeCount: 1,
    completedActionCount: 0,
    openActionCount: 1,
    overdueActionCount: 0,
  },
  highlights: [],
  dataGaps: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("management-query API client", () => {
  test("loads and validates the authorized subject directory", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(subjectPage), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listManagementQuerySubjects({ limit: 100 })).resolves.toEqual(
      subjectPage,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/v1/management-query-subjects?limit=100",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("posts only the strict management-query contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(result), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runManagementQuery(query, "management-query-key-1"),
    ).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/v1/management-queries",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": "management-query-key-1",
          "content-type": "application/json",
        }),
        body: JSON.stringify(query),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual(
      query,
    );
  });

  test("preserves stable API errors and rejects invalid success payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: "MANAGEMENT_QUERY_SUBJECT_NOT_FOUND",
              message: "该销售不在当前可问范围内。",
              requestId: "request-query-1",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...result, unexpected: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    const error = await runManagementQuery(
      query,
      "management-query-key-2",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManagementQueryApiError);
    expect(error).toMatchObject({
      status: 404,
      code: "MANAGEMENT_QUERY_SUBJECT_NOT_FOUND",
      requestId: "request-query-1",
    });
    await expect(
      runManagementQuery(query, "management-query-key-3"),
    ).rejects.toThrow();
  });
});
