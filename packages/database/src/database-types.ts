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

export interface BattlefieldDatabase {
  "app.tenants": TenantTable;
  "app.org_units": OrgUnitTable;
  "app.users": UserTable;
  "app.user_memberships": UserMembershipTable;
  "app.channel_addresses": ChannelAddressTable;
  "app.business_entity_types": BusinessEntityTypeTable;
  "app.business_entities": BusinessEntityTable;
  "app.entity_assignments": EntityAssignmentTable;
  "app.contacts": ContactTable;
  "app.contact_affiliations": ContactAffiliationTable;
  "app.opportunities": OpportunityTable;
  "app.opportunity_assignments": OpportunityAssignmentTable;
  "app.opportunity_stage_history": OpportunityStageHistoryTable;
}
