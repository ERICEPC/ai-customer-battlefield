import { describe, expect, test, vi } from "vitest";

import type { AuditLogReader } from "./audit-log-reader.js";
import { InvalidAuditLogListInputError } from "./audit-log-reader.js";
import { ListAuditEntries } from "./list-audit-entries.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};

describe("ListAuditEntries", () => {
  test("delegates strict filters without changing actor scope", async () => {
    const list = vi.fn<AuditLogReader["list"]>().mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    const useCase = new ListAuditEntries({ list });
    const input = {
      actor,
      limit: 25,
      aggregateType: "followup",
      occurredFrom: "2026-08-01T00:00:00.000Z",
      occurredBefore: "2026-09-01T00:00:00.000Z",
    };

    await expect(useCase.execute(input)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(list).toHaveBeenCalledWith(input);
  });

  test("rejects invalid limits or reversed periods before persistence", async () => {
    const list = vi.fn<AuditLogReader["list"]>();
    const useCase = new ListAuditEntries({ list });

    await expect(useCase.execute({ actor, limit: 0 })).rejects.toBeInstanceOf(
      InvalidAuditLogListInputError,
    );
    await expect(
      useCase.execute({
        actor,
        limit: 20,
        occurredFrom: "2026-09-01T00:00:00.000Z",
        occurredBefore: "2026-08-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(InvalidAuditLogListInputError);
    expect(list).not.toHaveBeenCalled();
  });
});
