import { z } from "zod";

const versionNoSchema = z.string().regex(/^[1-9]\d*$/);
const factTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_.-]{0,99}$/);

export const followupTypeSchema = z.enum([
  "meeting",
  "call",
  "message",
  "email",
  "other",
]);

export const followupFactCandidateSchema = z.strictObject({
  factType: factTypeSchema,
  factValue: z.string().trim().min(1).max(5_000),
});

export const followupDraftCandidateSchema = z
  .strictObject({
    entityId: z.uuid(),
    summary: z.string().trim().min(1).max(5_000),
    occurredAt: z.iso.datetime(),
    followupType: followupTypeSchema,
    relatedOpportunityIds: z.array(z.uuid()).max(100),
    primaryOpportunityId: z.uuid().nullable(),
    facts: z.array(followupFactCandidateSchema).max(100),
  })
  .superRefine((candidate, context) => {
    if (
      new Set(candidate.relatedOpportunityIds).size !==
      candidate.relatedOpportunityIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["relatedOpportunityIds"],
        message: "Related opportunity identifiers must be unique.",
      });
    }
    if (
      candidate.primaryOpportunityId &&
      !candidate.relatedOpportunityIds.includes(candidate.primaryOpportunityId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["primaryOpportunityId"],
        message: "The primary opportunity must also be related.",
      });
    }
    if (
      candidate.relatedOpportunityIds.length > 1 &&
      !candidate.primaryOpportunityId
    ) {
      context.addIssue({
        code: "custom",
        path: ["primaryOpportunityId"],
        message: "Several related opportunities require one primary link.",
      });
    }
  });

export const createFollowupDraftRequestSchema = z.strictObject({
  entityId: z.uuid(),
  rawInput: z.string().trim().min(1).max(10_000),
  occurredAt: z.iso.datetime().optional(),
});

export const reviseFollowupDraftRequestSchema = z.strictObject({
  versionNo: versionNoSchema,
  candidate: followupDraftCandidateSchema,
});

export const confirmFollowupDraftRequestSchema = z.strictObject({
  versionNo: versionNoSchema,
});

export const cancelFollowupDraftRequestSchema =
  confirmFollowupDraftRequestSchema;

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const followupDraftStatusSchema = z.enum([
  "pending_confirmation",
  "confirmed",
  "cancelled",
  "expired",
]);

export const followupAgentExecutionSchema = z.strictObject({
  provider: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,99}$/),
  model: z.string().trim().min(1).max(200),
  promptVersion: z.string().trim().min(1).max(200),
  status: z.literal("succeeded"),
  providerRequestId: z.string().trim().min(1).max(500).nullable(),
  durationMs: z.number().int().nonnegative().max(600_000),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    })
    .nullable(),
});

export const followupDraftResponseSchema = z
  .strictObject({
    draftId: z.uuid(),
    status: followupDraftStatusSchema,
    rawInput: z.string().trim().min(1).max(10_000),
    candidate: followupDraftCandidateSchema,
    versionNo: versionNoSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    confirmedAt: z.iso.datetime().nullable(),
    confirmedBy: z.uuid().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    followupId: z.uuid().nullable(),
    agentExecution: followupAgentExecutionSchema.optional(),
  })
  .superRefine((draft, context) => {
    if (
      draft.status === "confirmed" &&
      (!draft.confirmedAt || !draft.confirmedBy || !draft.followupId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A confirmed draft requires confirmation metadata.",
      });
    }
    if (draft.status === "cancelled" && !draft.cancelledAt) {
      context.addIssue({
        code: "custom",
        path: ["cancelledAt"],
        message: "A cancelled draft requires its cancellation time.",
      });
    }
  });

export const followupConfirmationResponseSchema = z.strictObject({
  draftId: z.uuid(),
  status: z.literal("confirmed"),
  followupId: z.uuid(),
  eventId: z.uuid(),
  versionNo: versionNoSchema,
  confirmedAt: z.iso.datetime(),
});

export const followupAutomationStatusSchema = z.strictObject({
  eventId: z.uuid(),
  followupId: z.uuid(),
  overallStatus: z.enum(["processing", "completed", "failed"]),
  battleMapStatus: z.enum(["queued", "processing", "completed", "failed"]),
  leaderNotificationStatus: z.enum(["waiting", "completed", "failed"]),
  outboxStatus: z.enum([
    "pending",
    "processing",
    "published",
    "failed",
    "cancelled",
    "dead_lettered",
  ]),
  battleStateVersionId: z.uuid().nullable(),
  leaderNotificationCount: z.number().int().min(0).max(10_000),
  attemptCount: z.number().int().min(0).max(1_000),
  errorMessage: z.string().trim().min(1).max(500).nullable(),
  updatedAt: z.iso.datetime(),
});

export const formalFollowupRecordSchema = z.strictObject({
  followupId: z.uuid(),
  sourceDraftId: z.uuid(),
  entityId: z.uuid(),
  occurredAt: z.iso.datetime(),
  followupType: followupTypeSchema,
  summary: z.string().trim().min(1).max(5_000),
  submittedBy: z.uuid(),
  confirmedBy: z.uuid(),
  confirmedAt: z.iso.datetime(),
  relatedOpportunityIds: z.array(z.uuid()).max(100),
  primaryOpportunityId: z.uuid().nullable(),
  facts: z
    .array(
      z.strictObject({
        factType: factTypeSchema,
        factValue: z.string().trim().min(1).max(5_000),
        opportunityId: z.uuid().nullable(),
      }),
    )
    .max(100),
});

export const followupApiErrorSchema = z.strictObject({
  code: z.enum([
    "DRAFT_NOT_FOUND",
    "FOLLOWUP_NOT_FOUND",
    "DRAFT_VERSION_CONFLICT",
    "DRAFT_NOT_PENDING",
    "DRAFT_EXPIRED",
    "IDEMPOTENCY_KEY_REUSED",
    "RELATED_ENTITY_NOT_FOUND",
    "RELATED_OPPORTUNITY_NOT_FOUND",
    "INVALID_FOLLOWUP_DRAFT",
    "AGENT_UNAVAILABLE",
    "AGENT_INVALID_RESPONSE",
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

export type FollowupType = z.infer<typeof followupTypeSchema>;
export type FollowupAgentExecution = z.infer<
  typeof followupAgentExecutionSchema
>;
export type FollowupFactCandidate = z.infer<typeof followupFactCandidateSchema>;
export type FollowupDraftCandidate = z.infer<
  typeof followupDraftCandidateSchema
>;
export type CreateFollowupDraftRequest = z.infer<
  typeof createFollowupDraftRequestSchema
>;
export type ReviseFollowupDraftRequest = z.infer<
  typeof reviseFollowupDraftRequestSchema
>;
export type ConfirmFollowupDraftRequest = z.infer<
  typeof confirmFollowupDraftRequestSchema
>;
export type FollowupDraftResponse = z.infer<typeof followupDraftResponseSchema>;
export type FollowupConfirmationResponse = z.infer<
  typeof followupConfirmationResponseSchema
>;
export type FollowupAutomationStatus = z.infer<
  typeof followupAutomationStatusSchema
>;
export type FormalFollowupRecord = z.infer<typeof formalFollowupRecordSchema>;
