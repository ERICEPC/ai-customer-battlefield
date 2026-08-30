import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { BattleAnalysisController } from "./battle-analysis.controller.js";
import {
  BATTLE_QUERY_READER,
  battleAnalysisProviders,
} from "./battle-analysis.providers.js";
import { BattleMapController } from "./battle-map.controller.js";

@Module({
  imports: [DatabaseModule],
  controllers: [BattleAnalysisController, BattleMapController],
  providers: battleAnalysisProviders,
  exports: [BATTLE_QUERY_READER],
})
export class BattleAnalysisModule {}
