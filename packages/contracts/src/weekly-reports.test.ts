import { describe, expect, it } from "vitest";

import {
  generateWeeklyReportRequestSchema,
  reviewWeeklyReportRequestSchema,
  weeklyReportApiErrorSchema,
  weeklyReportDetailSchema,
  weeklyReportPageSchema,
  weeklyReportTransitionRequestSchema,
} from "./weekly-reports.js";

const reportId = "91000000-0000-4000-8000-000000000001";
const versionId = "92000000-0000-4000-8000-000000000001";
const entityId = "50000000-0000-4000-8000-000000000001";
const itemIds = {
  progress: "93000000-0000-4000-8000-000000000001",
  risk: "93000000-0000-4000-8000-000000000002",
  next_action: "93000000-0000-4000-8000-000000000003",
  data_gap: "93000000-0000-4000-8000-000000000004",
};
const evidenceId = "70000000-0000-4000-8000-000000000001";
const actionId = "d0000000-0000-4000-8000-000000000001";

function detail() {
  return {
    reportId,
    versionId,
    reportType: "managed_portfolio" as const,
    revisionNo: 1,
    lockVersion: 1,
    status: "in_review" as const,
    title: "管理范围周报",
    note: "请重点关注逾期动作。",
    period: {
      start: "2026-08-24T00:00:00.000Z",
      end: "2026-08-31T00:00:00.000Z",
    },
    dataCutoffAt: "2026-08-31T00:00:00.000Z",
    scope: {
      label: "当前管理关注范围",
      entityCount: 1,
      contributorCount: 1,
    },
    metrics: {
      confirmedFollowupCount: 2,
      validFactCount: 3,
      stageChangeCount: 1,
      completedActionCount: 1,
      openActionCount: 2,
      overdueActionCount: 1,
    },
    generator: { kind: "deterministic", version: "weekly-progress-v1" },
    sections: [
      {
        kind: "progress" as const,
        items: [
          {
            itemId: itemIds.progress,
            sectionKind: "progress" as const,
            entityId,
            entityName: "Aurora Systems",
            title: "本周新增经营事实",
            summary: "客户确认安全评审时间。",
            severity: "positive" as const,
            occurredAt: "2026-08-30T03:00:00.000Z",
            included: true,
            sortOrder: 1,
            contributors: [
              {
                userId: "30000000-0000-4000-8000-000000000001",
                displayName: "销售甲",
              },
            ],
            evidence: [
              {
                kind: "fact" as const,
                evidenceId,
                occurredAt: "2026-08-30T03:00:00.000Z",
                label: "客户确认安全评审时间",
                deepLink: `/battle-map?entityId=${entityId}`,
              },
            ],
          },
        ],
      },
      {
        kind: "risk" as const,
        items: [
          {
            itemId: itemIds.risk,
            sectionKind: "risk" as const,
            entityId,
            entityName: "Aurora Systems",
            title: "经营动作已逾期",
            summary: "确认下一轮技术交流安排。",
            severity: "critical" as const,
            occurredAt: "2026-08-29T03:00:00.000Z",
            included: true,
            sortOrder: 1,
            contributors: [],
            evidence: [
              {
                kind: "action" as const,
                evidenceId: actionId,
                occurredAt: "2026-08-29T03:00:00.000Z",
                label: "确认下一轮技术交流安排",
                deepLink: `/actions?actionId=${actionId}`,
              },
            ],
          },
        ],
      },
      {
        kind: "next_action" as const,
        items: [
          {
            itemId: itemIds.next_action,
            sectionKind: "next_action" as const,
            entityId,
            entityName: "Aurora Systems",
            title: "下一步经营动作",
            summary: "准备安全评审材料。",
            severity: "info" as const,
            occurredAt: "2026-09-02T03:00:00.000Z",
            included: true,
            sortOrder: 1,
            contributors: [],
            evidence: [
              {
                kind: "action" as const,
                evidenceId: actionId,
                occurredAt: "2026-08-29T03:00:00.000Z",
                label: "准备安全评审材料",
                deepLink: `/actions?actionId=${actionId}`,
              },
            ],
          },
        ],
      },
      {
        kind: "data_gap" as const,
        items: [
          {
            itemId: itemIds.data_gap,
            sectionKind: "data_gap" as const,
            entityId,
            entityName: "Aurora Systems",
            title: "缺少作战状态",
            summary: "当前没有可用于判断风险的作战状态版本。",
            severity: "warning" as const,
            occurredAt: null,
            included: true,
            sortOrder: 1,
            contributors: [],
            evidence: [],
          },
        ],
      },
    ],
    previousVersionId: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    publishedAt: null,
    capabilities: { canReview: true, canPublish: true, canRevise: false },
  };
}

