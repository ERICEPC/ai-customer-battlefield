import { randomUUID } from "node:crypto";
import {
  type AuditEntryPage,
  auditEntryListQuerySchema,
  auditEntryPageSchema,
} from "@battlefield/contracts";
import {
  InvalidAuditLogCursorError,
  InvalidAuditLogListInputError,
  type ListAuditEntries,
} from "@battlefield/core";
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";

import { RequireCapabilities } from "../auth/auth.constants.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  AuditLogUnavailableError,
  LIST_AUDIT_ENTRIES,
} from "./audit-log.providers.js";

@RequireCapabilities("audit.read")
@Controller("audit-entries")
export class AuditLogController {
  constructor(
    @Inject(LIST_AUDIT_ENTRIES)
    private readonly listAuditEntries: ListAuditEntries,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<AuditEntryPage> {
    const actor = developmentActor(tenantId, userId);
    const parsed = auditEntryListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidAuditLogQuery(
        "Invalid audit-log query.",
        parsed.error.issues,
      );
    }
    try {
      return auditEntryPageSchema.parse(
        await this.listAuditEntries.execute({
          actor,
          limit: parsed.data.limit ?? 50,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
          ...(parsed.data.actorUserId
            ? { actorUserId: parsed.data.actorUserId }
            : {}),
          ...(parsed.data.aggregateType
            ? { aggregateType: parsed.data.aggregateType }
            : {}),
          ...(parsed.data.aggregateId
            ? { aggregateId: parsed.data.aggregateId }
            : {}),
          ...(parsed.data.action ? { action: parsed.data.action } : {}),
          ...(parsed.data.occurredFrom
            ? { occurredFrom: parsed.data.occurredFrom }
            : {}),
          ...(parsed.data.occurredBefore
            ? { occurredBefore: parsed.data.occurredBefore }
            : {}),
        }),
      );
    } catch (error) {
      if (
        error instanceof InvalidAuditLogCursorError ||
        error instanceof InvalidAuditLogListInputError
      ) {
        throw invalidAuditLogQuery(error.message);
      }
      if (error instanceof AuditLogUnavailableError) {
        throw new ServiceUnavailableException(
          errorPayload("AUDIT_LOG_UNAVAILABLE", error.message),
        );
      }
      throw error;
    }
  }
}

function invalidAuditLogQuery(message: string, issues?: unknown[]) {
  return new BadRequestException(
    errorPayload("INVALID_AUDIT_LOG_QUERY", message, issues),
  );
}

function errorPayload(code: string, message: string, issues?: unknown[]) {
  return {
    code,
    message,
    requestId: randomUUID(),
    ...(issues ? { issues: normalizeIssues(issues) } : {}),
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
