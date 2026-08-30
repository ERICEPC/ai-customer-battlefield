import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
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

export interface BattlefieldDatabase {
  "app.tenants": TenantTable;
  "app.org_units": OrgUnitTable;
  "app.users": UserTable;
  "app.user_memberships": UserMembershipTable;
  "app.channel_addresses": ChannelAddressTable;
}
