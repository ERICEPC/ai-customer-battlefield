import { z } from "zod";

const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1_000;
const boundedCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const relativeDeepLinkSchema = z
  .string()
  .max(2_000)
  .regex(/^\/(?!\/)[A-Za-z0-9/?=&%._~-]*$/);

export const weeklyReportTypeSchema = z.enum(["personal", "managed_portfolio"]);
export const weeklyReportStatusSchema = z.enum([
  "draft",
  "in_review",
  "published",
  "cancelled",
]);
export const weeklyReportSectionKindSchema = z.enum([
  "progress",
  "risk",
  "next_action",
  "data_gap",
]);
export const weeklyReportItemSeveritySchema = z.enum([
  "positive",
  "info",
  "warning",
  "critical",
]);
export const weeklyReportEvidenceKindSchema = z.enum([
  "followup",
  "fact",
  "stage_change",
  "action",
  "battle_state",
]);

export const generateWeeklyReportRequestSchema = z
  .strictObject({
    reportType: weeklyReportTypeSchema,
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
  })
  .superRefine((request, context) =>
    validatePeriod(
      request.periodStart,
      request.periodEnd,
      context,
      "periodEnd",
    ),
  );

export const reviewWeeklyReportRequestSchema = z.strictObject({
  lockVersion: z.number().int().positive(),
  note: z.string().max(2_000),
  items: z
    .array(
      z.strictObject({
        itemId: z.uuid(),
        included: z.boolean(),
      }),
    )
    .max(2_000)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.itemId)).size !== items.length) {
        context.addIssue({
          code: "custom",
          message: "Each report item may be reviewed at most once.",
        });
      }
    }),
});

export const weeklyReportTransitionRequestSchema = z.strictObject({
  lockVersion: z.number().int().positive(),
});

