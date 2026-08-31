import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { DatabaseModule } from "../database/database.module.js";
import { AuthController } from "./auth.controller.js";
import { SessionAuthGuard } from "./auth.guard.js";
import { authProviders } from "./auth.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [
    ...authProviders,
    { provide: APP_GUARD, useClass: SessionAuthGuard },
  ],
  exports: [...authProviders],
})
export class AuthModule {}
