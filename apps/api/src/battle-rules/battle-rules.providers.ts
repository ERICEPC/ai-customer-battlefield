import type { BattleRuleManager } from "@battlefield/core";
import { KyselyBattleRuleStore } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export const BATTLE_RULE_MANAGER = Symbol("BATTLE_RULE_MANAGER");

export class BattleRuleUnavailableError extends Error {
  constructor() {
    super("Battle rule persistence is not configured.");
    this.name = "BattleRuleUnavailableError";
  }
}

const unavailableManager: BattleRuleManager = {
  listVersions: async () => {
    throw new BattleRuleUnavailableError();
  },
  createVersion: async () => {
    throw new BattleRuleUnavailableError();
  },
  releaseVersion: async () => {
    throw new BattleRuleUnavailableError();
  },
};

export const battleRuleProviders: Provider[] = [
  {
    provide: BATTLE_RULE_MANAGER,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): BattleRuleManager =>
      database ? new KyselyBattleRuleStore(database.db) : unavailableManager,
  },
];
