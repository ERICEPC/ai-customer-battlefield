import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type {
  BusinessEntityPage,
  BusinessEntityReader,
  BusinessEntityReaderInput,
  BusinessEntityStatus,
} from "./business-entity-reader.js";

export interface ListBusinessEntitiesInput {
  actor: ActorScope;
  status?: BusinessEntityStatus;
  search?: string;
  cursor?: string;
  limit?: number;
}

export class InvalidBusinessEntityListInputError extends Error {
  constructor() {
    super("Business entity list filters are invalid.");
    this.name = "InvalidBusinessEntityListInputError";
  }
}

export class ListBusinessEntities {
  constructor(private readonly reader: BusinessEntityReader) {}

  async execute(input: ListBusinessEntitiesInput): Promise<BusinessEntityPage> {
    const limit = input.limit ?? 20;
    const search = input.search?.trim();
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (search !== undefined && search.length > 100)
    ) {
      throw new InvalidBusinessEntityListInputError();
    }

    const readerInput: BusinessEntityReaderInput = {
      actor: input.actor,
      limit,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(search ? { search } : {}),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    };

    return this.reader.list(readerInput);
  }
}
