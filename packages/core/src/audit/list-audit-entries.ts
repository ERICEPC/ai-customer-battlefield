import {
  type AuditEntryPage,
  type AuditLogReader,
  type AuditLogReaderInput,
  InvalidAuditLogListInputError,
} from "./audit-log-reader.js";

export class ListAuditEntries {
  constructor(private readonly reader: AuditLogReader) {}

  async execute(input: AuditLogReaderInput): Promise<AuditEntryPage> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.occurredFrom !== undefined &&
        !Number.isFinite(Date.parse(input.occurredFrom))) ||
      (input.occurredBefore !== undefined &&
        !Number.isFinite(Date.parse(input.occurredBefore))) ||
      (input.occurredFrom !== undefined &&
        input.occurredBefore !== undefined &&
        Date.parse(input.occurredFrom) >= Date.parse(input.occurredBefore))
    ) {
      throw new InvalidAuditLogListInputError();
    }
    return this.reader.list(input);
  }
}
