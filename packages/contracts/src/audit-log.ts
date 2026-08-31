import { z } from "zod";

const auditCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z][a-z0-9_.-]*$/);

export const auditEntryListQuerySchema = z
  .strictObject({
    cursor: z.string().trim().min(1).max(4_096).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    actorUserId: z.uuid().optional(),
    aggregateType: auditCodeSchema.optional(),
    aggregateId: z.uuid().optional(),
    action: auditCodeSchema.optional(),
    occurredFrom: z.iso.datetime().optional(),
    occurredBefore: z.iso.datetime().optional(),
  })
  .superRefine((query, context) => {
    if (
      query.occurredFrom &&
      query.occurredBefore &&
      Date.parse(query.occurredFrom) >= Date.parse(query.occurredBefore)
    ) {
      context.addIssue({
        code: "custom",
        path: ["occurredBefore"],
        message: "occurredBefore must be later than occurredFrom.",
      });
    }
  });

export const auditEntrySchema = z.strictObject({
  entryId: z.uuid(),
  aggregateType: auditCodeSchema,
  aggregateId: z.uuid(),
  action: auditCodeSchema,
  actor: z.strictObject({
    userId: z.uuid(),
    displayName: z.string().trim().min(1).max(200),
  }),
  requestId: z.string().trim().min(1).max(200).nullable(),
  reason: z.string().trim().min(1).max(1_000).nullable(),
  occurredAt: z.iso.datetime(),
});

export const auditEntryPageSchema = z.strictObject({
  items: z.array(auditEntrySchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const auditLogApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_AUDIT_LOG_QUERY",
    "CAPABILITY_FORBIDDEN",
    "AUDIT_LOG_UNAVAILABLE",
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

export type AuditEntryListQuery = z.infer<typeof auditEntryListQuerySchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type AuditEntryPage = z.infer<typeof auditEntryPageSchema>;
export type AuditLogApiError = z.infer<typeof auditLogApiErrorSchema>;
