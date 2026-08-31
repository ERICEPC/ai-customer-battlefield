import { Module } from "@nestjs/common";

import { AuthModule } from "./auth/auth.module.js";
import { BattleAnalysisModule } from "./battle-analysis/battle-analysis.module.js";
import { BusinessActionsModule } from "./business-actions/business-actions.module.js";
import { BusinessEntitiesModule } from "./business-entities/business-entities.module.js";
import { FollowupDraftsModule } from "./followup-drafts/followup-drafts.module.js";
import { HealthController } from "./health/health.controller.js";
import { ManagementQueriesModule } from "./management-queries/management-queries.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { UserAiSettingsModule } from "./user-ai-settings/user-ai-settings.module.js";
import { WeeklyReportsModule } from "./weekly-reports/weekly-reports.module.js";
import { WorkspaceModule } from "./workspace/workspace.module.js";

@Module({
  imports: [
    AuthModule,
    BusinessEntitiesModule,
    FollowupDraftsModule,
    BattleAnalysisModule,
    BusinessActionsModule,
    NotificationsModule,
    UserAiSettingsModule,
    WorkspaceModule,
    ManagementQueriesModule,
    WeeklyReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
