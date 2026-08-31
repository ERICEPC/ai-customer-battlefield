import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export interface AiRuntimeConfig {
  configId: string;
  configKey: string;
  versionNo: string;
  releaseNo: string;
  name: string;
  provider: "senseaudio";
  defaultModelId: string;
  systemPrompt: string;
  parameters: {
    temperature: number;
    maxTokens: number;
  };
  releasedAt: string;
}

export interface AiRuntimeConfigReader {
  resolve(input: {
    actor: ActorScope;
    configKey: string;
  }): Promise<AiRuntimeConfig | null>;
}

export class InvalidAiRuntimeConfigError extends Error {
  constructor() {
    super("Published AI runtime configuration is invalid.");
    this.name = "InvalidAiRuntimeConfigError";
  }
}
