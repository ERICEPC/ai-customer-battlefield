import { describe, expect, test } from "vitest";

import {
  aiRuntimeConfigVersionListQuerySchema,
  createAiRuntimeConfigVersionRequestSchema,
  releaseAiRuntimeConfigVersionRequestSchema,
} from "./ai-runtime-config.js";

describe("AI runtime configuration contracts", () => {
  test("accepts a supported model and bounded runtime parameters", () => {
    expect(
      createAiRuntimeConfigVersionRequestSchema.parse({
        name: "销售跟进拆解 V1",
        defaultModelId: "senseaudio-s2-flash",
        systemPrompt: "只提取销售原文明确表达的事实。",
        parameters: { temperature: 0.1, maxTokens: 1200 },
      }),
    ).toMatchObject({ defaultModelId: "senseaudio-s2-flash" });
  });

  test("rejects unsupported models, unknown fields and unsafe parameters", () => {
    expect(
      createAiRuntimeConfigVersionRequestSchema.safeParse({
        name: "越界配置",
        defaultModelId: "unknown-model",
        systemPrompt: "prompt",
        parameters: { temperature: 3, maxTokens: 0 },
        apiKey: "must-not-be-managed-here",
      }).success,
    ).toBe(false);
    expect(
      aiRuntimeConfigVersionListQuerySchema.safeParse({
        tenantId: "10000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  test("requires an explicit reason for each publish or rollback", () => {
    expect(
      releaseAiRuntimeConfigVersionRequestSchema.safeParse({
        versionId: "a1000000-0000-4000-8000-000000000001",
        reason: "",
      }).success,
    ).toBe(false);
  });
});
