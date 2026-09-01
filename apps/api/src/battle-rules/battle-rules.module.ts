import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { BattleRulesController } from "./battle-rules.controller.js";
import { battleRuleProviders } from "./battle-rules.providers.js";

@Module({
  imports: [DatabaseModule],
  controllers: [BattleRulesController],
  providers: battleRuleProviders,
})
export class BattleRulesModule {}
