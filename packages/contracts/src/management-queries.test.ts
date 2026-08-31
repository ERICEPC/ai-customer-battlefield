import { describe, expect, it } from "vitest";

import {
  managementQueryApiErrorSchema,
  managementQueryRequestSchema,
  managementQueryResultSchema,
  managementQuerySubjectPageSchema,
} from "./management-queries.js";

const queryId = "90000000-0000-4000-8000-000000000081";
const subjectUserId = "30000000-0000-4000-8000-000000000001";
const entityId = "50000000-0000-4000-8000-000000000001";
const evidenceId = "70000000-0000-4000-8000-000000000001";
const actionEvidenceId = "d0000000-0000-4000-8000-000000000001";
const stateEvidenceId = "b0000000-0000-4000-8000-000000000001";

function result() {
  return {
    queryId,
    capability: "sales_weekly_progress" as const,
    subject: {
      userId: subjectUserId,
      displayName: "销售甲",
    },
    period: {
      start: "2026-08-24T00:00:00.000Z",
      end: "2026-08-31T23:59:59.999Z",
    },
    dataCutoffAt: "2026-08-31T04:00:00.000Z",
    scope: {
      kind: "observed_portfolio" as const,
      entityCount: 1,
    },
    metrics: {
      confirmedFollowupCount: 2,
      validFactCount: 3,
      stageChangeCount: 1,
      completedActionCount: 1,
      openActionCount: 2,
      overdueActionCount: 1,
    },
    highlights: [
      {
        entityId,
        entityName: "Aurora Systems",
        latestActivityAt: "2026-08-31T03:00:00.000Z",
        confirmedFollowupCount: 2,
        validFactCount: 3,
        stageChangeCount: 1,
        completedActionCount: 1,
        openActionCount: 2,
        overdueActionCount: 1,
        evidence: [
          {
            kind: "followup" as const,
            evidenceId,
            occurredAt: "2026-08-31T03:00:00.000Z",
            label: "客户确认安全评审时间",
            deepLink: `/followups/${evidenceId}`,
          },
        ],
      },
    ],
    dataGaps: [
      {
        entityId,
        entityName: "Aurora Systems",
        code: "missing_battle_state" as const,
        message: "当前没有已发布作战状态，不能据此判断风险高低。",
      },
    ],
  };
}

describe("management-query contracts", () => {
  it("accepts only the controlled progress capability and a bounded interval", () => {
    expect(
      managementQueryRequestSchema.parse({
        capability: "sales_weekly_progress",
        subjectUserId,
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.999Z",
      }),
    ).toEqual({
      capability: "sales_weekly_progress",
      subjectUserId,
      periodStart: "2026-08-24T00:00:00.000Z",
      periodEnd: "2026-08-31T23:59:59.999Z",
    });

    for (const request of [
      {
        capability: "arbitrary_sql",
        subjectUserId,
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.999Z",
      },
      {
        capability: "sales_weekly_progress",
        subjectUserId,
        periodStart: "2026-08-31T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
      },
      {
        capability: "sales_weekly_progress",
        subjectUserId,
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
      },
      {
        capability: "sales_weekly_progress",
        subjectUserId,
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
        tenantId: "10000000-0000-4000-8000-000000000001",
      },
    ]) {
      expect(managementQueryRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });

  it("accepts one strict evidence-backed result", () => {
    expect(managementQueryResultSchema.parse(result())).toEqual(result());
  });

  it("rejects incoherent cutoffs, scope counts and unsafe evidence links", () => {
    expect(
      managementQueryResultSchema.safeParse({
        ...result(),
        dataCutoffAt: "2026-09-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      managementQueryResultSchema.safeParse({
        ...result(),
        scope: { kind: "observed_portfolio", entityCount: 0 },
      }).success,
    ).toBe(false);
    expect(
      managementQueryResultSchema.safeParse({
        ...result(),
        highlights: [
          {
            ...result().highlights[0],
            evidence: [
              {
                ...result().highlights[0]?.evidence[0],
                deepLink: "https://example.invalid/private",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("binds every evidence kind to its authorized route and identifiers", () => {
    const cases = [
      {
        kind: "followup",
        evidenceId,
        deepLink: `/followups/${evidenceId}`,
      },
      {
        kind: "fact",
        evidenceId,
        deepLink: `/followups/${evidenceId}`,
      },
      {
        kind: "stage_change",
        evidenceId,
        deepLink: `/battle-map?entityId=${entityId}`,
      },
      {
        kind: "action",
        evidenceId: actionEvidenceId,
        deepLink: `/actions?actionId=${actionEvidenceId}`,
      },
      {
        kind: "battle_state",
        evidenceId: stateEvidenceId,
        deepLink: `/battle-map?entityId=${entityId}&stateVersion=${stateEvidenceId}`,
      },
    ] as const;

    for (const evidence of cases) {
      expect(
        managementQueryResultSchema.safeParse({
          ...result(),
          highlights: [
            {
              ...result().highlights[0],
              evidence: [
                {
                  ...result().highlights[0]?.evidence[0],
                  ...evidence,
                },
              ],
            },
          ],
        }).success,
      ).toBe(true);
    }

    for (const deepLink of [
      "/entities",
      `/battle-map?entityId=50000000-0000-4000-8000-000000000099`,
      `/actions?actionId=70000000-0000-4000-8000-000000000099`,
      `/battle-map?entityId=${entityId}&stateVersion=70000000-0000-4000-8000-000000000099`,
    ]) {
      expect(
        managementQueryResultSchema.safeParse({
          ...result(),
          highlights: [
            {
              ...result().highlights[0],
              evidence: [
                {
                  ...result().highlights[0]?.evidence[0],
                  deepLink,
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("bounds subject pages and result collections", () => {
    expect(
      managementQuerySubjectPageSchema.parse({
        items: [
          {
            userId: subjectUserId,
            displayName: "销售甲",
            scopeKind: "observed_portfolio",
          },
        ],
        nextCursor: null,
      }).items,
    ).toHaveLength(1);
    expect(
      managementQuerySubjectPageSchema.safeParse({
        items: Array.from({ length: 101 }, () => ({
          userId: subjectUserId,
          displayName: "销售甲",
          scopeKind: "observed_portfolio",
        })),
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      managementQueryResultSchema.safeParse({
        ...result(),
        highlights: Array.from({ length: 51 }, () => result().highlights[0]),
      }).success,
    ).toBe(false);
  });

  it("defines non-leaking API errors", () => {
    expect(
      managementQueryApiErrorSchema.parse({
        code: "MANAGEMENT_QUERY_SUBJECT_NOT_FOUND",
        message: "Management query subject was not found.",
        requestId: "request-1",
      }).code,
    ).toBe("MANAGEMENT_QUERY_SUBJECT_NOT_FOUND");
    expect(
      managementQueryApiErrorSchema.parse({
        code: "MANAGEMENT_QUERY_RESULT_LIMIT_EXCEEDED",
        message: "Management query result exceeds its processing limit.",
        requestId: "request-2",
      }).code,
    ).toBe("MANAGEMENT_QUERY_RESULT_LIMIT_EXCEEDED");
    expect(
      managementQueryApiErrorSchema.parse({
        code: "MANAGEMENT_QUERY_IDEMPOTENCY_CONFLICT",
        message: "Management query idempotency key cannot be reused.",
        requestId: "request-3",
      }).code,
    ).toBe("MANAGEMENT_QUERY_IDEMPOTENCY_CONFLICT");
  });
});
