import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { BusinessEntitiesController } from "./business-entities.controller.js";
import { businessEntityProviders } from "./business-entities.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [BusinessEntitiesController],
  providers: businessEntityProviders,
})
export class BusinessEntitiesModule {}
