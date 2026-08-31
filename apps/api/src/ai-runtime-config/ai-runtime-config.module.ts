import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { AiRuntimeConfigController } from "./ai-runtime-config.controller.js";
import { aiRuntimeConfigProviders } from "./ai-runtime-config.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [AiRuntimeConfigController],
  providers: aiRuntimeConfigProviders,
})
export class AiRuntimeConfigModule {}
