import { Module } from "@nestjs/common";

import { BusinessEntitiesModule } from "./business-entities/business-entities.module.js";
import { FollowupDraftsModule } from "./followup-drafts/followup-drafts.module.js";
import { HealthController } from "./health/health.controller.js";

@Module({
  imports: [BusinessEntitiesModule, FollowupDraftsModule],
  controllers: [HealthController],
})
export class AppModule {}
