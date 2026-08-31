import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { UserAiSettingsController } from "./user-ai-settings.controller.js";
import { userAiSettingsProviders } from "./user-ai-settings.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [UserAiSettingsController],
  providers: userAiSettingsProviders,
  exports: userAiSettingsProviders,
})
export class UserAiSettingsModule {}
