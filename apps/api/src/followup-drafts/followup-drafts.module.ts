import { Module } from "@nestjs/common";

import { followupDraftProviders } from "./followup-draft.providers.js";
import { FollowupDraftsController } from "./followup-drafts.controller.js";

@Module({
  controllers: [FollowupDraftsController],
  providers: followupDraftProviders,
})
export class FollowupDraftsModule {}
