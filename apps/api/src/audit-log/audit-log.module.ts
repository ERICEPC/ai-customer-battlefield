import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { AuditLogController } from "./audit-log.controller.js";
import { auditLogProviders } from "./audit-log.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [AuditLogController],
  providers: auditLogProviders,
})
export class AuditLogModule {}
