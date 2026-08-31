import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { WorkspaceController } from "./workspace.controller.js";
import { workspaceProviders } from "./workspace.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [WorkspaceController],
  providers: workspaceProviders,
})
export class WorkspaceModule {}
