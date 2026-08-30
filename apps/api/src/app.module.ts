import { Module } from "@nestjs/common";

import { FollowupDraftsModule } from "./followup-drafts/followup-drafts.module.js";
import { HealthController } from "./health/health.controller.js";

@Module({
  imports: [FollowupDraftsModule],
  controllers: [HealthController],
})
export class AppModule {}
