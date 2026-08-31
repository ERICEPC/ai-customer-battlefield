import { randomUUID } from "node:crypto";
import {
  type AccessControlSnapshot,
  accessControlRoleCodeSchema,
  accessControlSnapshotSchema,
  idempotencyKeySchema,
  type RoleCapabilityUpdate,
  replaceRoleCapabilitiesRequestSchema,
  roleCapabilityUpdateSchema,
} from "@battlefield/contracts";
import {
  AccessControlAccessDeniedError,
  AccessControlIdempotencyConflictError,
  AccessControlLockoutError,
  AccessControlRoleNotFoundError,
  type GetAccessControlSnapshot,
  InvalidAccessControlInputError,
  type ReplaceRoleCapabilities,
} from "@battlefield/core";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Put,
  ServiceUnavailableException,
} from "@nestjs/common";

import { RequireCapabilities } from "../auth/auth.constants.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  AccessControlUnavailableError,
  GET_ACCESS_CONTROL_SNAPSHOT,
  REPLACE_ROLE_CAPABILITIES,
} from "./access-control.providers.js";

@RequireCapabilities("access_control.manage")
@Controller("access-control")
export class AccessControlController {
  constructor(
    @Inject(GET_ACCESS_CONTROL_SNAPSHOT)
    private readonly getSnapshot: GetAccessControlSnapshot,
    @Inject(REPLACE_ROLE_CAPABILITIES)
    private readonly replaceCapabilities: ReplaceRoleCapabilities,
  ) {}

  @Get("role-capabilities")
  async getRoleCapabilities(
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<AccessControlSnapshot> {
    try {
      return accessControlSnapshotSchema.parse(
        await this.getSnapshot.execute({
          actor: developmentActor(tenantId, userId),
        }),
      );
    } catch (error) {
      return mapAccessControlError(error);
    }
  }

  @Put("roles/:roleCode/capabilities")
  async replaceRoleCapabilities(
    @Param("roleCode") rawRoleCode: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<RoleCapabilityUpdate> {
    const roleCode = accessControlRoleCodeSchema.safeParse(rawRoleCode);
    const request = replaceRoleCapabilitiesRequestSchema.safeParse(body);
    const idempotencyKey = idempotencyKeySchema.safeParse(rawIdempotencyKey);
    if (!roleCode.success || !request.success || !idempotencyKey.success) {
      throw invalidRequest("权限授权请求无效。", [
        ...(roleCode.success ? [] : roleCode.error.issues),
        ...(request.success ? [] : request.error.issues),
        ...(idempotencyKey.success ? [] : idempotencyKey.error.issues),
      ]);
    }
    try {
      return roleCapabilityUpdateSchema.parse(
        await this.replaceCapabilities.execute({
          actor: developmentActor(tenantId, userId),
          roleCode: roleCode.data,
          capabilities: request.data.capabilities,
          reason: request.data.reason,
          idempotencyKey: idempotencyKey.data,
        }),
      );
    } catch (error) {
      return mapAccessControlError(error);
    }
  }
}

function mapAccessControlError(error: unknown): never {
  if (error instanceof InvalidAccessControlInputError) {
    throw invalidRequest(error.message);
  }
  if (error instanceof AccessControlRoleNotFoundError) {
    throw new NotFoundException(
      errorPayload("ACCESS_CONTROL_ROLE_NOT_FOUND", error.message),
    );
  }
  if (error instanceof AccessControlLockoutError) {
    throw new ConflictException(
      errorPayload("ACCESS_CONTROL_LOCKOUT", error.message),
    );
  }
  if (error instanceof AccessControlIdempotencyConflictError) {
    throw new ConflictException(
      errorPayload("ACCESS_CONTROL_IDEMPOTENCY_CONFLICT", error.message),
    );
  }
  if (error instanceof AccessControlAccessDeniedError) {
    throw new ForbiddenException(
      errorPayload("ACCESS_CONTROL_FORBIDDEN", error.message),
    );
  }
  if (error instanceof AccessControlUnavailableError) {
    throw new ServiceUnavailableException(
      errorPayload("ACCESS_CONTROL_UNAVAILABLE", error.message),
    );
  }
  throw error;
}

function invalidRequest(message: string, issues?: unknown[]) {
  return new BadRequestException(
    errorPayload(
      "INVALID_ACCESS_CONTROL_REQUEST",
      message,
      issues ? normalizeIssues(issues) : undefined,
    ),
  );
}

function errorPayload(code: string, message: string, issues?: unknown[]) {
  return {
    code,
    message,
    requestId: randomUUID(),
    ...(issues ? { issues } : {}),
  };
}

function normalizeIssues(issues: unknown[]) {
  return issues.map((issue, index) => {
    if (issue && typeof issue === "object") {
      const candidate = issue as { path?: unknown; message?: unknown };
      return {
        path: Array.isArray(candidate.path)
          ? candidate.path.map(String).join(".") || "request"
          : String(candidate.path ?? index),
        reason:
          typeof candidate.message === "string"
            ? candidate.message
            : "Invalid value.",
      };
    }
    return { path: String(index), reason: "Invalid value." };
  });
}
