import { z } from "zod";

const booleanQuerySchema = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);
const applicationRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .regex(/^\/(?!\/)[^\r\n]*$/);

export const notificationEventTypeSchema = z.enum([
  "action_due",
  "weekly_report_published",
  "sales_progress_updated",
]);
export const notificationPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "urgent",
]);

export const inboxItemSchema = z.strictObject({
  notificationId: z.uuid(),
  eventType: notificationEventTypeSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2_000),
  deepLink: applicationRelativePathSchema,
  priority: notificationPrioritySchema,
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});

export const inboxQuerySchema = z.strictObject({
  unreadOnly: booleanQuerySchema.optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const inboxPageSchema = z.strictObject({
  items: z.array(inboxItemSchema).max(100),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const markNotificationReadResponseSchema = z.strictObject({
  notificationId: z.uuid(),
  readAt: z.iso.datetime(),
});

export const notificationApiErrorSchema = z.strictObject({
  code: z.enum([
    "NOTIFICATION_NOT_FOUND",
    "INVALID_INBOX_QUERY",
    "INVALID_NOTIFICATION_ID",
    "NOTIFICATION_STORE_UNAVAILABLE",
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

export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;
export type InboxItem = z.infer<typeof inboxItemSchema>;
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type InboxPage = z.infer<typeof inboxPageSchema>;
export type MarkNotificationReadResponse = z.infer<
  typeof markNotificationReadResponseSchema
>;
