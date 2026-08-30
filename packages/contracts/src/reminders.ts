import { z } from "zod";

const versionNoSchema = z.string().regex(/^[1-9]\d*$/);

export const reminderKindSchema = z.enum([
  "advance",
  "due",
  "overdue",
  "escalation",
]);

export const reminderStatusSchema = z.enum([
  "scheduled",
  "processing",
  "notified",
  "failed",
  "cancelled",
  "dead_lettered",
]);

export const reminderInstanceSchema = z.strictObject({
  reminderId: z.uuid(),
  actionId: z.uuid(),
  recipientUserId: z.uuid(),
  kind: reminderKindSchema,
  remindAt: z.iso.datetime(),
  status: reminderStatusSchema,
  policyVersion: versionNoSchema,
});

export type ReminderKind = z.infer<typeof reminderKindSchema>;
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;
export type ReminderInstance = z.infer<typeof reminderInstanceSchema>;
