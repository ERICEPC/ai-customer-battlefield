import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { ActionProposalsController } from "./action-proposals.controller.js";
import { BusinessActionsController } from "./business-actions.controller.js";
import { businessActionProviders } from "./business-actions.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [ActionProposalsController, BusinessActionsController],
  providers: businessActionProviders,
})
export class BusinessActionsModule {}
