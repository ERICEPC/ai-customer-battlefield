import { type AuditLogReader, ListAuditEntries } from "@battlefield/core";
import { KyselyAuditLogReader } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const AUDIT_LOG_READER = Symbol("AUDIT_LOG_READER");
export const LIST_AUDIT_ENTRIES = Symbol("LIST_AUDIT_ENTRIES");

export class AuditLogUnavailableError extends Error {
  constructor() {
    super("Audit-log persistence is not configured.");
    this.name = "AuditLogUnavailableError";
  }
}

const unavailableReader: AuditLogReader = {
  list: async () => {
    throw new AuditLogUnavailableError();
  },
};

export const auditLogProviders: Provider[] = [
  {
    provide: AUDIT_LOG_READER,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): AuditLogReader =>
      database ? new KyselyAuditLogReader(database.db) : unavailableReader,
  },
  {
    provide: LIST_AUDIT_ENTRIES,
    inject: [AUDIT_LOG_READER],
    useFactory: (reader: AuditLogReader) => new ListAuditEntries(reader),
  },
];