export const weeklyReportListQuerySchema = z.strictObject({
  reportType: weeklyReportTypeSchema.optional(),
  status: weeklyReportStatusSchema.optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const weeklyReportContributorSchema = z.strictObject({
  userId: z.uuid(),
  displayName: z.string().trim().min(1).max(200),
});

export const weeklyReportEvidenceSchema = z.strictObject({
  kind: weeklyReportEvidenceKindSchema,
  evidenceId: z.uuid(),
  occurredAt: z.iso.datetime(),
  label: z.string().trim().min(1).max(500),
  deepLink: relativeDeepLinkSchema,
});

export const weeklyReportItemSchema = z.strictObject({
  itemId: z.uuid(),
  sectionKind: weeklyReportSectionKindSchema,
  entityId: z.uuid(),
  entityName: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  severity: weeklyReportItemSeveritySchema,
  occurredAt: z.iso.datetime().nullable(),
  included: z.boolean(),
  sortOrder: z.number().int().min(0).max(1_000_000),
  contributors: z.array(weeklyReportContributorSchema).max(50),
  evidence: z.array(weeklyReportEvidenceSchema).max(20),
});

export const weeklyReportSectionSchema = z.strictObject({
  kind: weeklyReportSectionKindSchema,
  items: z.array(weeklyReportItemSchema).max(500),
});

export const weeklyReportMetricsSchema = z.strictObject({
  confirmedFollowupCount: boundedCountSchema,
  validFactCount: boundedCountSchema,
  stageChangeCount: boundedCountSchema,
  completedActionCount: boundedCountSchema,
  openActionCount: boundedCountSchema,
  overdueActionCount: boundedCountSchema,
});

export const weeklyReportDetailSchema = z
  .strictObject({
    reportId: z.uuid(),
    versionId: z.uuid(),
    reportType: weeklyReportTypeSchema,
    revisionNo: z.number().int().positive(),
    lockVersion: z.number().int().positive(),
    status: weeklyReportStatusSchema,
    title: z.string().trim().min(1).max(200),
    note: z.string().max(2_000),
    period: z.strictObject({
      start: z.iso.datetime(),
      end: z.iso.datetime(),
    }),
    dataCutoffAt: z.iso.datetime(),
    scope: z.strictObject({
      label: z.string().trim().min(1).max(200),
      entityCount: boundedCountSchema,
      contributorCount: boundedCountSchema,
    }),
    dataSufficiency: z.enum(["sufficient", "partial", "insufficient"]),
    metrics: weeklyReportMetricsSchema,
    generator: z.strictObject({
      kind: z.enum(["deterministic", "agent"]),
      version: z.string().trim().min(1).max(200),
      ruleVersion: z.string().trim().min(1).max(200),
      promptVersion: z.string().trim().min(1).max(200).nullable(),
    }),
    delivery: z.strictObject({
      status: z.enum([
        "not_started",
        "pending",
        "delivered",
        "partial",
        "failed",
      ]),
      channels: z.array(
        z.strictObject({
          channel: z.enum(["in_app", "feishu", "email"]),
          status: z.enum([
            "pending",
            "processing",
            "delivered",
            "failed",
            "cancelled",
            "dead_lettered",
          ]),
        }),
      ),
    }),
    sections: z.array(weeklyReportSectionSchema).length(4),
    previousVersionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().nullable(),
    capabilities: z.strictObject({
      canReview: z.boolean(),
      canPublish: z.boolean(),
      canRevise: z.boolean(),
    }),
  })
  .superRefine((report, context) => {
    validatePeriod(report.period.start, report.period.end, context, [
      "period",
      "end",
    ]);
    const cutoff = Date.parse(report.dataCutoffAt);
    const start = Date.parse(report.period.start);
    const end = Date.parse(report.period.end);
    if (cutoff < start || cutoff > end) {
      context.addIssue({
        code: "custom",
        path: ["dataCutoffAt"],
        message: "The report cutoff must fall inside the requested period.",
      });
    }
    const sectionKinds = report.sections.map((section) => section.kind);
    const requiredKinds = ["progress", "risk", "next_action", "data_gap"];
    if (
      new Set(sectionKinds).size !== requiredKinds.length ||
      requiredKinds.some((kind) => !sectionKinds.includes(kind as never))
    ) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message:
          "A report must contain each of the four sections exactly once.",
      });
    }
    const itemIds: string[] = [];
    for (const [sectionIndex, section] of report.sections.entries()) {
      for (const [itemIndex, item] of section.items.entries()) {
        itemIds.push(item.itemId);
        if (item.sectionKind !== section.kind) {
          context.addIssue({
            code: "custom",
            path: ["sections", sectionIndex, "items", itemIndex, "sectionKind"],
            message: "A report item must belong to its containing section.",
          });
        }
        validateEvidenceRoutes(item, context, sectionIndex, itemIndex);
      }
    }
    if (new Set(itemIds).size !== itemIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Each report item identifier must be unique.",
      });
    }
    if ((report.status === "published") !== (report.publishedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "Only a published report has a publication timestamp.",
      });
    }
    if (
      (report.status === "published" &&
        report.delivery.status === "not_started") ||
      (report.status !== "published" &&
        (report.delivery.status !== "not_started" ||
          report.delivery.channels.length > 0))
    ) {
      context.addIssue({
        code: "custom",
        path: ["delivery"],
        message: "Delivery state must match the report publication state.",
      });
    }
  });

export const weeklyReportListItemSchema = z
  .strictObject({
    reportId: z.uuid(),
    versionId: z.uuid(),
    reportType: weeklyReportTypeSchema,
    revisionNo: z.number().int().positive(),
    status: weeklyReportStatusSchema,
    title: z.string().trim().min(1).max(200),
    period: z.strictObject({
      start: z.iso.datetime(),
      end: z.iso.datetime(),
    }),
    dataCutoffAt: z.iso.datetime(),
    entityCount: boundedCountSchema,
    createdAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().nullable(),
  })
  .superRefine((report, context) => {
    validatePeriod(report.period.start, report.period.end, context, [
      "period",
      "end",
    ]);
    if ((report.status === "published") !== (report.publishedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "Only a published report has a publication timestamp.",
      });
    }
  });

