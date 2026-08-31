import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { ManagementQueriesController } from "./management-queries.controller.js";
import { managementQueryProviders } from "./management-queries.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [ManagementQueriesController],
  providers: managementQueryProviders,
})
export class ManagementQueriesModule {}
