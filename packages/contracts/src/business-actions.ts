import { z } from "zod";

const versionNoSchema = z.string().regex(/^[1-9]\d*$/);
const prioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const actionProposalStatusSchema = z.enum([
  "pending_confirmation",
  "accepted",
  "rejected",
  "expired",
]);

export const actionProposalRecordSchema = z
  .strictObject({
    proposalId: z.uuid(),
    entityId: z.uuid(),
    entityName: z.string().trim().min(1).max(300),
    opportunityId: z.uuid().nullable(),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(5_000),
    suggestedOwnerId: z.uuid().nullable(),
    suggestedOwnerName: z.string().trim().min(1).max(200).nullable(),
    suggestedPriority: prioritySchema,
    suggestedPlannedAt: z.iso.datetime().nullable(),
    sourceBattleStateVersionId: z.uuid(),
    status: actionProposalStatusSchema,
    versionNo: versionNoSchema,
    proposedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    decidedBy: z.uuid().nullable(),
    decisionReason: z.string().trim().min(1).max(1_000).nullable(),
    actionId: z.uuid().nullable(),
  })
  .superRefine((proposal, context) => {
    if (
      proposal.status === "pending_confirmation" &&
      (proposal.decidedAt ||
        proposal.decidedBy ||
        proposal.decisionReason ||
        proposal.actionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A pending proposal cannot contain decision metadata.",
      });
    }
    if (
      proposal.status === "accepted" &&
      (!proposal.decidedAt || !proposal.decidedBy || !proposal.actionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "An accepted proposal requires decision and action metadata.",
      });
    }
    if (
      proposal.status === "rejected" &&
      (!proposal.decidedAt ||
        !proposal.decidedBy ||
        !proposal.decisionReason ||
        proposal.actionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A rejected proposal requires a reason and no action.",
      });
    }
  });

export const actionProposalListQuerySchema = z.strictObject({
  status: actionProposalStatusSchema.optional(),
  priority: prioritySchema.optional(),
  entityId: z.uuid().optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const actionProposalPageSchema = z.strictObject({
  items: z.array(actionProposalRecordSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const actionOwnerOptionSchema = z.strictObject({
  userId: z.uuid(),
  displayName: z.string().trim().min(1).max(200),
});

export const actionOwnerListQuerySchema = z.strictObject({
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const actionOwnerPageSchema = z.strictObject({
  items: z.array(actionOwnerOptionSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const acceptActionProposalRequestSchema = z.strictObject({
  versionNo: versionNoSchema,
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(5_000),
  ownerUserId: z.uuid(),
  priority: prioritySchema,
  plannedAt: z.iso.datetime(),
});

export const rejectActionProposalRequestSchema = z.strictObject({
  versionNo: versionNoSchema,
  reason: z.string().trim().min(1).max(1_000),
});

export const actionDecisionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    proposalId: z.uuid(),
    status: z.literal("accepted"),
    actionId: z.uuid(),
    versionNo: versionNoSchema,
    decidedAt: z.iso.datetime(),
  }),
  z.strictObject({
    proposalId: z.uuid(),
    status: z.literal("rejected"),
    actionId: z.null(),
    versionNo: versionNoSchema,
    decidedAt: z.iso.datetime(),
  }),
]);

export const businessActionStatusSchema = z.enum([
  "planned",
  "in_progress",
  "completed",
  "cancelled",
]);

export const businessActionRecordSchema = z
  .strictObject({
    actionId: z.uuid(),
    entityId: z.uuid(),
    entityName: z.string().trim().min(1).max(300),
    opportunityId: z.uuid().nullable(),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(5_000),
    ownerUserId: z.uuid(),
    ownerName: z.string().trim().min(1).max(200),
    priority: prioritySchema,
    status: businessActionStatusSchema,
    plannedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    sourceProposalId: z.uuid(),
    confirmedBy: z.uuid(),
    confirmedAt: z.iso.datetime(),
    versionNo: versionNoSchema,
  })
  .superRefine((action, context) => {
    if (action.status === "completed" && !action.completedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A completed action requires its completion time.",
      });
    }
    if (action.status !== "completed" && action.completedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Only completed actions contain a completion time.",
      });
    }
  });

export const transitionBusinessActionRequestSchema = z.strictObject({
  versionNo: versionNoSchema,
  toStatus: businessActionStatusSchema,
  reason: z.string().trim().min(1).max(1_000).optional(),
});

export const actionTransitionResponseSchema = z.strictObject({
  actionId: z.uuid(),
  status: businessActionStatusSchema,
  versionNo: versionNoSchema,
  changedAt: z.iso.datetime(),
});

export const businessActionListQuerySchema = z.strictObject({
  status: businessActionStatusSchema.optional(),
  priority: prioritySchema.optional(),
  entityId: z.uuid().optional(),
  ownerUserId: z.uuid().optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const businessActionPageSchema = z.strictObject({
  items: z.array(businessActionRecordSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const actionApiErrorSchema = z.strictObject({
  code: z.enum([
    "ANALYSIS_NOT_FOUND",
    "ANALYSIS_INPUT_STALE",
    "BATTLE_STATE_NOT_FOUND",
    "ACTION_PROPOSAL_NOT_FOUND",
    "ACTION_PROPOSAL_VERSION_CONFLICT",
    "ACTION_PROPOSAL_NOT_PENDING",
    "ACTION_PROPOSAL_EXPIRED",
    "ACTION_IDEMPOTENCY_KEY_REUSED",
    "ACTION_OWNER_NOT_FOUND",
    "ACTION_NOT_FOUND",
    "ACTION_VERSION_CONFLICT",
    "INVALID_ACTION_TRANSITION",
    "INVALID_BATTLE_ANALYSIS",
    "INVALID_ACTION_DECISION",
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

export type ActionProposalRecord = z.infer<typeof actionProposalRecordSchema>;
export type ActionOwnerOption = z.infer<typeof actionOwnerOptionSchema>;
export type ActionOwnerListQuery = z.infer<typeof actionOwnerListQuerySchema>;
export type ActionOwnerPage = z.infer<typeof actionOwnerPageSchema>;
export type ActionProposalListQuery = z.infer<
  typeof actionProposalListQuerySchema
>;
export type ActionProposalPage = z.infer<typeof actionProposalPageSchema>;
export type AcceptActionProposalRequest = z.infer<
  typeof acceptActionProposalRequestSchema
>;
export type RejectActionProposalRequest = z.infer<
  typeof rejectActionProposalRequestSchema
>;
export type ActionDecisionResponse = z.infer<
  typeof actionDecisionResponseSchema
>;
export type BusinessActionRecord = z.infer<typeof businessActionRecordSchema>;
export type TransitionBusinessActionRequest = z.infer<
  typeof transitionBusinessActionRequestSchema
>;
export type ActionTransitionResponse = z.infer<
  typeof actionTransitionResponseSchema
>;
export type BusinessActionListQuery = z.infer<
  typeof businessActionListQuerySchema
>;
export type BusinessActionPage = z.infer<typeof businessActionPageSchema>;