export const weeklyReportPageSchema = z.strictObject({
  items: z.array(weeklyReportListItemSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const weeklyReportApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_WEEKLY_REPORT_REQUEST",
    "WEEKLY_REPORT_NOT_FOUND",
    "WEEKLY_REPORT_VERSION_CONFLICT",
    "WEEKLY_REPORT_SCOPE_CONFLICT",
    "WEEKLY_REPORT_IDEMPOTENCY_CONFLICT",
    "WEEKLY_REPORT_RESULT_LIMIT_EXCEEDED",
    "WEEKLY_REPORT_UNAVAILABLE",
  ]),
  message: z.string().trim().min(1).max(1_000),
  requestId: z.string().trim().min(1).max(200),
  issues: z
    .array(
      z.strictObject({
        path: z.string().trim().min(1).max(200),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(100)
    .optional(),
});

function validatePeriod(
  startValue: string,
  endValue: string,
  context: z.RefinementCtx,
  path: string | PropertyKey[],
): void {
  const duration = Date.parse(endValue) - Date.parse(startValue);
  if (duration <= 0 || duration > MAX_PERIOD_MS) {
    context.addIssue({
      code: "custom",
      path: Array.isArray(path) ? path : [path],
      message: "The report period must be positive and no longer than 31 days.",
    });
  }
}

function validateEvidenceRoutes(
  item: z.infer<typeof weeklyReportItemSchema>,
  context: z.RefinementCtx,
  sectionIndex: number,
  itemIndex: number,
): void {
  for (const [evidenceIndex, evidence] of item.evidence.entries()) {
    const expected =
      evidence.kind === "action"
        ? `/actions?actionId=${evidence.evidenceId}`
        : evidence.kind === "battle_state"
          ? `/battle-map?entityId=${item.entityId}&stateVersion=${evidence.evidenceId}`
          : `/battle-map?entityId=${item.entityId}`;
    if (evidence.deepLink !== expected) {
      context.addIssue({
        code: "custom",
        path: [
          "sections",
          sectionIndex,
          "items",
          itemIndex,
          "evidence",
          evidenceIndex,
          "deepLink",
        ],
        message:
          "Evidence links must match their report entity and evidence identifiers.",
      });
    }
  }
}

export type WeeklyReportType = z.infer<typeof weeklyReportTypeSchema>;
export type WeeklyReportStatus = z.infer<typeof weeklyReportStatusSchema>;
export type WeeklyReportSectionKind = z.infer<
  typeof weeklyReportSectionKindSchema
>;
export type WeeklyReportItemSeverity = z.infer<
  typeof weeklyReportItemSeveritySchema
>;
export type WeeklyReportEvidence = z.infer<typeof weeklyReportEvidenceSchema>;
export type WeeklyReportItem = z.infer<typeof weeklyReportItemSchema>;
export type WeeklyReportSection = z.infer<typeof weeklyReportSectionSchema>;
export type WeeklyReportMetrics = z.infer<typeof weeklyReportMetricsSchema>;
export type GenerateWeeklyReportRequest = z.infer<
  typeof generateWeeklyReportRequestSchema
>;
export type ReviewWeeklyReportRequest = z.infer<
  typeof reviewWeeklyReportRequestSchema
>;
export type WeeklyReportTransitionRequest = z.infer<
  typeof weeklyReportTransitionRequestSchema
>;
export type WeeklyReportListQuery = z.infer<typeof weeklyReportListQuerySchema>;
export type WeeklyReportDetail = z.infer<typeof weeklyReportDetailSchema>;
export type WeeklyReportListItem = z.infer<typeof weeklyReportListItemSchema>;
export type WeeklyReportPage = z.infer<typeof weeklyReportPageSchema>;
export type WeeklyReportApiError = z.infer<typeof weeklyReportApiErrorSchema>;
