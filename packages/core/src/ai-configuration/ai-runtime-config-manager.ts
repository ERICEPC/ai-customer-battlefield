import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type { AiRuntimeConfig } from "./ai-runtime-config-reader.js";

export interface AiRuntimeConfigVersionRecord {
  versionId: string;
  configKey: string;
  versionNo: string;
  name: string;
  provider: "senseaudio";
  defaultModelId: string;
  systemPrompt: string;
  parameters: {
    temperature: number;
    maxTokens: number;
  };
  contentFingerprint: string;
  createdBy: string;
  createdAt: string;
}

export interface AiRuntimeConfigVersionPage {
  items: AiRuntimeConfigVersionRecord[];
  currentVersionId: string | null;
  nextCursor: string | null;
}

export interface AiRuntimeConfigManager {
  listVersions(input: {
    actor: ActorScope;
    configKey: string;
    limit: number;
    cursor?: string;
  }): Promise<AiRuntimeConfigVersionPage>;
  createVersion(input: {
    actor: ActorScope;
    configKey: string;
    name: string;
    defaultModelId: string;
    systemPrompt: string;
    parameters: { temperature: number; maxTokens: number };
  }): Promise<AiRuntimeConfigVersionRecord>;
  releaseVersion(input: {
    actor: ActorScope;
    configKey: string;
    versionId: string;
    reason: string;
  }): Promise<AiRuntimeConfig>;
}

export class AiRuntimeConfigVersionNotFoundError extends Error {
  constructor() {
    super("AI runtime configuration version was not found.");
    this.name = "AiRuntimeConfigVersionNotFoundError";
  }
}

export class InvalidAiRuntimeConfigManagementInputError extends Error {
  constructor() {
    super("AI runtime configuration management input is invalid.");
    this.name = "InvalidAiRuntimeConfigManagementInputError";
  }
}

export class InvalidAiRuntimeConfigCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super("AI runtime configuration cursor is invalid.", options);
    this.name = "InvalidAiRuntimeConfigCursorError";
  }
}

export class AiRuntimeConfigAccessDeniedError extends Error {
  constructor() {
    super("Current actor cannot manage tenant AI runtime configuration.");
    this.name = "AiRuntimeConfigAccessDeniedError";
  }
}
