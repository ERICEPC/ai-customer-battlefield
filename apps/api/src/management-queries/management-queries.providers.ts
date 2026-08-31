import {
  type Clock,
  ListManagementQuerySubjects,
  type ManagementQueryRepository,
  RunManagementQuery,
} from "@battlefield/core";
import { KyselyManagementQueryRepository } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const MANAGEMENT_QUERY_REPOSITORY = Symbol(
  "MANAGEMENT_QUERY_REPOSITORY",
);
export const MANAGEMENT_QUERY_CLOCK = Symbol("MANAGEMENT_QUERY_CLOCK");
export const LIST_MANAGEMENT_QUERY_SUBJECTS = Symbol(
  "LIST_MANAGEMENT_QUERY_SUBJECTS",
);
export const RUN_MANAGEMENT_QUERY = Symbol("RUN_MANAGEMENT_QUERY");

export class ManagementQueryUnavailableError extends Error {
  constructor() {
    super("Management-query persistence is not configured.");
    this.name = "ManagementQueryUnavailableError";
  }
}

async function unavailable(): Promise<never> {
  throw new ManagementQueryUnavailableError();
}

const unavailableRepository: ManagementQueryRepository = {
  listSubjects: unavailable,
  runSalesWeeklyProgress: unavailable,
};

const systemClock: Clock = {
  now: () => new Date(),
};

export const managementQueryProviders: Provider[] = [
  {
    provide: MANAGEMENT_QUERY_REPOSITORY,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): ManagementQueryRepository =>
      database
        ? new KyselyManagementQueryRepository(database.db)
        : unavailableRepository,
  },
  {
    provide: MANAGEMENT_QUERY_CLOCK,
    useValue: systemClock,
  },
  {
    provide: LIST_MANAGEMENT_QUERY_SUBJECTS,
    inject: [MANAGEMENT_QUERY_REPOSITORY],
    useFactory: (repository: ManagementQueryRepository) =>
      new ListManagementQuerySubjects({ repository }),
  },
  {
    provide: RUN_MANAGEMENT_QUERY,
    inject: [MANAGEMENT_QUERY_REPOSITORY, MANAGEMENT_QUERY_CLOCK],
    useFactory: (repository: ManagementQueryRepository, clock: Clock) =>
      new RunManagementQuery({ repository, clock }),
  },
];
