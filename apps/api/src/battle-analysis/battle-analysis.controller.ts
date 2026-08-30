import {
  type BattleAnalysisResult,
  type BattleStateDetail,
  battleAnalysisRequestSchema,
  battleAnalysisResultSchema,
  battleStateDetailSchema,
} from "@battlefield/contracts";
import type {
  BattleQueryReader,
  RequestBattleAnalysis,
} from "@battlefield/core";
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
} from "@nestjs/common";

import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  BATTLE_QUERY_READER,
  REQUEST_BATTLE_ANALYSIS,
} from "./battle-analysis.providers.js";
import {
  invalidBattleRequest,
  mapBattleError,
  resourceIdentifier,
} from "./battle-http.js";

const battleAnalysisBodySchema = battleAnalysisRequestSchema.omit({
  entityId: true,
});

@Controller("business-entities")
export class BattleAnalysisController {
  constructor(
    @Inject(REQUEST_BATTLE_ANALYSIS)
    private readonly requestAnalysis: RequestBattleAnalysis,
    @Inject(BATTLE_QUERY_READER)
    private readonly queryReader: BattleQueryReader,
  ) {}

  @Post(":entityId/analysis-runs")
  async request(
    @Param("entityId") rawEntityId: string,
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BattleAnalysisResult> {
    const actor = developmentActor(tenantId, userId);
    const entityId = resourceIdentifier(rawEntityId, "Business entity");
    const parsed = battleAnalysisBodySchema.safeParse(body);
    if (!parsed.success) {
      throw invalidBattleRequest(
        "Invalid battle analysis request.",
        parsed.error.issues,
      );
    }
    try {
      return battleAnalysisResultSchema.parse(
        await this.requestAnalysis.execute({
          actor,
          entityId,
          ...(parsed.data.expectedInputVersion
            ? { expectedInputVersion: parsed.data.expectedInputVersion }
            : {}),
        }),
      );
    } catch (error) {
      return mapBattleError(error);
    }
  }

  @Get(":entityId/battle-state")
  async getCurrent(
    @Param("entityId") rawEntityId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BattleStateDetail> {
    const actor = developmentActor(tenantId, userId);
    const entityId = resourceIdentifier(rawEntityId, "Business entity");
    try {
      return battleStateDetailSchema.parse(
        await this.queryReader.getCurrent({ actor, entityId }),
      );
    } catch (error) {
      return mapBattleError(error);
    }
  }

  @Get(":entityId/battle-states/:battleStateVersionId")
  async getVersion(
    @Param("entityId") rawEntityId: string,
    @Param("battleStateVersionId") rawBattleStateVersionId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BattleStateDetail> {
    const actor = developmentActor(tenantId, userId);
    const entityId = resourceIdentifier(rawEntityId, "Business entity");
    const battleStateVersionId = resourceIdentifier(
      rawBattleStateVersionId,
      "Battle state version",
    );
    try {
      return battleStateDetailSchema.parse(
        await this.queryReader.getVersion({
          actor,
          entityId,
          battleStateVersionId,
        }),
      );
    } catch (error) {
      return mapBattleError(error);
    }
  }
}
