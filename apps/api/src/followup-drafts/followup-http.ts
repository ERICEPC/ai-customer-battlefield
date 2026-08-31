import { randomUUID } from "node:crypto";
import { idempotencyKeySchema } from "@battlefield/contracts";
import {
  FollowupDraftExpiredError,
  FollowupDraftNotFoundError,
  FollowupDraftNotPendingError,
  FollowupDraftVersionConflictError,
  FollowupIdempotencyConflictError,
  FollowupNotFoundError,
  FollowupRelatedRecordNotFoundError,
  InvalidFollowupDraftCandidateError,
  InvalidIdempotencyKeyError,
  InvalidRawInputError,
} from "@battlefield/core";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { SenseAudioFollowupDraftAgentError } from "./senseaudio-followup-draft-agent.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function developmentActor(
  tenantId?: string,
  userId?: string,
): { tenantId: string; userId: string } {
  if (process.env.NODE_ENV === "production" || !tenantId || !userId) {
    throw new UnauthorizedException("Authentication is required.");
  }
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(userId)) {
    throw new UnauthorizedException(
      "Development actor identifiers are invalid.",
    );
  }
  return { tenantId, userId };
}

export function draftIdentifier(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw invalidRequest("Draft identifier must be a UUID.");
  }
  return value;
}

export function followupIdentifier(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw invalidRequest("Follow-up identifier must be a UUID.");
  }
  return value;
}

export function eventIdentifier(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw invalidRequest("Event identifier must be a UUID.");
  }
  return value;
}

export function idempotencyKey(value?: string): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw invalidRequest("A valid Idempotency-Key header is required.");
  }
  return parsed.data;
}

export function invalidRequest(message: string, issues?: unknown[]) {
  return new BadRequestException({
    code: "INVALID_FOLLOWUP_DRAFT",
    message,
    requestId: randomUUID(),
    ...(issues ? { issues: normalizeIssues(issues) } : {}),
  });
}

export function mapFollowupError(
  error: unknown,
  receivedVersionNo?: string,
): never {
  if (error instanceof FollowupDraftNotFoundError) {
    throw new NotFoundException(payload("DRAFT_NOT_FOUND", error.message));
  }
  if (error instanceof FollowupNotFoundError) {
    throw new NotFoundException(payload("FOLLOWUP_NOT_FOUND", error.message));
  }
  if (error instanceof FollowupDraftVersionConflictError) {
    throw new ConflictException({
      ...payload("DRAFT_VERSION_CONFLICT", error.message),
      issues: [
        {
          path: "versionNo",
          reason: receivedVersionNo
            ? `expected ${error.latestVersionNo}, received ${receivedVersionNo}`
            : `expected ${error.latestVersionNo}`,
        },
      ],
    });
  }
  if (error instanceof FollowupDraftNotPendingError) {
    throw new ConflictException(payload("DRAFT_NOT_PENDING", error.message));
  }
  if (error instanceof FollowupDraftExpiredError) {
    throw new ConflictException(payload("DRAFT_EXPIRED", error.message));
  }
  if (error instanceof FollowupIdempotencyConflictError) {
    throw new ConflictException(
      payload("IDEMPOTENCY_KEY_REUSED", error.message),
    );
  }
  if (error instanceof FollowupRelatedRecordNotFoundError) {
    throw new NotFoundException(
      payload(
        error.recordType === "entity"
          ? "RELATED_ENTITY_NOT_FOUND"
          : "RELATED_OPPORTUNITY_NOT_FOUND",
        error.message,
      ),
    );
  }
  if (
    error instanceof InvalidFollowupDraftCandidateError ||
    error instanceof InvalidIdempotencyKeyError ||
    error instanceof InvalidRawInputError
  ) {
    throw invalidRequest(error.message);
  }
  if (error instanceof SenseAudioFollowupDraftAgentError) {
    if (error.code === "invalid_response") {
      throw new BadGatewayException(
        payload(
          "AGENT_INVALID_RESPONSE",
          "AI 返回内容未通过业务校验，请重试。你的输入尚未入库。",
        ),
      );
    }
    throw new ServiceUnavailableException(
      payload(
        "AGENT_UNAVAILABLE",
        "AI 拆解服务暂时不可用，请稍后重试。你的输入尚未入库。",
      ),
    );
  }
  throw error;
}

function payload(code: string, message: string) {
  return { code, message, requestId: randomUUID() };
}

function normalizeIssues(issues: unknown[]) {
  return issues.map((issue, index) => {
    if (issue && typeof issue === "object") {
      const candidate = issue as { path?: unknown; message?: unknown };
      const path = Array.isArray(candidate.path)
        ? candidate.path.map(String).join(".")
        : String(candidate.path ?? index);
      const reason =
        typeof candidate.message === "string"
          ? candidate.message
          : "Invalid value.";
      return { path, reason };
    }
    return { path: String(index), reason: "Invalid value." };
  });
}
