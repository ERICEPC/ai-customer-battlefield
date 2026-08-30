import { z } from "zod";

const versionNoSchema = z.string().regex(/^[1-9]\d*$/);
const inputVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const codeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,99}$/);
const scoreSchema = z
  .string()
  .regex(/^(?:(?:0|[1-9]\d?)(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/);

export const battleDimensionSchema = z.enum([
  "relationship",
  "potential",
  "risk",
  "stage",
]);
export const battleSignalDirectionSchema = z.enum([
  "positive",
  "negative",
  "neutral",
]);
export const battleRiskLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export const battleDataSufficiencySchema = z.enum([
  "insufficient",
  "partial",
  "sufficient",
]);

export const battleSignalCandidateSchema = z.strictObject({
  factId: z.uuid(),
  dimension: battleDimensionSchema,
  direction: battleSignalDirectionSchema,
  strength: z.number().int().min(0).max(100),
  reason: z.string().trim().min(1).max(1_000),
});

export const battleActionProposalCandidateSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(5_000),
  suggestedOwnerId: z.uuid().nullable(),
  suggestedPriority: z.enum(["low", "medium", "high", "urgent"]),
  suggestedPlannedAt: z.iso.datetime().nullable(),
});

export const battleAnalysisCandidateSchema = z
  .strictObject({
    relationshipScore: scoreSchema.nullable(),
    potentialScore: scoreSchema.nullable(),
    quadrantCode: codeSchema.nullable(),
    primaryOpportunityId: z.uuid().nullable(),
    riskLevel: battleRiskLevelSchema,
    dataSufficiency: battleDataSufficiencySchema,
    dataGaps: z.array(z.string().trim().min(1).max(500)).max(100),
    summary: z.string().trim().min(1).max(5_000),
    signals: z.array(battleSignalCandidateSchema).max(500),
    evidenceFactIds: z.array(z.uuid()).max(500),
    actionProposals: z.array(battleActionProposalCandidateSchema).max(100),
  })
  .superRefine((candidate, context) => {
    const evidence = new Set(candidate.evidenceFactIds);
    if (evidence.size !== candidate.evidenceFactIds.length) {
      context.addIssue({
        code: "custom",
        path: ["evidenceFactIds"],
        message: "Evidence fact identifiers must be unique.",
      });
    }
    if (candidate.signals.some((signal) => !evidence.has(signal.factId))) {
      context.addIssue({
        code: "custom",
        path: ["signals"],
        message: "Every signal must reference an included evidence fact.",
      });
    }
    if (
      candidate.dataSufficiency === "sufficient" &&
      (candidate.relationshipScore === null ||
        candidate.potentialScore === null ||
        candidate.quadrantCode === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataSufficiency"],
        message: "Sufficient data requires map coordinates and a quadrant.",
      });
    }
    if (
      candidate.dataSufficiency === "insufficient" &&
      (candidate.relationshipScore !== null ||
        candidate.potentialScore !== null ||
        candidate.quadrantCode !== null ||
        candidate.dataGaps.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataSufficiency"],
        message:
          "Insufficient data requires explicit gaps and no invented coordinates.",
      });
    }
  });

export const battleAnalysisRequestSchema = z.strictObject({
  entityId: z.uuid(),
  expectedInputVersion: inputVersionSchema.optional(),
});

const battleAnalysisResultBaseSchema = z.strictObject({
  analysisRunId: z.uuid(),
  entityId: z.uuid(),
  inputVersion: inputVersionSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});

export const battleAnalysisResultSchema = z.discriminatedUnion("status", [
  battleAnalysisResultBaseSchema.extend({
    status: z.literal("completed"),
    battleStateVersionId: z.uuid(),
    battleStateVersionNo: versionNoSchema,
    proposalIds: z.array(z.uuid()).max(100),
  }),
  battleAnalysisResultBaseSchema.extend({
    status: z.literal("superseded"),
    battleStateVersionId: z.null(),
    battleStateVersionNo: z.null(),
    proposalIds: z.array(z.never()).max(0),
  }),
]);

