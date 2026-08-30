import { randomUUID } from "node:crypto";
import type {
  BattleAnalysisStore,
  BattleAnalyzer,
  BattleQueryReader,
  ConfirmedFactSnapshotReader,
} from "@battlefield/core";
import { RequestBattleAnalysis } from "@battlefield/core";
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
  start: unavailable,
  complete: unavailable,
  fail: unavailable,
};
const unavailableQueryReader: BattleQueryReader = {
  getCurrent: unavailable,
  listMap: unavailable,
};
const unavailableAnalyzer: BattleAnalyzer = { analyze: unavailable };

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
    provide: REQUEST_BATTLE_ANALYSIS,
    inject: [
      CONFIRMED_FACT_SNAPSHOT_READER,
      BATTLE_ANALYZER,
      BATTLE_ANALYSIS_STORE,
    ],
    useFactory: (
      reader: ConfirmedFactSnapshotReader,
      analyzer: BattleAnalyzer,
      store: BattleAnalysisStore,
    ) =>
      new RequestBattleAnalysis({
        reader,
        analyzer,
        store,
        idGenerator: { next: () => randomUUID() },
        clock: { now: () => new Date() },
        ruleVersion: "deterministic-battle-rules-v1",
        analyzerConfigVersion: "deterministic-development-v1",
      }),
  },
];
