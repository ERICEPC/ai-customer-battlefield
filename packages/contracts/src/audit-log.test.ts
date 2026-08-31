import { describe, expect, test } from "vitest";

import {
  auditEntryListQuerySchema,
  auditEntryPageSchema,
} from "./audit-log.js";

describe("audit log contracts", () => {
  test("accepts strict filters and a metadata-only page", () => {
    expect(
      auditEntryListQuerySchema.parse({
        limit: "25",
        actorUserId: "30000000-0000-4000-8000-000000000001",
        aggregateType: "followup",
        aggregateId: "50000000-0000-4000-8000-000000000001",
        action: "followup.viewed",
        occurredFrom: "2026-08-01T00:00:00.000Z",
        occurredBefore: "2026-09-01T00:00:00.000Z",
      }),
    ).toMatchObject({ limit: 25, aggregateType: "followup" });
    expect(
      auditEntryPageSchema.parse({
        items: [
          {
            entryId: "80000000-0000-4000-8000-000000000001",
            aggregateType: "followup",
            aggregateId: "50000000-0000-4000-8000-000000000001",
            action: "followup.viewed",
            actor: {
              userId: "30000000-0000-4000-8000-000000000001",
              displayName: "销售1",
            },
            requestId: "request-1",
            reason: null,
            occurredAt: "2026-08-31T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).items[0],
    ).not.toHaveProperty("afterPayload");
  });

  test("rejects reversed periods and unknown query fields", () => {
    expect(
      auditEntryListQuerySchema.safeParse({
        occurredFrom: "2026-09-01T00:00:00.000Z",
        occurredBefore: "2026-08-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      auditEntryListQuerySchema.safeParse({ tenantId: crypto.randomUUID() })
        .success,
    ).toBe(false);
  });
});
