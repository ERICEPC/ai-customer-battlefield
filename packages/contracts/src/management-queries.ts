import { z } from "zod";

const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1_000;
const boundedCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const relativeDeepLinkSchema = z
  .string()
  .max(2_000)
  .regex(/^\/(?!\/)[A-Za-z0-9/?=&%._~-]*$/);

export const managementQueryCapabilitySchema = z.literal(
  "sales_weekly_progress",
);

export const managementQueryScopeKindSchema = z.enum([
  "self",
  "observed_portfolio",
]);

export const managementQueryRequestSchema = z
  .strictObject({
    capability: managementQueryCapabilitySchema,
    subjectUserId: z.uuid(),
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
  })
  .superRefine((request, context) => {
    validatePeriod(
      request.periodStart,
      request.periodEnd,
      context,
      "periodEnd",
    );
  });

export const managementQuerySubjectListQuerySchema = z.strictObject({
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const managementQuerySubjectSchema = z.strictObject({
  userId: z.uuid(),
  displayName: z.string().trim().min(1).max(200),
  scopeKind: managementQueryScopeKindSchema,
});

export const managementQuerySubjectPageSchema = z.strictObject({
  items: z.array(managementQuerySubjectSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const managementQueryEvidenceKindSchema = z.enum([
  "followup",
  "fact",
  "stage_change",
  "action",
  "battle_state",
]);

export const managementQueryEvidenceSchema = z.strictObject({
  kind: managementQueryEvidenceKindSchema,
  evidenceId: z.uuid(),
  occurredAt: z.iso.datetime(),
  label: z.string().trim().min(1).max(500),
  deepLink: relativeDeepLinkSchema,
});

export const managementQueryMetricsSchema = z.strictObject({
  confirmedFollowupCount: boundedCountSchema,
  validFactCount: boundedCountSchema,
  stageChangeCount: boundedCountSchema,
  completedActionCount: boundedCountSchema,
  openActionCount: boundedCountSchema,
  overdueActionCount: boundedCountSchema,
});

export const managementQueryHighlightSchema = z.strictObject({
  entityId: z.uuid(),
  entityName: z.string().trim().min(1).max(300),
  latestActivityAt: z.iso.datetime().nullable(),
  confirmedFollowupCount: boundedCountSchema,
  validFactCount: boundedCountSchema,
  stageChangeCount: boundedCountSchema,
  completedActionCount: boundedCountSchema,
  openActionCount: boundedCountSchema,
  overdueActionCount: boundedCountSchema,
  evidence: z.array(managementQueryEvidenceSchema).max(20),
});

export const managementQueryDataGapSchema = z.strictObject({
  entityId: z.uuid(),
  entityName: z.string().trim().min(1).max(300),
  code: z.literal("missing_battle_state"),
  message: z.string().trim().min(1).max(500),
});

export const managementQueryResultSchema = z
  .strictObject({
    queryId: z.uuid(),
    capability: managementQueryCapabilitySchema,
    subject: z.strictObject({
      userId: z.uuid(),
      displayName: z.string().trim().min(1).max(200),
    }),
    period: z.strictObject({
      start: z.iso.datetime(),
      end: z.iso.datetime(),
    }),
    dataCutoffAt: z.iso.datetime(),
    scope: z.strictObject({
      kind: managementQueryScopeKindSchema,
      entityCount: boundedCountSchema,
    }),
    metrics: managementQueryMetricsSchema,
    highlights: z.array(managementQueryHighlightSchema).max(50),
    dataGaps: z.array(managementQueryDataGapSchema).max(50),
  })
  .superRefine((result, context) => {
    validatePeriod(result.period.start, result.period.end, context, [
      "period",
      "end",
    ]);
    const cutoff = Date.parse(result.dataCutoffAt);
    const start = Date.parse(result.period.start);
    const end = Date.parse(result.period.end);
    if (cutoff < start || cutoff > end) {
      context.addIssue({
        code: "custom",
        path: ["dataCutoffAt"],
        message: "The data cutoff must fall inside the requested period.",
      });
    }
    if (
      result.highlights.length > result.scope.entityCount ||
      result.dataGaps.length > result.scope.entityCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope", "entityCount"],
        message: "Result rows cannot exceed the authorized entity scope.",
      });
    }
    requireUniqueEntityIds(result.highlights, "highlights", context);
    requireUniqueEntityIds(result.dataGaps, "dataGaps", context);
  });

export const managementQueryApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_MANAGEMENT_QUERY",
    "MANAGEMENT_QUERY_SUBJECT_NOT_FOUND",
    "MANAGEMENT_QUERY_UNAVAILABLE",
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
      message: "The query period must be positive and no longer than 31 days.",
    });
  }
}

function requireUniqueEntityIds(
  items: Array<{ entityId: string }>,
  path: string,
  context: z.RefinementCtx,
): void {
  const identifiers = items.map((item) => item.entityId);
  if (new Set(identifiers).size !== identifiers.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "Each entity may appear at most once in this collection.",
    });
  }
}

export type ManagementQueryCapability = z.infer<
  typeof managementQueryCapabilitySchema
>;
export type ManagementQueryRequest = z.infer<
  typeof managementQueryRequestSchema
>;
export type ManagementQueryScopeKind = z.infer<
  typeof managementQueryScopeKindSchema
>;
export type ManagementQuerySubject = z.infer<
  typeof managementQuerySubjectSchema
>;
export type ManagementQuerySubjectListQuery = z.infer<
  typeof managementQuerySubjectListQuerySchema
>;
export type ManagementQuerySubjectPage = z.infer<
  typeof managementQuerySubjectPageSchema
>;
export type ManagementQueryEvidence = z.infer<
  typeof managementQueryEvidenceSchema
>;
export type ManagementQueryMetrics = z.infer<
  typeof managementQueryMetricsSchema
>;
export type ManagementQueryHighlight = z.infer<
  typeof managementQueryHighlightSchema
>;
export type ManagementQueryDataGap = z.infer<
  typeof managementQueryDataGapSchema
>;
export type ManagementQueryResult = z.infer<typeof managementQueryResultSchema>;
export type ManagementQueryApiError = z.infer<
  typeof managementQueryApiErrorSchema
>;
