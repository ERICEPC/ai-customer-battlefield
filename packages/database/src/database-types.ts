import type { ManagementCapability } from "@battlefield/core";
import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type NullableText = ColumnType<
  string | null,
  string | null | undefined,
  string | null
>;
type JsonObject = ColumnType<
  Record<string, unknown>,
  Record<string, unknown> | string | undefined,
  Record<string, unknown> | string
>;
type NullableJsonObject = ColumnType<
  Record<string, unknown> | null,
  Record<string, unknown> | string | null | undefined,
  Record<string, unknown> | string | null
>;
type JsonStringArray = ColumnType<
  string[],
  string[] | string | undefined,
  string[] | string
>;
type VersionNumber = ColumnType<
  string,
  bigint | number | string | undefined,
  bigint | number | string
>;
type Decimal = ColumnType<string, number | string, number | string>;
type NullableDecimal = ColumnType<
  string | null,
  number | string | null | undefined,
  number | string | null
>;
type NullableDate = ColumnType<
  string | null,
  Date | string | null | undefined,
  Date | string | null
>;

export interface TenantTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: Generated<"active" | "suspended">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrgUnitTable {
  tenant_id: string;
  id: Generated<string>;
  parent_id: string | null;
  code: string;
  name: string;
  unit_type: "business_unit" | "department" | "sales_team" | "other";
  status: Generated<"active" | "inactive">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserTable {
  tenant_id: string;
  id: Generated<string>;
  display_name: string;
  email: string | null;
  mobile: string | null;
  status: Generated<"active" | "inactive">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserMembershipTable {
  tenant_id: string;
  id: Generated<string>;
  user_id: string;
  org_unit_id: string;
  role_code: string;
  valid_from: Timestamp;
  valid_to: NullableTimestamp;
  created_at: Timestamp;
}

export interface ManagementCapabilityTable {
  code: ManagementCapability;
  name: string;
  description: string;
  created_at: Timestamp;
}

export interface RoleCapabilityGrantTable {
  tenant_id: string;
  role_code: string;
  capability_code: ManagementCapability;
  granted_by: string | null;
  reason: string;
  created_at: Timestamp;
}

export interface UserCredentialTable {
  tenant_id: string;
  user_id: string;
  password_hash: string;
  password_updated_at: Timestamp;
  failed_attempt_count: Generated<number>;
  locked_until: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserSessionTable {
  tenant_id: string;
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  last_used_at: Timestamp;
  revoked_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface UserAiSettingsTable {
  tenant_id: string;
  user_id: string;
  provider: "senseaudio";
  model_id: string;
  api_key_ciphertext: NullableText;
  api_key_iv: NullableText;
  api_key_auth_tag: NullableText;
  api_key_last_four: NullableText;
  version_no: VersionNumber;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AiRuntimeConfigVersionTable {
  tenant_id: string;
  id: Generated<string>;
  config_key: string;
  version_no: VersionNumber;
  name: string;
  provider: "senseaudio";
  default_model_id: string;
  system_prompt: string;
  parameters: JsonObject;
  content_fingerprint: string;
  created_by: string;
  created_at: Timestamp;
}

export interface AiRuntimeConfigReleaseTable {
  tenant_id: string;
  config_key: string;
  version_id: string;
  release_no: VersionNumber;
  released_by: string;
  released_at: Timestamp;
}

export interface AiRuntimeConfigReleaseHistoryTable {
  tenant_id: string;
  id: Generated<string>;
  config_key: string;
  release_no: VersionNumber;
  version_id: string;
  released_by: string;
  released_at: Timestamp;
  reason: NullableText;
}

export interface WorkerHeartbeatTable {
  tenant_id: string;
  worker_key: string;
  instance_id: string;
  started_at: Timestamp;
  expected_interval_ms: number;
  lease_ms: number;
  last_tick_started_at: NullableTimestamp;
  last_tick_completed_at: NullableTimestamp;
  last_success_at: NullableTimestamp;
  last_failure_at: NullableTimestamp;
  last_error_code: NullableText;
  last_error_message: NullableText;
  last_tick_summary: JsonObject;
  updated_at: Timestamp;
}

export interface AsyncWorkReplayHistoryTable {
  tenant_id: string;
  id: Generated<string>;
  work_kind: "outbox" | "reminder" | "notification_delivery";
  work_item_id: string;
  prior_status: "failed" | "dead_lettered";
  prior_attempt_count: number;
  prior_error_code: string;
  prior_error_message: string;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  replayed_by: string;
  replayed_at: Timestamp;
}

export interface ChannelAddressTable {
  tenant_id: string;
  id: Generated<string>;
  user_id: string;
  channel: "in_app" | "feishu" | "email" | "wechat";
  external_user_id: string;
  status: Generated<"active" | "disabled">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BusinessEntityTypeTable {
  tenant_id: string;
  id: Generated<string>;
  code: string;
  name: string;
  status: Generated<"active" | "inactive">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BusinessEntityTable {
  tenant_id: string;
  id: Generated<string>;
  type_id: string;
  name: string;
  short_name: NullableText;
  status: Generated<"active" | "inactive" | "archived">;
  is_t0: Generated<boolean>;
  metadata: JsonObject;
  version_no: VersionNumber;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EntityAssignmentTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  user_id: string;
  assignment_role: "owner" | "collaborator" | "management_observer";
  is_primary: Generated<boolean>;
  valid_from: Timestamp;
  valid_to: NullableTimestamp;
  created_at: Timestamp;
}

export interface ContactTable {
  tenant_id: string;
  id: Generated<string>;
  display_name: string;
  title: NullableText;
  email: NullableText;
  mobile: NullableText;
  status: Generated<"active" | "inactive" | "archived">;
  metadata: JsonObject;
  version_no: VersionNumber;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ContactAffiliationTable {
  tenant_id: string;
  id: Generated<string>;
  contact_id: string;
  entity_id: string;
  job_title: NullableText;
  department: NullableText;
  is_primary: Generated<boolean>;
  valid_from: Timestamp;
  valid_to: NullableTimestamp;
  created_at: Timestamp;
}

export interface OpportunityTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  name: string;
  need_summary: NullableText;
  estimated_amount: NullableDecimal;
  currency: Generated<string>;
  stage_code: string;
  stage_progress: Decimal;
  status: Generated<"open" | "won" | "lost" | "cancelled">;
  is_primary: Generated<boolean>;
  expected_close_at: NullableDate;
  version_no: VersionNumber;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OpportunityAssignmentTable {
  tenant_id: string;
  id: Generated<string>;
  opportunity_id: string;
  user_id: string;
  assignment_role: "owner" | "collaborator" | "management_observer";
  is_primary: Generated<boolean>;
  valid_from: Timestamp;
  valid_to: NullableTimestamp;
  created_at: Timestamp;
}

export interface OpportunityStageHistoryTable {
  tenant_id: string;
  id: Generated<string>;
  opportunity_id: string;
  from_stage_code: NullableText;
  to_stage_code: string;
  from_progress: NullableDecimal;
  to_progress: Decimal;
  changed_by_user_id: NullableText;
  change_source: "user" | "agent" | "import" | "system";
  note: NullableText;
  changed_at: Timestamp;
}

export interface SourceInputTable {
  tenant_id: string;
  id: Generated<string>;
  source_type: "web" | "feishu" | "email" | "import" | "api";
  source_message_id: NullableText;
  submitted_by: string;
  raw_content: string;
  content_hash: string;
  received_at: Timestamp;
  created_at: Timestamp;
}

export interface FollowupDraftTable {
  tenant_id: string;
  id: Generated<string>;
  source_input_id: string;
  entity_id: string;
  status: "pending_confirmation" | "confirmed" | "cancelled" | "expired";
  candidate_payload: JsonObject;
  created_by: string;
  expires_at: Timestamp;
  confirmed_at: NullableTimestamp;
  confirmed_by: NullableText;
  cancelled_at: NullableTimestamp;
  version_no: VersionNumber;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DraftRevisionTable {
  tenant_id: string;
  id: Generated<string>;
  draft_id: string;
  revision_no: VersionNumber;
  candidate_payload: JsonObject;
  changed_by: string;
  changed_at: Timestamp;
}

export interface FollowupTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  source_input_id: string;
  source_draft_id: string;
  occurred_at: Timestamp;
  followup_type: "meeting" | "call" | "message" | "email" | "other";
  summary: string;
  result_summary: NullableText;
  submitted_by: string;
  confirmed_by: string;
  confirmed_at: Timestamp;
  version_no: VersionNumber;
  created_at: Timestamp;
}

export interface FollowupCorrectionTable {
  tenant_id: string;
  id: Generated<string>;
  followup_id: string;
  supersedes_followup_id: string;
  reason: string;
  corrected_by: string;
  corrected_at: Timestamp;
}

export interface FollowupParticipantTable {
  tenant_id: string;
  id: Generated<string>;
  followup_id: string;
  user_id: string | null;
  contact_id: string | null;
  participant_role:
    | "sales_owner"
    | "participant"
    | "customer_contact"
    | "observer";
  created_at: Timestamp;
}

export interface FollowupOpportunityTable {
  tenant_id: string;
  followup_id: string;
  opportunity_id: string;
  is_primary: Generated<boolean>;
  created_at: Timestamp;
}

export interface BusinessFactTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  opportunity_id: string | null;
  followup_id: string;
  fact_type: string;
  fact_value: string;
  occurred_at: Timestamp;
  confirmed_at: Timestamp;
  confirmed_by: string;
  valid_status: Generated<"valid" | "superseded" | "invalidated">;
  supersedes_fact_id: string | null;
  created_at: Timestamp;
}

export interface SourceEvidenceTable {
  tenant_id: string;
  id: Generated<string>;
  source_input_id: string | null;
  source_type: "web" | "feishu" | "email" | "attachment" | "import" | "api";
  content_ref: NullableText;
  excerpt: NullableText;
  content_hash: string;
  sensitivity: Generated<"public" | "internal" | "confidential" | "restricted">;
  captured_at: Timestamp;
  created_at: Timestamp;
}

export interface FactEvidenceLinkTable {
  tenant_id: string;
  fact_id: string;
  evidence_id: string;
  relation_type: "supports" | "contradicts" | "context";
  created_at: Timestamp;
}

export interface IdempotencyRecordTable {
  tenant_id: string;
  id: Generated<string>;
  operation: string;
  idempotency_key: string;
  request_hash: string;
  status: "in_progress" | "completed";
  response_payload: NullableJsonObject;
  resource_type: NullableText;
  resource_id: string | null;
  created_by: string;
  created_at: Timestamp;
  completed_at: NullableTimestamp;
  expires_at: NullableTimestamp;
}

export interface AuditEntryTable {
  tenant_id: string;
  id: Generated<string>;
  aggregate_type: string;
  aggregate_id: string;
  action: string;
  actor_user_id: string;
  request_id: NullableText;
  before_payload: NullableJsonObject;
  after_payload: NullableJsonObject;
  reason: NullableText;
  occurred_at: Timestamp;
}

export interface DomainEventTable {
  tenant_id: string;
  id: Generated<string>;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: VersionNumber;
  payload: JsonObject;
  occurred_at: Timestamp;
}

export interface OutboxMessageTable {
  tenant_id: string;
  id: Generated<string>;
  event_id: string;
  topic: string;
  payload: JsonObject;
  status: Generated<
    | "pending"
    | "processing"
    | "published"
    | "failed"
    | "cancelled"
    | "dead_lettered"
  >;
  dedupe_key: string;
  available_at: Timestamp;
  attempt_count: Generated<number>;
  last_error: NullableText;
  last_error_code: NullableText;
  claim_token: string | null;
  claimed_at: NullableTimestamp;
  published_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface AnalysisRunTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  trigger_event_id: string | null;
  rule_version: string;
  analyzer_config_version: string;
  input_version: string;
  status: Generated<"running" | "completed" | "failed" | "superseded">;
  error_code: NullableText;
  error_message: NullableText;
  started_at: Timestamp;
  finished_at: NullableTimestamp;
  created_by: string;
  created_at: Timestamp;
}

export interface BusinessSignalTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  fact_id: string;
  analysis_run_id: string;
  dimension: "relationship" | "potential" | "risk" | "stage";
  direction: "positive" | "negative" | "neutral";
  strength: number;
  reason: string;
  created_at: Timestamp;
}

export interface BattleStateVersionTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  version_no: VersionNumber;
  input_version: string;
  relationship_score: NullableDecimal;
  potential_score: NullableDecimal;
  quadrant_code: NullableText;
  primary_opportunity_id: string | null;
  risk_level: "low" | "medium" | "high" | "critical";
  data_sufficiency: "insufficient" | "partial" | "sufficient";
  data_gaps: JsonStringArray;
  summary: string;
  analysis_run_id: string;
  effective_at: Timestamp;
  created_at: Timestamp;
}

export interface BattleStateCurrentTable {
  tenant_id: string;
  entity_id: string;
  battle_state_version_id: string;
  version_no: VersionNumber;
  input_version: string;
  updated_at: Timestamp;
}

export interface BattleStateEvidenceLinkTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  battle_state_version_id: string;
  fact_id: string | null;
  signal_id: string | null;
  contribution: string;
  created_at: Timestamp;
}

export interface ActionProposalTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  opportunity_id: string | null;
  title: string;
  description: string;
  suggested_owner_id: string | null;
  suggested_priority: "low" | "medium" | "high" | "urgent";
  suggested_planned_at: NullableTimestamp;
  source_battle_state_version_id: string;
  status: Generated<
    "pending_confirmation" | "accepted" | "rejected" | "expired"
  >;
  version_no: VersionNumber;
  proposed_at: Timestamp;
  expires_at: Timestamp;
  decided_at: NullableTimestamp;
  decided_by: string | null;
  decision_reason: NullableText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BusinessActionTable {
  tenant_id: string;
  id: Generated<string>;
  entity_id: string;
  opportunity_id: string | null;
  title: string;
  description: string;
  owner_user_id: string;
  priority: "low" | "medium" | "high" | "urgent";
  status: Generated<"planned" | "in_progress" | "completed" | "cancelled">;
  planned_at: Timestamp;
  completed_at: NullableTimestamp;
  source_proposal_id: string;
  confirmed_by: string;
  confirmed_at: Timestamp;
  version_no: VersionNumber;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ActionStatusHistoryTable {
  tenant_id: string;
  id: Generated<string>;
  action_id: string;
  from_status: NullableText;
  to_status: "planned" | "in_progress" | "completed" | "cancelled";
  changed_by: string;
  reason: NullableText;
  changed_at: Timestamp;
  version_no: VersionNumber;
}

export interface ReminderPolicyNode {
  kind: "advance" | "due" | "overdue" | "escalation";
  offsetMinutes: number;
  recipient: "owner";
  channels: Array<"in_app" | "feishu" | "email">;
}

type ReminderPolicyNodes = ColumnType<
  ReminderPolicyNode[],
  ReminderPolicyNode[] | string,
  ReminderPolicyNode[] | string
>;

export interface ReminderPolicyVersionTable {
  tenant_id: string;
  id: Generated<string>;
  policy_key: string;
  version_no: VersionNumber;
  name: string;
  status: "draft" | "published" | "retired";
  nodes: ReminderPolicyNodes;
  effective_at: Timestamp;
  published_by: string;
  created_at: Timestamp;
}

export interface NotificationTemplateVersionTable {
  tenant_id: string;
  id: Generated<string>;
  template_key: string;
  channel: "in_app" | "feishu" | "email";
  version_no: VersionNumber;
  name: string;
  status: "draft" | "published" | "retired";
  title_template: string;
  body_template: string;
  deep_link_template: string;
  priority: "low" | "medium" | "high" | "urgent";
  effective_at: Timestamp;
  published_by: string;
  created_at: Timestamp;
}

export interface ReminderInstanceTable {
  tenant_id: string;
  id: Generated<string>;
  action_id: string;
  recipient_user_id: string;
  policy_version_id: string;
  action_version_no: VersionNumber;
  kind: "advance" | "due" | "overdue" | "escalation";
  remind_at: Timestamp;
  channels: JsonStringArray;
  status: Generated<
    | "scheduled"
    | "processing"
    | "notified"
    | "failed"
    | "cancelled"
    | "dead_lettered"
  >;
  available_at: Timestamp;
  attempt_count: Generated<number>;
  claim_token: string | null;
  claimed_at: NullableTimestamp;
  notification_event_id: string | null;
  dedupe_key: string;
  last_error_code: NullableText;
  last_error_message: NullableText;
  cancelled_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface NotificationEventTable {
  tenant_id: string;
  id: Generated<string>;
  recipient_user_id: string;
  reminder_id: string | null;
  report_version_id: string | null;
  followup_id: string | null;
  battle_state_version_id: string | null;
  event_type:
    | "action_due"
    | "weekly_report_published"
    | "sales_progress_updated";
  title: string;
  body: string;
  deep_link: string;
  priority: "low" | "medium" | "high" | "urgent";
  read_at: NullableTimestamp;
  dedupe_key: string;
  created_at: Timestamp;
}

export interface WeeklyReportTable {
  tenant_id: string;
  id: Generated<string>;
  report_type: "personal" | "managed_portfolio";
  owner_user_id: string;
  subject_user_id: string | null;
  period_start: Timestamp;
  period_end: Timestamp;
  created_by: string;
  created_at: Timestamp;
}

export interface WeeklyReportVersionTable {
  tenant_id: string;
  id: Generated<string>;
  report_id: string;
  revision_no: VersionNumber;
  lock_version: VersionNumber;
  status: "draft" | "in_review" | "published" | "cancelled";
  data_cutoff_at: Timestamp;
  title: string;
  note: string;
  scope_fingerprint: string;
  scope_entity_count: number;
  contributor_count: number;
  confirmed_followup_count: number;
  valid_fact_count: number;
  stage_change_count: number;
  completed_action_count: number;
  open_action_count: number;
  overdue_action_count: number;
  generator_kind: "deterministic" | "agent";
  generator_version: string;
  previous_version_id: string | null;
  created_by: string;
  created_at: Timestamp;
  published_by: string | null;
  published_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface WeeklyReportScopeEntityTable {
  tenant_id: string;
  report_version_id: string;
  entity_id: string;
  sort_order: number;
  created_at: Timestamp;
}

export interface WeeklyReportItemTable {
  tenant_id: string;
  id: Generated<string>;
  report_version_id: string;
  section_type: "progress" | "risk" | "next_action" | "data_gap";
  entity_id: string;
  entity_name: string;
  title: string;
  summary: string;
  severity: "positive" | "info" | "warning" | "critical";
  occurred_at: NullableTimestamp;
  included: Generated<boolean>;
  sort_order: number;
  created_at: Timestamp;
}

export interface ReportEvidenceLinkTable {
  tenant_id: string;
  report_item_id: string;
  evidence_type:
    | "followup"
    | "fact"
    | "stage_change"
    | "action"
    | "battle_state";
  evidence_id: string;
  occurred_at: Timestamp;
  label: string;
  deep_link: string;
  created_at: Timestamp;
}

export interface WeeklyReportItemContributorTable {
  tenant_id: string;
  report_item_id: string;
  user_id: string;
  display_name: string;
  created_at: Timestamp;
}

export interface WeeklyReportAudienceTable {
  tenant_id: string;
  report_version_id: string;
  user_id: string;
  audience_role: "reviewer" | "recipient";
  created_at: Timestamp;
}

export interface NotificationDeliveryTable {
  tenant_id: string;
  id: Generated<string>;
  notification_event_id: string;
  recipient_user_id: string;
  channel: "in_app" | "feishu" | "email";
  address_id: string | null;
  status: Generated<
    | "pending"
    | "processing"
    | "delivered"
    | "failed"
    | "cancelled"
    | "dead_lettered"
  >;
  dedupe_key: string;
  available_at: Timestamp;
  attempt_count: Generated<number>;
  claim_token: string | null;
  claimed_at: NullableTimestamp;
  delivered_at: NullableTimestamp;
  provider_message_id: NullableText;
  provider_request_id: NullableText;
  last_error_code: NullableText;
  last_error_message: NullableText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BattlefieldDatabase {
  "app.tenants": TenantTable;
  "app.org_units": OrgUnitTable;
  "app.users": UserTable;
  "app.user_memberships": UserMembershipTable;
  "app.management_capabilities": ManagementCapabilityTable;
  "app.role_capability_grants": RoleCapabilityGrantTable;
  "app.user_credentials": UserCredentialTable;
  "app.user_sessions": UserSessionTable;
  "app.user_ai_settings": UserAiSettingsTable;
  "app.ai_runtime_config_versions": AiRuntimeConfigVersionTable;
  "app.ai_runtime_config_releases": AiRuntimeConfigReleaseTable;
  "app.ai_runtime_config_release_history": AiRuntimeConfigReleaseHistoryTable;
  "app.worker_heartbeats": WorkerHeartbeatTable;
  "app.async_work_replay_history": AsyncWorkReplayHistoryTable;
  "app.channel_addresses": ChannelAddressTable;
  "app.business_entity_types": BusinessEntityTypeTable;
  "app.business_entities": BusinessEntityTable;
  "app.entity_assignments": EntityAssignmentTable;
  "app.contacts": ContactTable;
  "app.contact_affiliations": ContactAffiliationTable;
  "app.opportunities": OpportunityTable;
  "app.opportunity_assignments": OpportunityAssignmentTable;
  "app.opportunity_stage_history": OpportunityStageHistoryTable;
  "app.source_inputs": SourceInputTable;
  "app.followup_drafts": FollowupDraftTable;
  "app.draft_revisions": DraftRevisionTable;
  "app.followups": FollowupTable;
  "app.followup_corrections": FollowupCorrectionTable;
  "app.followup_participants": FollowupParticipantTable;
  "app.followup_opportunities": FollowupOpportunityTable;
  "app.business_facts": BusinessFactTable;
  "app.source_evidence": SourceEvidenceTable;
  "app.fact_evidence_links": FactEvidenceLinkTable;
  "app.idempotency_records": IdempotencyRecordTable;
  "app.audit_entries": AuditEntryTable;
  "app.domain_events": DomainEventTable;
  "app.outbox_messages": OutboxMessageTable;
  "app.analysis_runs": AnalysisRunTable;
  "app.business_signals": BusinessSignalTable;
  "app.battle_state_versions": BattleStateVersionTable;
  "app.battle_state_current": BattleStateCurrentTable;
  "app.battle_state_evidence_links": BattleStateEvidenceLinkTable;
  "app.action_proposals": ActionProposalTable;
  "app.business_actions": BusinessActionTable;
  "app.action_status_history": ActionStatusHistoryTable;
  "app.reminder_policy_versions": ReminderPolicyVersionTable;
  "app.notification_template_versions": NotificationTemplateVersionTable;
  "app.reminder_instances": ReminderInstanceTable;
  "app.notification_events": NotificationEventTable;
  "app.notification_deliveries": NotificationDeliveryTable;
  "app.weekly_reports": WeeklyReportTable;
  "app.weekly_report_versions": WeeklyReportVersionTable;
  "app.weekly_report_scope_entities": WeeklyReportScopeEntityTable;
  "app.weekly_report_items": WeeklyReportItemTable;
  "app.report_evidence_links": ReportEvidenceLinkTable;
  "app.weekly_report_item_contributors": WeeklyReportItemContributorTable;
  "app.weekly_report_audiences": WeeklyReportAudienceTable;
}
