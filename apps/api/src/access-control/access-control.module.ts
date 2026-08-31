import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { AccessControlController } from "./access-control.controller.js";
import { accessControlProviders } from "./access-control.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [AccessControlController],
  providers: accessControlProviders,
})
export class AccessControlModule {}
