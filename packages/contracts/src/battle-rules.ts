import { z } from "zod";

const positiveVersionSchema = z.string().regex(/^[1-9][0-9]*$/);
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/);
const battleRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
const battleDimensionSchema = z.enum([
  "relationship",
  "potential",
  "risk",
  "stage",
]);
const actionPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const battleScoreRuleSchema = z
  .strictObject({
    base: z.number().min(0).max(100),
    perFact: z.number().min(0).max(100),
    maximum: z.number().min(0).max(100),
  })
  .refine((score) => score.base <= score.maximum, {
    message: "Score base cannot exceed its maximum.",
  });

export const battleRuleSetSchema = z.strictObject({
  minimumFactCount: z.number().int().min(1).max(100),
  relationshipScore: battleScoreRuleSchema,
  potentialScore: battleScoreRuleSchema,
  insufficientResult: z.strictObject({
    riskLevel: battleRiskLevelSchema,
    dataGap: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(5_000),
  }),
  sufficientResult: z.strictObject({
    quadrantCode: codeSchema,
    riskLevel: battleRiskLevelSchema,
    signalDimension: battleDimensionSchema,
    signalStrength: z.number().int().min(0).max(100),
    summaryTemplate: z.string().trim().min(1).max(5_000),
  }),
  actionProposal: z.strictObject({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(5_000),
    priority: actionPrioritySchema,
  }),
  stageLabels: z
    .record(codeSchema, z.string().trim().min(1).max(200))
    .refine((labels) => Object.keys(labels).length <= 100, {
      message: "At most 100 stage labels are supported.",
    }),
});

export const battleRuleVersionSchema = z.strictObject({
  versionId: z.uuid(),
  versionNo: positiveVersionSchema,
  name: z.string().trim().min(1).max(200),
  rules: battleRuleSetSchema,
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export const battleRuleVersionListQuerySchema = z.strictObject({
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const battleRuleVersionPageSchema = z.strictObject({
  items: z.array(battleRuleVersionSchema).max(100),
  currentVersionId: z.uuid(),
  currentReleaseNo: positiveVersionSchema,
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const createBattleRuleVersionRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  rules: battleRuleSetSchema,
});

export const releaseBattleRuleVersionRequestSchema = z.strictObject({
  versionId: z.uuid(),
  reason: z.string().trim().min(1).max(1_000),
});

export const releasedBattleRuleSchema = z.strictObject({
  versionId: z.uuid(),
  versionNo: positiveVersionSchema,
  releaseNo: positiveVersionSchema,
  ruleVersion: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  rules: battleRuleSetSchema,
  releasedAt: z.iso.datetime(),
});

export const battleRuleApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_BATTLE_RULE_REQUEST",
    "BATTLE_RULE_VERSION_NOT_FOUND",
    "BATTLE_RULE_RELEASE_NOT_FOUND",
    "BATTLE_RULE_FORBIDDEN",
    "CAPABILITY_FORBIDDEN",
    "BATTLE_RULE_UNAVAILABLE",
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

export type BattleRuleSet = z.infer<typeof battleRuleSetSchema>;
export type BattleRuleVersion = z.infer<typeof battleRuleVersionSchema>;
export type BattleRuleVersionPage = z.infer<typeof battleRuleVersionPageSchema>;
export type CreateBattleRuleVersionRequest = z.infer<
  typeof createBattleRuleVersionRequestSchema
>;
export type ReleaseBattleRuleVersionRequest = z.infer<
  typeof releaseBattleRuleVersionRequestSchema
>;
export type ReleasedBattleRule = z.infer<typeof releasedBattleRuleSchema>;
export type BattleRuleApiError = z.infer<typeof battleRuleApiErrorSchema>;
