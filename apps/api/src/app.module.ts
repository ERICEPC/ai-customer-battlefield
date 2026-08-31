import { Module } from "@nestjs/common";

import { BattleAnalysisModule } from "./battle-analysis/battle-analysis.module.js";
import { BusinessActionsModule } from "./business-actions/business-actions.module.js";
import { BusinessEntitiesModule } from "./business-entities/business-entities.module.js";
import { FollowupDraftsModule } from "./followup-drafts/followup-drafts.module.js";
import { HealthController } from "./health/health.controller.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { WorkspaceModule } from "./workspace/workspace.module.js";

@Module({
  imports: [
    BusinessEntitiesModule,
    FollowupDraftsModule,
    BattleAnalysisModule,
    BusinessActionsModule,
    NotificationsModule,
    WorkspaceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
