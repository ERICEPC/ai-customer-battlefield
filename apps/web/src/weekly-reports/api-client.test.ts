import type {
  GenerateWeeklyReportRequest,
  ReviewWeeklyReportRequest,
  WeeklyReportDetail,
  WeeklyReportPage,
} from "@battlefield/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  generateWeeklyReport,
  getWeeklyReport,
  listWeeklyReports,
  publishWeeklyReport,
  reviewWeeklyReport,
  reviseWeeklyReport,
  WeeklyReportApiError,
} from "./api-client";

const request: GenerateWeeklyReportRequest = {
  reportType: "personal",
  periodStart: "2026-08-24T00:00:00.000Z",
  periodEnd: "2026-08-31T00:00:00.000Z",
};
const detail: WeeklyReportDetail = {
  reportId: "91000000-0000-4000-8000-000000000001",
  versionId: "92000000-0000-4000-8000-000000000001",
  reportType: "personal",
  revisionNo: 1,
  lockVersion: 1,
  status: "in_review",
  title: "个人周报",
  note: "",
  period: { start: request.periodStart, end: request.periodEnd },
  dataCutoffAt: request.periodEnd,
  scope: { label: "本人责任范围", entityCount: 1, contributorCount: 1 },
  dataSufficiency: "sufficient",
  metrics: {
    confirmedFollowupCount: 0,
    validFactCount: 0,
    stageChangeCount: 0,
    completedActionCount: 0,
    openActionCount: 0,
    overdueActionCount: 0,
  },
  generator: {
    kind: "deterministic",
    version: "weekly-progress-v1",
    ruleVersion: "weekly-progress-v1",
    promptVersion: null,
  },
  delivery: { status: "not_started", channels: [] },
  sections: [
    { kind: "progress", items: [] },
    { kind: "risk", items: [] },
    { kind: "next_action", items: [] },
    { kind: "data_gap", items: [] },
  ],
  previousVersionId: null,
  createdAt: request.periodEnd,
  publishedAt: null,
  capabilities: { canReview: true, canPublish: true, canRevise: false },
};
const page: WeeklyReportPage = {
  items: [
    {
      reportId: detail.reportId,
      versionId: detail.versionId,
      reportType: detail.reportType,
      revisionNo: detail.revisionNo,
      status: detail.status,
      title: detail.title,
      period: detail.period,
      dataCutoffAt: detail.dataCutoffAt,
      entityCount: detail.scope.entityCount,
      createdAt: detail.createdAt,
      publishedAt: detail.publishedAt,
    },
  ],
  nextCursor: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("weekly-report API client", () => {
  test("encodes history filters and validates the page", async () => {
    const fetchMock = successFetch(page, 200);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listWeeklyReports({
        reportType: "personal",
        status: "in_review",
        cursor: "opaque-cursor",
        limit: 20,
      }),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/v1/reports?reportType=personal&status=in_review&cursor=opaque-cursor&limit=20",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  test("sends only strict lifecycle contracts and retry keys", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(detail), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const review: ReviewWeeklyReportRequest = {
      lockVersion: 1,
      note: "人工核对",
      items: [],
    };

    await generateWeeklyReport(request, "generate-key");
    await getWeeklyReport(detail.versionId);
    await reviewWeeklyReport(detail.versionId, review);
    await publishWeeklyReport(
      detail.versionId,
      { lockVersion: 1 },
      "publish-key",
    );
    await reviseWeeklyReport(
      detail.versionId,
      { lockVersion: 2 },
      "revise-key",
    );

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/api/v1/reports",
      `http://localhost:3001/api/v1/reports/${detail.versionId}`,
      `http://localhost:3001/api/v1/reports/${detail.versionId}/review`,
      `http://localhost:3001/api/v1/reports/${detail.versionId}/publish`,
      `http://localhost:3001/api/v1/reports/${detail.versionId}/revise`,
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
        headers: expect.objectContaining({
          "Idempotency-Key": "generate-key",
        }),
      }),
    );
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify(review),
      }),
    );
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ lockVersion: 1 }),
        headers: expect.objectContaining({ "Idempotency-Key": "publish-key" }),
      }),
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
              code: "WEEKLY_REPORT_SCOPE_CONFLICT",
              message: "责任范围已变化。",
              requestId: "request-report-1",
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...detail, unexpected: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    const error = await generateWeeklyReport(request, "conflict-key").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WeeklyReportApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "WEEKLY_REPORT_SCOPE_CONFLICT",
      requestId: "request-report-1",
    });
    await expect(getWeeklyReport(detail.versionId)).rejects.toThrow();
  });
});

function successFetch(payload: unknown, status: number) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}
