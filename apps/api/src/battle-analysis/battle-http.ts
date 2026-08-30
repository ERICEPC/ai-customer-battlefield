import { randomUUID } from "node:crypto";
import { idempotencyKeySchema } from "@battlefield/contracts";
import {
  ActionIdempotencyConflictError,
  ActionOwnerNotFoundError,
  ActionProposalExpiredError,
  ActionProposalNotFoundError,
  ActionProposalNotPendingError,
  ActionProposalVersionConflictError,
  BattleAnalysisInputChangedError,
  BattleAnalysisNotFoundError,
  BattleAnalysisStaleError,
  BattleAnalyzerExecutionError,
  BattleStateNotFoundError,
  BusinessActionNotFoundError,
  BusinessActionVersionConflictError,
  InvalidActionDecisionError,
  InvalidActionIdempotencyKeyError,
  InvalidActionQueryCursorError,
  InvalidBattleAnalysisCandidateError,
  InvalidBattleMapCursorError,
  InvalidBusinessActionTransitionError,
} from "@battlefield/core";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resourceIdentifier(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw invalidBattleRequest(`${label} identifier must be a UUID.`);
  }
  return value;
}

export function actionIdempotencyKey(value?: string): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw invalidActionRequest("A valid Idempotency-Key header is required.");
  }
  return parsed.data;
}

export function invalidBattleRequest(message: string, issues?: unknown[]) {
  return new BadRequestException(
    payload("INVALID_BATTLE_ANALYSIS", message, issues),
  );
}

export function invalidActionRequest(message: string, issues?: unknown[]) {
  return new BadRequestException(
    payload("INVALID_ACTION_DECISION", message, issues),
  );
}

export function mapBattleError(error: unknown): never {
  if (error instanceof BattleStateNotFoundError) {
    throw new NotFoundException(
      payload("BATTLE_STATE_NOT_FOUND", error.message),
    );
  }
  if (error instanceof BattleAnalysisNotFoundError) {
    throw new NotFoundException(payload("ANALYSIS_NOT_FOUND", error.message));
  }
  if (error instanceof BattleAnalysisInputChangedError) {
    throw new ConflictException(
      payload("ANALYSIS_INPUT_STALE", error.message, [
        {
          path: "expectedInputVersion",
          message: `latest input version is ${error.latestInputVersion}`,
        },
      ]),
    );
  }
  if (error instanceof BattleAnalysisStaleError) {
    throw new ConflictException(payload("ANALYSIS_INPUT_STALE", error.message));
  }
  if (error instanceof InvalidBattleAnalysisCandidateError) {
    throw new UnprocessableEntityException(
      payload("INVALID_BATTLE_ANALYSIS", error.message),
    );
  }
  if (error instanceof BattleAnalyzerExecutionError) {
    throw new UnprocessableEntityException(
      payload("INVALID_BATTLE_ANALYSIS", error.message),
    );
  }
  if (error instanceof InvalidBattleMapCursorError) {
    throw invalidBattleRequest(error.message);
  }
  throw error;
}

export function mapActionError(
  error: unknown,
  receivedVersionNo?: string,
): never {
  if (error instanceof ActionProposalNotFoundError) {
    throw new NotFoundException(
      payload("ACTION_PROPOSAL_NOT_FOUND", error.message),
    );
  }
  if (error instanceof ActionProposalVersionConflictError) {
    throw new ConflictException(
      payload("ACTION_PROPOSAL_VERSION_CONFLICT", error.message, [
        {
          path: "versionNo",
          message: receivedVersionNo
            ? `expected ${error.latestVersionNo}, received ${receivedVersionNo}`
            : `expected ${error.latestVersionNo}`,
        },
      ]),
    );
  }
  if (error instanceof ActionProposalNotPendingError) {
    throw new ConflictException(
      payload("ACTION_PROPOSAL_NOT_PENDING", error.message),
    );
  }
  if (error instanceof ActionProposalExpiredError) {
    throw new ConflictException(
      payload("ACTION_PROPOSAL_EXPIRED", error.message),
    );
  }
  if (error instanceof ActionIdempotencyConflictError) {
    throw new ConflictException(
      payload("ACTION_IDEMPOTENCY_KEY_REUSED", error.message),
    );
  }
  if (error instanceof ActionOwnerNotFoundError) {
    throw new NotFoundException(
      payload("ACTION_OWNER_NOT_FOUND", error.message),
    );
  }
  if (error instanceof BusinessActionNotFoundError) {
    throw new NotFoundException(payload("ACTION_NOT_FOUND", error.message));
  }
  if (error instanceof BusinessActionVersionConflictError) {
    throw new ConflictException(
      payload("ACTION_VERSION_CONFLICT", error.message, [
        {
          path: "versionNo",
          message: receivedVersionNo
            ? `expected ${error.latestVersionNo}, received ${receivedVersionNo}`
            : `expected ${error.latestVersionNo}`,
        },
      ]),
    );
  }
  if (error instanceof InvalidBusinessActionTransitionError) {
    throw new UnprocessableEntityException(
      payload("INVALID_ACTION_TRANSITION", error.message),
    );
  }
  if (
    error instanceof InvalidActionDecisionError ||
    error instanceof InvalidActionIdempotencyKeyError ||
    error instanceof InvalidActionQueryCursorError ||
    error instanceof RangeError
  ) {
    throw invalidActionRequest(error.message);
  }
  throw error;
}

function payload(code: string, message: string, issues?: unknown[]) {
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
