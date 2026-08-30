import {
  type BusinessEntityPage,
  businessEntityListQuerySchema,
  businessEntityPageSchema,
} from "@battlefield/contracts";
import {
  InvalidBusinessEntityListInputError,
  type ListBusinessEntities,
} from "@battlefield/core";
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Query,
  UnauthorizedException,
} from "@nestjs/common";

import { LIST_BUSINESS_ENTITIES } from "./business-entities.providers.js";

@Controller("business-entities")
export class BusinessEntitiesController {
  constructor(
    @Inject(LIST_BUSINESS_ENTITIES)
    private readonly listBusinessEntities: ListBusinessEntities,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BusinessEntityPage> {
    if (process.env.NODE_ENV === "production" || !tenantId || !userId) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const parsedQuery = businessEntityListQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      throw new BadRequestException({
        message: "Invalid business entity list query.",
        issues: parsedQuery.error.issues,
      });
    }

    try {
      const page = await this.listBusinessEntities.execute({
        actor: { tenantId, userId },
        ...(parsedQuery.data.status === undefined
          ? {}
          : { status: parsedQuery.data.status }),
        ...(parsedQuery.data.search === undefined
          ? {}
          : { search: parsedQuery.data.search }),
        ...(parsedQuery.data.cursor === undefined
          ? {}
          : { cursor: parsedQuery.data.cursor }),
        ...(parsedQuery.data.limit === undefined
          ? {}
          : { limit: parsedQuery.data.limit }),
      });
      return businessEntityPageSchema.parse(page);
    } catch (error) {
      if (error instanceof InvalidBusinessEntityListInputError) {
        throw new BadRequestException("Invalid business entity cursor.");
      }
      throw error;
    }
  }
}
