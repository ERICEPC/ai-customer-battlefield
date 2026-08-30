import {
  type BattleMapPage,
  battleMapPageSchema,
  battleMapQuerySchema,
} from "@battlefield/contracts";
import type { BattleQueryReader } from "@battlefield/core";
import { Controller, Get, Headers, Inject, Query } from "@nestjs/common";

import { developmentActor } from "../followup-drafts/followup-http.js";
import { BATTLE_QUERY_READER } from "./battle-analysis.providers.js";
import { invalidBattleRequest, mapBattleError } from "./battle-http.js";

@Controller("battle-map")
export class BattleMapController {
  constructor(
    @Inject(BATTLE_QUERY_READER)
    private readonly queryReader: BattleQueryReader,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BattleMapPage> {
    const actor = developmentActor(tenantId, userId);
    const parsed = battleMapQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidBattleRequest(
        "Invalid battle-map query.",
        parsed.error.issues,
      );
    }
    try {
      return battleMapPageSchema.parse(
        await this.queryReader.listMap({
          actor,
          limit: parsed.data.limit ?? 20,
          ...(parsed.data.entityId ? { entityId: parsed.data.entityId } : {}),
          ...(parsed.data.isT0 === undefined ? {} : { isT0: parsed.data.isT0 }),
          ...(parsed.data.quadrantCode
            ? { quadrantCode: parsed.data.quadrantCode }
            : {}),
          ...(parsed.data.dataSufficiency
            ? { dataSufficiency: parsed.data.dataSufficiency }
            : {}),
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      return mapBattleError(error);
    }
  }
}