describe("weekly-report contracts", () => {
  it("accepts strict personal and managed generation requests with bounded periods", () => {
    for (const reportType of ["personal", "managed_portfolio"] as const) {
      expect(
        generateWeeklyReportRequestSchema.parse({
          reportType,
          periodStart: "2026-08-24T00:00:00.000Z",
          periodEnd: "2026-08-31T00:00:00.000Z",
        }).reportType,
      ).toBe(reportType);
    }

    for (const request of [
      {
        reportType: "tenant",
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
      },
      {
        reportType: "personal",
        periodStart: "2026-08-31T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
      },
      {
        reportType: "personal",
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
      },
      {
        reportType: "personal",
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
        subjectUserId: "30000000-0000-4000-8000-000000000001",
      },
    ]) {
      expect(generateWeeklyReportRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });

  it("accepts the four-section evidence-backed report detail", () => {
    expect(weeklyReportDetailSchema.parse(detail())).toEqual(detail());
  });

  it("requires exactly one of every section and matching item section kinds", () => {
    expect(
      weeklyReportDetailSchema.safeParse({
        ...detail(),
        sections: detail().sections.slice(0, 3),
      }).success,
    ).toBe(false);
    expect(
      weeklyReportDetailSchema.safeParse({
        ...detail(),
        sections: detail().sections.map((section, index) =>
          index === 0
            ? {
                ...section,
                items: section.items.map((item) => ({
                  ...item,
                  sectionKind: "risk",
                })),
              }
            : section,
        ),
      }).success,
    ).toBe(false);
  });

  it("binds evidence links to the item entity and exact evidence identifier", () => {
    const invalidLinks = [
      "https://example.invalid/private",
      "/battle-map?entityId=50000000-0000-4000-8000-000000000099",
      "/actions?actionId=d0000000-0000-4000-8000-000000000099",
    ];
    for (const deepLink of invalidLinks) {
      const invalid = detail();
      const evidence = invalid.sections[0]?.items[0]?.evidence[0];
      expect(evidence).toBeDefined();
      if (evidence) evidence.deepLink = deepLink;
      expect(weeklyReportDetailSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates review and transition concurrency inputs", () => {
    expect(
      reviewWeeklyReportRequestSchema.parse({
        lockVersion: 3,
        note: "保留风险说明。",
        items: [{ itemId: itemIds.risk, included: true }],
      }),
    ).toEqual({
      lockVersion: 3,
      note: "保留风险说明。",
      items: [{ itemId: itemIds.risk, included: true }],
    });
    expect(
      reviewWeeklyReportRequestSchema.safeParse({
        lockVersion: 0,
        note: "x",
        items: [],
      }).success,
    ).toBe(false);
    expect(
      weeklyReportTransitionRequestSchema.safeParse({
        lockVersion: 1,
        force: true,
      }).success,
    ).toBe(false);
  });

  it("enforces publication timestamps, bounded pages and strict errors", () => {
    expect(
      weeklyReportDetailSchema.safeParse({
        ...detail(),
        status: "published",
        publishedAt: null,
      }).success,
    ).toBe(false);
    expect(
      weeklyReportPageSchema.safeParse({
        items: Array.from({ length: 101 }, () => ({
          reportId,
          versionId,
          reportType: "personal",
          revisionNo: 1,
          status: "in_review",
          title: "个人周报",
          period: detail().period,
          dataCutoffAt: detail().dataCutoffAt,
          entityCount: 1,
          createdAt: detail().createdAt,
          publishedAt: null,
        })),
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      weeklyReportApiErrorSchema.parse({
        code: "WEEKLY_REPORT_SCOPE_CONFLICT",
        message: "The report scope changed.",
        requestId: "request-1",
      }).code,
    ).toBe("WEEKLY_REPORT_SCOPE_CONFLICT");
  });
});
