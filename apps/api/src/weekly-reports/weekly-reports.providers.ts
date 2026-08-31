import {
  type Clock,
  GenerateWeeklyReport,
  GetWeeklyReport,
  ListWeeklyReports,
  PublishWeeklyReport,
  ReviewWeeklyReport,
  ReviseWeeklyReport,
  type WeeklyReportRepository,
} from "@battlefield/core";
import { KyselyWeeklyReportRepository } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const WEEKLY_REPORT_REPOSITORY = Symbol("WEEKLY_REPORT_REPOSITORY");
export const WEEKLY_REPORT_CLOCK = Symbol("WEEKLY_REPORT_CLOCK");
export const GENERATE_WEEKLY_REPORT = Symbol("GENERATE_WEEKLY_REPORT");
export const LIST_WEEKLY_REPORTS = Symbol("LIST_WEEKLY_REPORTS");
export const GET_WEEKLY_REPORT = Symbol("GET_WEEKLY_REPORT");
export const REVIEW_WEEKLY_REPORT = Symbol("REVIEW_WEEKLY_REPORT");
export const PUBLISH_WEEKLY_REPORT = Symbol("PUBLISH_WEEKLY_REPORT");
export const REVISE_WEEKLY_REPORT = Symbol("REVISE_WEEKLY_REPORT");

export class WeeklyReportUnavailableError extends Error {
  constructor() {
    super("Weekly-report persistence is not configured.");
    this.name = "WeeklyReportUnavailableError";
  }
}

async function unavailable(): Promise<never> {
  throw new WeeklyReportUnavailableError();
}

const unavailableRepository: WeeklyReportRepository = {
  generate: unavailable,
  list: unavailable,
  get: unavailable,
  review: unavailable,
  publish: unavailable,
  revise: unavailable,
};

const systemClock: Clock = { now: () => new Date() };

export const weeklyReportProviders: Provider[] = [
  {
    provide: WEEKLY_REPORT_REPOSITORY,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): WeeklyReportRepository =>
      database
        ? new KyselyWeeklyReportRepository(database.db)
        : unavailableRepository,
  },
  { provide: WEEKLY_REPORT_CLOCK, useValue: systemClock },
  {
    provide: GENERATE_WEEKLY_REPORT,
    inject: [WEEKLY_REPORT_REPOSITORY, WEEKLY_REPORT_CLOCK],
    useFactory: (repository: WeeklyReportRepository, clock: Clock) =>
      new GenerateWeeklyReport({ repository, clock }),
  },
  {
    provide: LIST_WEEKLY_REPORTS,
    inject: [WEEKLY_REPORT_REPOSITORY],
    useFactory: (repository: WeeklyReportRepository) =>
      new ListWeeklyReports({ repository }),
  },
  {
    provide: GET_WEEKLY_REPORT,
    inject: [WEEKLY_REPORT_REPOSITORY],
    useFactory: (repository: WeeklyReportRepository) =>
      new GetWeeklyReport({ repository }),
  },
  {
    provide: REVIEW_WEEKLY_REPORT,
    inject: [WEEKLY_REPORT_REPOSITORY],
    useFactory: (repository: WeeklyReportRepository) =>
      new ReviewWeeklyReport({ repository }),
  },
  {
    provide: PUBLISH_WEEKLY_REPORT,
    inject: [WEEKLY_REPORT_REPOSITORY],
    useFactory: (repository: WeeklyReportRepository) =>
      new PublishWeeklyReport({ repository }),
  },
  {
    provide: REVISE_WEEKLY_REPORT,
    inject: [WEEKLY_REPORT_REPOSITORY],
    useFactory: (repository: WeeklyReportRepository) =>
      new ReviseWeeklyReport({ repository }),
  },
];
