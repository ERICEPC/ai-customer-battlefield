import {
  type Clock,
  GetWorkspaceSnapshot,
  type WorkspaceReader,
} from "@battlefield/core";
import { KyselyWorkspaceReader } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const WORKSPACE_READER = Symbol("WORKSPACE_READER");
export const WORKSPACE_CLOCK = Symbol("WORKSPACE_CLOCK");
export const GET_WORKSPACE_SNAPSHOT = Symbol("GET_WORKSPACE_SNAPSHOT");

export class WorkspaceUnavailableError extends Error {
  constructor() {
    super("Workspace persistence is not configured.");
    this.name = "WorkspaceUnavailableError";
  }
}

const unavailableReader: WorkspaceReader = {
  async read() {
    throw new WorkspaceUnavailableError();
  },
};

const systemClock: Clock = {
  now: () => new Date(),
};

export const workspaceProviders: Provider[] = [
  {
    provide: WORKSPACE_READER,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): WorkspaceReader =>
      database ? new KyselyWorkspaceReader(database.db) : unavailableReader,
  },
  {
    provide: WORKSPACE_CLOCK,
    useValue: systemClock,
  },
  {
    provide: GET_WORKSPACE_SNAPSHOT,
    inject: [WORKSPACE_READER, WORKSPACE_CLOCK],
    useFactory: (reader: WorkspaceReader, clock: Clock) =>
      new GetWorkspaceSnapshot({ reader, clock }),
  },
];
