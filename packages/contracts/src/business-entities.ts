import { z } from "zod";

export const businessEntityStatusSchema = z.enum([
  "active",
  "inactive",
  "archived",
]);

export const businessEntityListQuerySchema = z.strictObject({
  status: businessEntityStatusSchema.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const stageProgressSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) <= 100);

const primaryOpportunitySchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(500),
  stageCode: z.string().trim().min(1).max(100),
  stageLabel: z.string().trim().min(1).max(200),
  stageProgress: stageProgressSchema,
});

const latestFollowupSchema = z.strictObject({
  followupId: z.uuid(),
  summary: z.string().trim().min(1).max(500),
  confirmedAt: z.iso.datetime(),
});

export const businessEntityListItemSchema = z.strictObject({
  id: z.uuid(),
  typeCode: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(500),
  shortName: z.string().trim().min(1).max(200).nullable(),
  status: businessEntityStatusSchema,
  isT0: z.boolean(),
  primaryOwnerName: z.string().trim().min(1).max(200).nullable(),
  primaryOpportunity: primaryOpportunitySchema.nullable(),
  latestFollowup: latestFollowupSchema.nullable(),
  updatedAt: z.iso.datetime(),
  versionNo: z.string().regex(/^[1-9]\d*$/),
});

export const businessEntityPageSchema = z.strictObject({
  items: z.array(businessEntityListItemSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export type BusinessEntityStatus = z.infer<typeof businessEntityStatusSchema>;
export type BusinessEntityListQuery = z.infer<
  typeof businessEntityListQuerySchema
>;
export type BusinessEntityListItem = z.infer<
  typeof businessEntityListItemSchema
>;
export type BusinessEntityPage = z.infer<typeof businessEntityPageSchema>;
