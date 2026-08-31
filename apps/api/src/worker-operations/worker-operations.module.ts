import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { WorkerOperationsController } from "./worker-operations.controller.js";
import { workerOperationsProviders } from "./worker-operations.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [WorkerOperationsController],
  providers: workerOperationsProviders,
})
export class WorkerOperationsModule {}
