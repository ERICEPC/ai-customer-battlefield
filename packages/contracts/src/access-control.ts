import { z } from "zod";

import { managementCapabilitySchema } from "./auth.js";

export const accessControlRoleCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,99}$/);

const uniqueManagementCapabilitiesSchema = z
  .array(managementCapabilitySchema)
  .max(20)
  .refine((items) => new Set(items).size === items.length, {
    message: "Capabilities must be unique.",
  });

export const managementCapabilityDefinitionSchema = z.strictObject({
  code: managementCapabilitySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1_000),
});

export const roleCapabilityProjectionSchema = z.strictObject({
  roleCode: accessControlRoleCodeSchema,
  displayName: z.string().trim().min(1).max(200),
  activeUserCount: z.number().int().min(0).max(1_000_000_000),
  capabilities: uniqueManagementCapabilitiesSchema,
});

export const accessControlSnapshotSchema = z.strictObject({
  capabilities: z.array(managementCapabilityDefinitionSchema).max(20),
  roles: z.array(roleCapabilityProjectionSchema).max(100),
});

export const replaceRoleCapabilitiesRequestSchema = z.strictObject({
  capabilities: uniqueManagementCapabilitiesSchema,
  reason: z.string().trim().min(1).max(1_000),
});

export const roleCapabilityUpdateSchema = z.strictObject({
  roleCode: accessControlRoleCodeSchema,
  capabilities: uniqueManagementCapabilitiesSchema,
  changed: z.boolean(),
  updatedAt: z.iso.datetime(),
});

export const accessControlApiErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_ACCESS_CONTROL_REQUEST",
    "ACCESS_CONTROL_ROLE_NOT_FOUND",
    "ACCESS_CONTROL_LOCKOUT",
    "ACCESS_CONTROL_IDEMPOTENCY_CONFLICT",
    "ACCESS_CONTROL_FORBIDDEN",
    "CAPABILITY_FORBIDDEN",
    "ACCESS_CONTROL_UNAVAILABLE",
  ]),
  message: z.string().trim().min(1).max(1_000),
  requestId: z.string().trim().min(1).max(200),
  issues: z
    .array(
      z.strictObject({
        path: z.string().trim().min(1).max(200),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(100)
    .optional(),
});

export type AccessControlRoleCode = z.infer<typeof accessControlRoleCodeSchema>;
export type ManagementCapabilityDefinition = z.infer<
  typeof managementCapabilityDefinitionSchema
>;
export type RoleCapabilityProjection = z.infer<
  typeof roleCapabilityProjectionSchema
>;
export type AccessControlSnapshot = z.infer<typeof accessControlSnapshotSchema>;
export type ReplaceRoleCapabilitiesRequest = z.infer<
  typeof replaceRoleCapabilitiesRequestSchema
>;
export type RoleCapabilityUpdate = z.infer<typeof roleCapabilityUpdateSchema>;
export type AccessControlApiError = z.infer<typeof accessControlApiErrorSchema>;