export const battleStateRecordSchema = z
  .strictObject({
    battleStateVersionId: z.uuid(),
    entityId: z.uuid(),
    versionNo: versionNoSchema,
    inputVersion: inputVersionSchema,
    relationshipScore: scoreSchema.nullable(),
    potentialScore: scoreSchema.nullable(),
    quadrantCode: codeSchema.nullable(),
    primaryOpportunityId: z.uuid().nullable(),
    riskLevel: battleRiskLevelSchema,
    dataSufficiency: battleDataSufficiencySchema,
    dataGaps: z.array(z.string().trim().min(1).max(500)).max(100),
    summary: z.string().trim().min(1).max(5_000),
    analysisRunId: z.uuid(),
    effectiveAt: z.iso.datetime(),
    evidenceFactIds: z.array(z.uuid()).max(500),
  })
  .superRefine((state, context) => {
    if (new Set(state.evidenceFactIds).size !== state.evidenceFactIds.length) {
      context.addIssue({
        code: "custom",
        path: ["evidenceFactIds"],
        message: "Evidence fact identifiers must be unique.",
      });
    }
    if (
      state.dataSufficiency === "sufficient" &&
      (state.relationshipScore === null ||
        state.potentialScore === null ||
        state.quadrantCode === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataSufficiency"],
        message: "Sufficient data requires map coordinates and a quadrant.",
      });
    }
    if (
      state.dataSufficiency === "insufficient" &&
      (state.relationshipScore !== null ||
        state.potentialScore !== null ||
        state.quadrantCode !== null ||
        state.dataGaps.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataSufficiency"],
        message:
          "Insufficient data requires explicit gaps and no invented coordinates.",
      });
    }
  });

export const battleEvidenceFactSchema = z.strictObject({
  factId: z.uuid(),
  factType: codeSchema,
  factValue: z.string().trim().min(1).max(10_000),
  occurredAt: z.iso.datetime(),
  opportunityId: z.uuid().nullable(),
});

export const battleSignalRecordSchema = battleSignalCandidateSchema.extend({
  signalId: z.uuid(),
});

export const battleStateDetailSchema = z.strictObject({
  state: battleStateRecordSchema,
  evidenceFacts: z.array(battleEvidenceFactSchema).max(500),
  signals: z.array(battleSignalRecordSchema).max(500),
});

const booleanQuerySchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const battleMapQuerySchema = z.strictObject({
  isT0: booleanQuerySchema.optional(),
  quadrantCode: codeSchema.optional(),
  dataSufficiency: battleDataSufficiencySchema.optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const battleMapItemSchema = z.strictObject({
  entityId: z.uuid(),
  entityName: z.string().trim().min(1).max(500),
  entityTypeCode: codeSchema,
  isT0: z.boolean(),
  primaryOwnerName: z.string().trim().min(1).max(200).nullable(),
  state: battleStateRecordSchema.nullable(),
});

export const battleMapPageSchema = z.strictObject({
  items: z.array(battleMapItemSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export type BattleAnalysisCandidate = z.infer<
  typeof battleAnalysisCandidateSchema
>;
export type BattleAnalysisRequest = z.infer<typeof battleAnalysisRequestSchema>;
export type BattleAnalysisResult = z.infer<typeof battleAnalysisResultSchema>;
export type BattleStateRecord = z.infer<typeof battleStateRecordSchema>;
export type BattleEvidenceFact = z.infer<typeof battleEvidenceFactSchema>;
export type BattleSignalRecord = z.infer<typeof battleSignalRecordSchema>;
export type BattleStateDetail = z.infer<typeof battleStateDetailSchema>;
export type BattleMapQuery = z.infer<typeof battleMapQuerySchema>;
export type BattleMapItem = z.infer<typeof battleMapItemSchema>;
export type BattleMapPage = z.infer<typeof battleMapPageSchema>;
