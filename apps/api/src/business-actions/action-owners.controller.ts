import {
  type ActionOwnerPage,
  actionOwnerListQuerySchema,
  actionOwnerPageSchema,
} from "@battlefield/contracts";
import type { ActionQueryReader } from "@battlefield/core";
import { Controller, Get, Headers, Inject, Query } from "@nestjs/common";

import {
  invalidBattleRequest,
  mapActionError,
} from "../battle-analysis/battle-http.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import { ACTION_QUERY_READER } from "./business-actions.providers.js";

@Controller("action-owners")
export class ActionOwnersController {
  constructor(
    @Inject(ACTION_QUERY_READER)
    private readonly reader: ActionQueryReader,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ActionOwnerPage> {
    const actor = developmentActor(tenantId, userId);
    const parsed = actionOwnerListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidBattleRequest(
        "Invalid action-owner query.",
        parsed.error.issues,
      );
    }
    try {
      return actionOwnerPageSchema.parse(
        await this.reader.listOwners({
          actor,
          limit: parsed.data.limit ?? 50,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      return mapActionError(error);
    }
  }
}
