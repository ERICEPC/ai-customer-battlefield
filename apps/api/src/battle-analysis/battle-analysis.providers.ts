import { randomUUID } from "node:crypto";
import type {
  BattleAnalysisStore,
  BattleAnalyzer,
  BattleQueryReader,
  BattleRuleResolver,
  ConfirmedFactSnapshotReader,
} from "@battlefield/core";
import {
  defaultBattleRuleSet,
  RequestBattleAnalysis,
  StaticBattleRuleResolver,
} from "@battlefield/core";
import {
  KyselyBattleAnalysisStore,
  KyselyBattleQueryReader,
  KyselyConfirmedFactSnapshotReader,
} from "@battlefield/database";
import { type Provider, ServiceUnavailableException } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";
import { DeterministicBattleAnalyzer } from "./deterministic-battle-analyzer.js";

export const CONFIRMED_FACT_SNAPSHOT_READER = Symbol(
  "CONFIRMED_FACT_SNAPSHOT_READER",
);
export const BATTLE_ANALYZER = Symbol("BATTLE_ANALYZER");
export const BATTLE_ANALYSIS_STORE = Symbol("BATTLE_ANALYSIS_STORE");
export const BATTLE_QUERY_READER = Symbol("BATTLE_QUERY_READER");
export const BATTLE_RULE_RESOLVER = Symbol("BATTLE_RULE_RESOLVER");
export const REQUEST_BATTLE_ANALYSIS = Symbol("REQUEST_BATTLE_ANALYSIS");

async function unavailable(): Promise<never> {
  throw new ServiceUnavailableException(
    "Battle analysis persistence or analyzer is not configured.",
  );
}

const unavailableSnapshotReader: ConfirmedFactSnapshotReader = {
  read: unavailable,
};
const unavailableAnalysisStore: BattleAnalysisStore = {
  findByTriggerEvent: unavailable,
  start: unavailable,
  complete: unavailable,
  fail: unavailable,
};
const unavailableQueryReader: BattleQueryReader = {
  getCurrent: unavailable,
  getVersion: unavailable,
  listMap: unavailable,
};
const unavailableAnalyzer: BattleAnalyzer = {
  configurationVersion: "unavailable-v1",
  analyze: unavailable,
};

export const battleAnalysisProviders: Provider[] = [
  {
    provide: CONFIRMED_FACT_SNAPSHOT_READER,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): ConfirmedFactSnapshotReader =>
      database
        ? new KyselyConfirmedFactSnapshotReader(database.db)
        : unavailableSnapshotReader,
  },
  {
    provide: BATTLE_ANALYSIS_STORE,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): BattleAnalysisStore =>
      database
        ? new KyselyBattleAnalysisStore(database.db)
        : unavailableAnalysisStore,
  },
  {
    provide: BATTLE_QUERY_READER,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): BattleQueryReader =>
      database
        ? new KyselyBattleQueryReader(database.db)
        : unavailableQueryReader,
  },
  {
    provide: BATTLE_ANALYZER,
    useFactory: (): BattleAnalyzer =>
      process.env.NODE_ENV === "production"
        ? unavailableAnalyzer
        : new DeterministicBattleAnalyzer(),
  },
  {
    provide: BATTLE_RULE_RESOLVER,
    useFactory: (): BattleRuleResolver =>
      new StaticBattleRuleResolver({
        ruleVersion: "deterministic-battle-rules-v1",
        rules: defaultBattleRuleSet,
      }),
  },
  {
    provide: REQUEST_BATTLE_ANALYSIS,
    inject: [
      CONFIRMED_FACT_SNAPSHOT_READER,
      BATTLE_ANALYZER,
      BATTLE_ANALYSIS_STORE,
      BATTLE_RULE_RESOLVER,
    ],
    useFactory: (
      reader: ConfirmedFactSnapshotReader,
      analyzer: BattleAnalyzer,
      store: BattleAnalysisStore,
      ruleResolver: BattleRuleResolver,
    ) =>
      new RequestBattleAnalysis({
        reader,
        analyzer,
        store,
        idGenerator: { next: () => randomUUID() },
        clock: { now: () => new Date() },
        ruleResolver,
      }),
  },
];
