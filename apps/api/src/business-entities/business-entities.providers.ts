import {
  type BusinessEntityReader,
  ListBusinessEntities,
} from "@battlefield/core";
import { KyselyBusinessEntityReader } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const BUSINESS_ENTITY_READER = Symbol("BUSINESS_ENTITY_READER");
export const LIST_BUSINESS_ENTITIES = Symbol("LIST_BUSINESS_ENTITIES");

const unavailableReader: BusinessEntityReader = {
  async list() {
    throw new Error("Business entity database is not configured.");
  },
};

export const businessEntityProviders: Provider[] = [
  {
    provide: BUSINESS_ENTITY_READER,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): BusinessEntityReader =>
      database
        ? new KyselyBusinessEntityReader(database.db)
        : unavailableReader,
  },
  {
    provide: LIST_BUSINESS_ENTITIES,
    inject: [BUSINESS_ENTITY_READER],
    useFactory: (reader: BusinessEntityReader) =>
      new ListBusinessEntities(reader),
  },
];
