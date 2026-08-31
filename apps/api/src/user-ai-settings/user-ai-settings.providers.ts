import { randomBytes } from "node:crypto";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";
import { UserAiSettingsService } from "./user-ai-settings.service.js";

export const USER_AI_SETTINGS_SERVICE = Symbol("USER_AI_SETTINGS_SERVICE");

export type ApplicationUserAiSettingsService = UserAiSettingsService | null;

export const userAiSettingsProviders: Provider[] = [
  {
    provide: USER_AI_SETTINGS_SERVICE,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): ApplicationUserAiSettingsService => {
      if (!database) return null;
      return new UserAiSettingsService({
        database: database.db,
        encryptionKey: credentialEncryptionKey(process.env),
        ...(process.env.SENSEAUDIO_BASE_URL?.trim()
          ? { baseUrl: process.env.SENSEAUDIO_BASE_URL.trim() }
          : {}),
      });
    },
  },
];

function credentialEncryptionKey(environment: NodeJS.ProcessEnv): Buffer {
  const configured = environment.AI_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!configured) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "AI_CREDENTIAL_ENCRYPTION_KEY is required in production.",
      );
    }
    return randomBytes(32);
  }
  const decoded = /^[a-f0-9]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64");
  if (decoded.byteLength !== 32) {
    throw new Error(
      "AI_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex or base64 value.",
    );
  }
  return decoded;
}
