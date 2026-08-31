import { z } from "zod";

/**
 * SenseAudio Chat Completions model IDs published on 2026-08-31.
 * Keep this catalog versioned so UI choices and backend validation stay aligned.
 */
export const senseAudioTextModelIds = [
  "senseaudio-s2",
  "senseaudio-s1",
  "senseaudio-s2-flash",
  "senseaudio-s2-lite",
  "senseaudio-vl-1.0-260319",
  "senseaudio-vl-lite-1.0-260319",
  "sensenova-6.8-flash-lite",
  "deepseek-v4-flash-0731",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "doubao-seed-2-0-pro-260215",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "kimi-k2.6",
  "minimax-m2.7",
  "qwen3.8-27b",
  "qwen3.6-27b",
  "qwen3.6-35b-a3b",
] as const;

export const senseAudioTextModelIdSchema = z.enum(senseAudioTextModelIds);

export type SenseAudioTextModelId = z.infer<typeof senseAudioTextModelIdSchema>;
