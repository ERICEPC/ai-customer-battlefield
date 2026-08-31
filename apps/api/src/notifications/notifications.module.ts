import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { InboxController } from "./inbox.controller.js";
import { notificationProviders } from "./notifications.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [InboxController],
  providers: notificationProviders,
})
export class NotificationsModule {}
