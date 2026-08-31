import {
  type AccessControlRepository,
  GetAccessControlSnapshot,
  ReplaceRoleCapabilities,
} from "@battlefield/core";
import { KyselyAccessControlManager } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const ACCESS_CONTROL_REPOSITORY = Symbol("ACCESS_CONTROL_REPOSITORY");
export const GET_ACCESS_CONTROL_SNAPSHOT = Symbol(
  "GET_ACCESS_CONTROL_SNAPSHOT",
);
export const REPLACE_ROLE_CAPABILITIES = Symbol("REPLACE_ROLE_CAPABILITIES");

export class AccessControlUnavailableError extends Error {
  constructor() {
    super("Access-control persistence is not configured.");
    this.name = "AccessControlUnavailableError";
  }
}

const unavailableRepository: AccessControlRepository = {
  getSnapshot: async () => {
    throw new AccessControlUnavailableError();
  },
  replaceRoleCapabilities: async () => {
    throw new AccessControlUnavailableError();
  },
};

export const accessControlProviders: Provider[] = [
  {
    provide: ACCESS_CONTROL_REPOSITORY,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): AccessControlRepository =>
      database
        ? new KyselyAccessControlManager(database.db)
        : unavailableRepository,
  },
  {
    provide: GET_ACCESS_CONTROL_SNAPSHOT,
    inject: [ACCESS_CONTROL_REPOSITORY],
    useFactory: (repository: AccessControlRepository) =>
      new GetAccessControlSnapshot(repository),
  },
  {
    provide: REPLACE_ROLE_CAPABILITIES,
    inject: [ACCESS_CONTROL_REPOSITORY],
    useFactory: (repository: AccessControlRepository) =>
      new ReplaceRoleCapabilities(repository),
  },
];
