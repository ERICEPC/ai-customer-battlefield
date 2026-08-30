import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { FollowupsController } from "../followups/followups.controller.js";
import { followupDraftProviders } from "./followup-draft.providers.js";
import { FollowupDraftsController } from "./followup-drafts.controller.js";

@Module({
  imports: [DatabaseModule],
  controllers: [FollowupDraftsController, FollowupsController],
  providers: followupDraftProviders,
})
export class FollowupDraftsModule {}
