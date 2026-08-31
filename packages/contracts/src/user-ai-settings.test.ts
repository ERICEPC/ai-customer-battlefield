import { describe, expect, it } from "vitest";

import {
  testUserAiConnectionResponseSchema,
  updateUserAiSettingsRequestSchema,
  userAiSettingsResponseSchema,
} from "./user-ai-settings.js";

describe("user AI settings contracts", () => {
  it("accepts a catalog model and a private API key for update", () => {
    expect(
      updateUserAiSettingsRequestSchema.parse({
        selectedModel: "senseaudio-s2-flash",
        apiKey: "sk-example-secret-with-enough-length",
      }),
    ).toEqual({
      selectedModel: "senseaudio-s2-flash",
      apiKey: "sk-example-secret-with-enough-length",
    });
  });

  it("never includes the API key in a settings response", () => {
    expect(
      userAiSettingsResponseSchema.safeParse({
        selectedModel: "senseaudio-s2-flash",
        apiKeyConfigured: true,
        apiKeyLastFour: "demo",
        apiKey: "must-not-leak",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates a visible connection receipt", () => {
    expect(
      testUserAiConnectionResponseSchema.parse({
        ok: true,
        model: "senseaudio-s2-flash",
        reply: "连接成功",
        providerRequestId: "chatcmpl-demo",
        durationMs: 321,
      }),
    ).toMatchObject({ ok: true, reply: "连接成功" });
  });
});
