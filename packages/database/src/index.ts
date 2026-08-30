export { KyselyActionDecisionStore } from "./action-decisions/kysely-action-decision-store.js";
export {
  KyselyBattleAnalysisStore,
  type KyselyBattleAnalysisStoreOptions,
  KyselyConfirmedFactSnapshotReader,
} from "./battle-analysis/kysely-battle-analysis-store.js";
export {
  KyselyBusinessEntityReader,
  type KyselyBusinessEntityReaderOptions,
} from "./business-entities/kysely-business-entity-reader.js";
export {
  createPostgresDatabase,
  type PostgresDatabaseOptions,
} from "./database-factory.js";
export type {
  DatabaseHandle,
  MigrationDriver,
  MigrationTransaction,
} from "./database-handle.js";
export type {
  ActionProposalTable,
  ActionStatusHistoryTable,
  AnalysisRunTable,
  AuditEntryTable,
  BattlefieldDatabase,
  BattleStateCurrentTable,
  BattleStateEvidenceLinkTable,
  BattleStateVersionTable,
  BusinessActionTable,
  BusinessEntityTable,
  BusinessEntityTypeTable,
  BusinessFactTable,
  BusinessSignalTable,
  ChannelAddressTable,
  ContactAffiliationTable,
  ContactTable,
  DomainEventTable,
  DraftRevisionTable,
  EntityAssignmentTable,
  FactEvidenceLinkTable,
  FollowupCorrectionTable,
  FollowupDraftTable,
  FollowupOpportunityTable,
  FollowupParticipantTable,
  FollowupTable,
  IdempotencyRecordTable,
  OpportunityAssignmentTable,
  OpportunityStageHistoryTable,
  OpportunityTable,
  OrgUnitTable,
  OutboxMessageTable,
  SourceEvidenceTable,
  SourceInputTable,
  TenantTable,
  UserMembershipTable,
  UserTable,
} from "./database-types.js";
export { KyselyFollowupConfirmationStore } from "./followup-confirmation/kysely-followup-confirmation-store.js";
export {
  MigrationFailedError,
  MigrationHistoryError,
  type MigrationRun,
  migrateDatabase,
} from "./migrate.js";
export {
  SqlFileMigrationProvider,
  type SqlMigration,
} from "./migration-provider.js";
export {
  type ActorDatabaseContext,
  InvalidActorDatabaseContextError,
  withTenantTransaction,
} from "./tenant-session.js";
