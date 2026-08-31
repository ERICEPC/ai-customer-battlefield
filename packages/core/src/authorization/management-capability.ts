export const managementCapabilityCodes = [
  "access_control.manage",
  "ai_runtime_config.manage",
  "audit.read",
  "management_query.execute",
  "worker_operations.manage",
] as const;

export type ManagementCapability = (typeof managementCapabilityCodes)[number];
