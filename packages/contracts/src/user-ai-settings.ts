import { z } from "zod";

import { senseAudioTextModelIdSchema } from "./senseaudio-models.js";

const apiKeySchema = z
  .string()
  .trim()
  .min(20)
  .max(2_000)
  .refine((value) => !/\s/.test(value), "API Key 不能包含空白字符");

export const updateUserAiSettingsRequestSchema = z.strictObject({
  selectedModel: senseAudioTextModelIdSchema,
  apiKey: apiKeySchema.optional(),
});

export const userAiSettingsResponseSchema = z.strictObject({
  selectedModel: senseAudioTextModelIdSchema,
  apiKeyConfigured: z.boolean(),
  apiKeyLastFour: z.string().length(4).nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const testUserAiConnectionResponseSchema = z.strictObject({
  ok: z.literal(true),
  model: senseAudioTextModelIdSchema,
  reply: z.string().trim().min(1).max(2_000),
  providerRequestId: z.string().trim().min(1).max(500).nullable(),
  durationMs: z.number().int().min(0).max(300_000),
});

export const userAiSettingsApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_AI_SETTINGS",
    "AI_SETTINGS_UNAVAILABLE",
    "AI_KEY_NOT_CONFIGURED",
    "AI_CONNECTION_FAILED",
  ]),
  message: z.string().trim().min(1).max(1_000),
  requestId: z.string().trim().min(1).max(200),
});

export type UpdateUserAiSettingsRequest = z.infer<
  typeof updateUserAiSettingsRequestSchema
>;
export type UserAiSettingsResponse = z.infer<
  typeof userAiSettingsResponseSchema
>;
export type TestUserAiConnectionResponse = z.infer<
  typeof testUserAiConnectionResponseSchema
>;
