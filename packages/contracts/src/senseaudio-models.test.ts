import { describe, expect, it } from "vitest";

import {
  senseAudioTextModelIdSchema,
  senseAudioTextModelIds,
} from "./senseaudio-models.js";

describe("SenseAudio text model catalog", () => {
  it("exposes the 19 current Chat Completions models without duplicates", () => {
    expect(senseAudioTextModelIds).toHaveLength(19);
    expect(new Set(senseAudioTextModelIds)).toHaveProperty("size", 19);
    expect(senseAudioTextModelIds).toContain("senseaudio-s2-flash");
    expect(senseAudioTextModelIds).toContain("minimax-m2.7");
    expect(senseAudioTextModelIds).toContain("qwen3.6-35b-a3b");
  });

  it("rejects a model that is not in the published catalog", () => {
    expect(senseAudioTextModelIdSchema.safeParse("unknown-model").success).toBe(
      false,
    );
  });
});
