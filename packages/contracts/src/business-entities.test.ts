import { describe, expect, it } from "vitest";

import {
  businessEntityListQuerySchema,
  businessEntityPageSchema,
} from "./business-entities.js";

const validItem = {
  id: "10000000-0000-4000-8000-000000000001",
  typeCode: "customer",
  name: "海岳科技",
  shortName: "海岳",
  status: "active",
  isT0: true,
  primaryOwnerName: "销售甲",
  primaryOpportunity: {
    id: "20000000-0000-4000-8000-000000000001",
    name: "年度平台项目",
    stageCode: "proposal",
    stageProgress: "30.00",
  },
  updatedAt: "2026-08-31T03:30:00.000Z",
  versionNo: "3",
};

describe("businessEntityListQuerySchema", () => {
  it("trims search and accepts URL-shaped filters", () => {
    expect(
      businessEntityListQuerySchema.parse({
        status: "active",
        search: "  海岳  ",
        cursor: "opaque-cursor",
        limit: "50",
      }),
    ).toEqual({
      status: "active",
      search: "海岳",
      cursor: "opaque-cursor",
      limit: 50,
    });
  });

  it.each([
    { status: "deleted" },
    { search: "x".repeat(101) },
    { search: "   " },
    { limit: "0" },
    { limit: "101" },
    { limit: "1.5" },
    { unknown: "field" },
  ])("rejects malformed or unknown filters: %o", (input) => {
    expect(businessEntityListQuerySchema.safeParse(input).success).toBe(false);
  });
});

describe("businessEntityPageSchema", () => {
  it("accepts a strict entity row and nullable opaque cursor", () => {
    expect(
      businessEntityPageSchema.parse({ items: [validItem], nextCursor: null }),
    ).toEqual({ items: [validItem], nextCursor: null });
    expect(
      businessEntityPageSchema.parse({
        items: [],
        nextCursor: "eyJ1cGRhdGVkQXQiOiJvcGFxdWUifQ",
      }).nextCursor,
    ).toBe("eyJ1cGRhdGVkQXQiOiJvcGFxdWUifQ");
  });

  it.each([
    { ...validItem, id: "not-a-uuid" },
    { ...validItem, updatedAt: "not-a-timestamp" },
    { ...validItem, versionNo: "0" },
    {
      ...validItem,
      primaryOpportunity: {
        ...validItem.primaryOpportunity,
        stageProgress: 30,
      },
    },
    {
      ...validItem,
      primaryOpportunity: {
        ...validItem.primaryOpportunity,
        stageProgress: "100.01",
      },
    },
    { ...validItem, leakedField: "must-fail" },
  ])("rejects a malformed public row: %o", (item) => {
    expect(
      businessEntityPageSchema.safeParse({ items: [item], nextCursor: null })
        .success,
    ).toBe(false);
  });
});
