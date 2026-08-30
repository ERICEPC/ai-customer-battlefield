import { describe, expect, it } from "vitest";

import type {
  BusinessEntityPage,
  BusinessEntityReader,
  BusinessEntityReaderInput,
} from "./business-entity-reader.js";
import {
  InvalidBusinessEntityListInputError,
  ListBusinessEntities,
} from "./list-business-entities.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000001",
};

const page: BusinessEntityPage = {
  items: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      typeCode: "customer",
      name: "海岳科技",
      shortName: "海岳",
      status: "active",
      isT0: true,
      primaryOwnerName: "销售甲",
      primaryOpportunity: null,
      updatedAt: "2026-08-31T03:30:00.000Z",
      versionNo: "1",
    },
  ],
  nextCursor: null,
};

class RecordingBusinessEntityReader implements BusinessEntityReader {
  readonly inputs: BusinessEntityReaderInput[] = [];

  constructor(private readonly pageToReturn: BusinessEntityPage) {}

  async list(input: BusinessEntityReaderInput): Promise<BusinessEntityPage> {
    this.inputs.push(input);
    return this.pageToReturn;
  }
}

describe("ListBusinessEntities", () => {
  it("normalizes search, applies the default limit, and returns the reader page", async () => {
    const reader = new RecordingBusinessEntityReader(page);
    const useCase = new ListBusinessEntities(reader);

    const result = await useCase.execute({
      actor,
      search: "  海岳  ",
    });

    expect(reader.inputs).toEqual([
      {
        actor,
        search: "海岳",
        limit: 20,
      },
    ]);
    expect(result).toBe(page);
  });

  it("passes an opaque cursor and explicit filters through unchanged", async () => {
    const reader = new RecordingBusinessEntityReader({
      items: [],
      nextCursor: "next-opaque-cursor",
    });
    const useCase = new ListBusinessEntities(reader);

    const result = await useCase.execute({
      actor,
      status: "inactive",
      search: "   ",
      cursor: "current-opaque-cursor",
      limit: 25,
    });

    expect(reader.inputs).toEqual([
      {
        actor,
        status: "inactive",
        cursor: "current-opaque-cursor",
        limit: 25,
      },
    ]);
    expect(result.nextCursor).toBe("next-opaque-cursor");
  });

  it.each([0, 101, 1.5])(
    "rejects an invalid limit before reading business entities: %s",
    async (limit) => {
      const reader = new RecordingBusinessEntityReader(page);
      const useCase = new ListBusinessEntities(reader);

      await expect(useCase.execute({ actor, limit })).rejects.toBeInstanceOf(
        InvalidBusinessEntityListInputError,
      );
      expect(reader.inputs).toEqual([]);
    },
  );
});
