import {
  GetWorkerOperationsHealth,
  ListAsyncWorkFailures,
  ReplayAsyncWorkItem,
  type WorkerOperationsRepository,
} from "@battlefield/core";
import { KyselyWorkerOperationsRepository } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const WORKER_OPERATIONS_REPOSITORY = Symbol(
  "WORKER_OPERATIONS_REPOSITORY",
);
export const GET_WORKER_OPERATIONS_HEALTH = Symbol(
  "GET_WORKER_OPERATIONS_HEALTH",
);
export const LIST_ASYNC_WORK_FAILURES = Symbol("LIST_ASYNC_WORK_FAILURES");
export const REPLAY_ASYNC_WORK_ITEM = Symbol("REPLAY_ASYNC_WORK_ITEM");

export class WorkerOperationsUnavailableError extends Error {
  constructor() {
    super("Worker operations persistence is not configured.");
    this.name = "WorkerOperationsUnavailableError";
  }
}

const unavailableRepository: WorkerOperationsRepository = {
  getHealth: async () => {
    throw new WorkerOperationsUnavailableError();
  },
  listFailures: async () => {
    throw new WorkerOperationsUnavailableError();
  },
  replay: async () => {
    throw new WorkerOperationsUnavailableError();
  },
};

export const workerOperationsProviders: Provider[] = [
  {
    provide: WORKER_OPERATIONS_REPOSITORY,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): WorkerOperationsRepository =>
      database
        ? new KyselyWorkerOperationsRepository(database.db)
        : unavailableRepository,
  },
  {
    provide: GET_WORKER_OPERATIONS_HEALTH,
    inject: [WORKER_OPERATIONS_REPOSITORY],
    useFactory: (repository: WorkerOperationsRepository) =>
      new GetWorkerOperationsHealth(repository),
  },
  {
    provide: LIST_ASYNC_WORK_FAILURES,
    inject: [WORKER_OPERATIONS_REPOSITORY],
    useFactory: (repository: WorkerOperationsRepository) =>
      new ListAsyncWorkFailures(repository),
  },
  {
    provide: REPLAY_ASYNC_WORK_ITEM,
    inject: [WORKER_OPERATIONS_REPOSITORY],
    useFactory: (repository: WorkerOperationsRepository) =>
      new ReplayAsyncWorkItem(repository),
  },
];
