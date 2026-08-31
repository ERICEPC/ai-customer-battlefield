import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import {
  type ManagementCapability,
  managementCapabilityCodes,
} from "./management-capability.js";

export interface ManagementCapabilityDefinition {
  code: ManagementCapability;
  name: string;
  description: string;
}

export interface RoleCapabilityProjection {
  roleCode: string;
  displayName: string;
  activeUserCount: number;
  capabilities: ManagementCapability[];
}

export interface AccessControlSnapshot {
  capabilities: ManagementCapabilityDefinition[];
  roles: RoleCapabilityProjection[];
}

export interface RoleCapabilityUpdate {
  roleCode: string;
  capabilities: ManagementCapability[];
  changed: boolean;
  updatedAt: string;
}

export interface AccessControlRepository {
  getSnapshot(input: { actor: ActorScope }): Promise<AccessControlSnapshot>;
  replaceRoleCapabilities(input: {
    actor: ActorScope;
    roleCode: string;
    capabilities: ManagementCapability[];
    reason: string;
    idempotencyKey: string;
  }): Promise<RoleCapabilityUpdate>;
}

export class GetAccessControlSnapshot {
  constructor(private readonly repository: AccessControlRepository) {}

  execute(input: { actor: ActorScope }): Promise<AccessControlSnapshot> {
    return this.repository.getSnapshot(input);
  }
}

export class ReplaceRoleCapabilities {
  constructor(private readonly repository: AccessControlRepository) {}

  async execute(input: {
    actor: ActorScope;
    roleCode: string;
    capabilities: ManagementCapability[];
    reason: string;
    idempotencyKey: string;
  }): Promise<RoleCapabilityUpdate> {
    const roleCode = input.roleCode.trim();
    const reason = input.reason.trim();
    if (
      !ROLE_CODE_PATTERN.test(roleCode) ||
      reason.length < 1 ||
      reason.length > 1_000 ||
      !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
      input.capabilities.length > managementCapabilityCodes.length ||
      new Set(input.capabilities).size !== input.capabilities.length ||
      !input.capabilities.every((capability) =>
        managementCapabilityCodes.includes(capability),
      )
    ) {
      throw new InvalidAccessControlInputError();
    }
    const desired = managementCapabilityCodes.filter((capability) =>
      input.capabilities.includes(capability),
    );
    return this.repository.replaceRoleCapabilities({
      ...input,
      roleCode,
      capabilities: desired,
      reason,
    });
  }
}

export class InvalidAccessControlInputError extends Error {
  constructor() {
    super("Access-control management input is invalid.");
    this.name = "InvalidAccessControlInputError";
  }
}

export class AccessControlRoleNotFoundError extends Error {
  constructor() {
    super("The tenant role was not found.");
    this.name = "AccessControlRoleNotFoundError";
  }
}

export class AccessControlLockoutError extends Error {
  constructor() {
    super("The change would leave the tenant without an access controller.");
    this.name = "AccessControlLockoutError";
  }
}

export class AccessControlIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used for another access change.");
    this.name = "AccessControlIdempotencyConflictError";
  }
}

export class AccessControlAccessDeniedError extends Error {
  constructor() {
    super("Current actor cannot manage tenant access control.");
    this.name = "AccessControlAccessDeniedError";
  }
}

const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
