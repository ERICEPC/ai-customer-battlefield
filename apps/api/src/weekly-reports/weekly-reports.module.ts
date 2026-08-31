import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { WeeklyReportsController } from "./weekly-reports.controller.js";
import { weeklyReportProviders } from "./weekly-reports.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [WeeklyReportsController],
  providers: weeklyReportProviders,
})
export class WeeklyReportsModule {}
