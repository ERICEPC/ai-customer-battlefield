import { z } from "zod";

import { senseAudioTextModelIdSchema } from "./senseaudio-models.js";

export const aiRuntimeConfigKeySchema = z.literal("followup_extraction");

export const aiRuntimeParametersSchema = z.strictObject({
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(8_000),
});

export const aiRuntimeConfigVersionSchema = z.strictObject({
  versionId: z.uuid(),
  configKey: aiRuntimeConfigKeySchema,
  versionNo: z.string().regex(/^[1-9][0-9]*$/),
  name: z.string().trim().min(1).max(200),
  provider: z.literal("senseaudio"),
  defaultModelId: senseAudioTextModelIdSchema,
  systemPrompt: z.string().trim().min(1).max(20_000),
  parameters: aiRuntimeParametersSchema,
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const aiRuntimeConfigVersionListQuerySchema = z.strictObject({
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const aiRuntimeConfigVersionPageSchema = z.strictObject({
  items: z.array(aiRuntimeConfigVersionSchema).max(100),
  currentVersionId: z.uuid().nullable(),
  nextCursor: z.string().trim().min(1).max(4_096).nullable(),
});

export const createAiRuntimeConfigVersionRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  defaultModelId: senseAudioTextModelIdSchema,
  systemPrompt: z.string().trim().min(1).max(20_000),
  parameters: aiRuntimeParametersSchema,
});

export const releaseAiRuntimeConfigVersionRequestSchema = z.strictObject({
  versionId: z.uuid(),
  reason: z.string().trim().min(1).max(1_000),
});

export const releasedAiRuntimeConfigSchema = z.strictObject({
  configId: z.uuid(),
  configKey: aiRuntimeConfigKeySchema,
  versionNo: z.string().regex(/^[1-9][0-9]*$/),
  releaseNo: z.string().regex(/^[1-9][0-9]*$/),
  name: z.string().trim().min(1).max(200),
  provider: z.literal("senseaudio"),
  defaultModelId: senseAudioTextModelIdSchema,
  systemPrompt: z.string().trim().min(1).max(20_000),
  parameters: aiRuntimeParametersSchema,
  releasedAt: z.iso.datetime(),
});

export const aiRuntimeConfigApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_AI_RUNTIME_CONFIG_REQUEST",
    "AI_RUNTIME_CONFIG_VERSION_NOT_FOUND",
    "AI_RUNTIME_CONFIG_FORBIDDEN",
    "AI_RUNTIME_CONFIG_UNAVAILABLE",
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

export type AiRuntimeConfigKey = z.infer<typeof aiRuntimeConfigKeySchema>;
export type AiRuntimeConfigVersion = z.infer<
  typeof aiRuntimeConfigVersionSchema
>;
export type AiRuntimeConfigVersionListQuery = z.infer<
  typeof aiRuntimeConfigVersionListQuerySchema
>;
export type AiRuntimeConfigVersionPage = z.infer<
  typeof aiRuntimeConfigVersionPageSchema
>;
export type CreateAiRuntimeConfigVersionRequest = z.infer<
  typeof createAiRuntimeConfigVersionRequestSchema
>;
export type ReleaseAiRuntimeConfigVersionRequest = z.infer<
  typeof releaseAiRuntimeConfigVersionRequestSchema
>;
export type ReleasedAiRuntimeConfig = z.infer<
  typeof releasedAiRuntimeConfigSchema
>;
export type AiRuntimeConfigApiError = z.infer<
  typeof aiRuntimeConfigApiErrorSchema
>;
