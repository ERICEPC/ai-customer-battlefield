import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { ActionOwnersController } from "./action-owners.controller.js";
import { ActionProposalsController } from "./action-proposals.controller.js";
import { BusinessActionsController } from "./business-actions.controller.js";
import { businessActionProviders } from "./business-actions.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [
    ActionOwnersController,
    ActionProposalsController,
    BusinessActionsController,
  ],
  providers: businessActionProviders,
})
export class BusinessActionsModule {}
