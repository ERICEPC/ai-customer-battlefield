import { z } from "zod";

export const createFollowupDraftRequestSchema = z.strictObject({
  rawInput: z.string().trim().min(1).max(10_000),
});

const followupDraftCandidateSchema = z.strictObject({
  summary: z.string().trim().min(1).max(5_000),
  relatedOpportunityIds: z.array(z.string().trim().min(1)).max(100),
});

export const followupDraftResponseSchema = z.strictObject({
  draftId: z.string().trim().min(1),
  status: z.literal("pending_confirmation"),
  rawInput: z.string().trim().min(1).max(10_000),
  candidate: followupDraftCandidateSchema,
  createdAt: z.iso.datetime(),
});

export type CreateFollowupDraftRequest = z.infer<
  typeof createFollowupDraftRequestSchema
>;
export type FollowupDraftResponse = z.infer<typeof followupDraftResponseSchema>;
