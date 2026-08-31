import type { AiRuntimeConfigManager } from "@battlefield/core";
import { KyselyAiRuntimeConfigStore } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const AI_RUNTIME_CONFIG_MANAGER = Symbol("AI_RUNTIME_CONFIG_MANAGER");

export class AiRuntimeConfigUnavailableError extends Error {
  constructor() {
    super("AI runtime configuration persistence is not configured.");
    this.name = "AiRuntimeConfigUnavailableError";
  }
}

const unavailableManager: AiRuntimeConfigManager = {
  listVersions: async () => {
    throw new AiRuntimeConfigUnavailableError();
  },
  createVersion: async () => {
    throw new AiRuntimeConfigUnavailableError();
  },
  releaseVersion: async () => {
    throw new AiRuntimeConfigUnavailableError();
  },
};

export const aiRuntimeConfigProviders: Provider[] = [
  {
    provide: AI_RUNTIME_CONFIG_MANAGER,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): AiRuntimeConfigManager =>
      database
        ? new KyselyAiRuntimeConfigStore(database.db)
        : unavailableManager,
  },
];
