import { randomUUID } from "node:crypto";
import {
  type BattleRuleVersion,
  type BattleRuleVersionPage,
  battleRuleVersionListQuerySchema,
  battleRuleVersionPageSchema,
  battleRuleVersionSchema,
  createBattleRuleVersionRequestSchema,
  type ReleasedBattleRule,
  releaseBattleRuleVersionRequestSchema,
  releasedBattleRuleSchema,
} from "@battlefield/contracts";
import {
  BattleRuleAccessDeniedError,
  type BattleRuleManager,
  BattleRuleReleaseNotFoundError,
  BattleRuleVersionNotFoundError,
  InvalidBattleRuleCursorError,
  InvalidBattleRuleManagementInputError,
  InvalidBattleRuleSetError,
} from "@battlefield/core";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";

import { RequireCapabilities } from "../auth/auth.constants.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  BATTLE_RULE_MANAGER,
  BattleRuleUnavailableError,
} from "./battle-rules.providers.js";

@RequireCapabilities("business_rules.manage")
@Controller("battle-rules")
export class BattleRulesController {
  constructor(
    @Inject(BATTLE_RULE_MANAGER)
    private readonly manager: BattleRuleManager,
  ) {}

  @Get("versions")
  async listVersions(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BattleRuleVersionPage> {
    const parsed = battleRuleVersionListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidRequest("作战规则查询参数无效。", parsed.error.issues);
    }
    try {
      return battleRuleVersionPageSchema.parse(
        await this.manager.listVersions({
          actor: developmentActor(tenantId, userId),
          limit: parsed.data.limit ?? 50,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      return mapError(error);
    }
  }

  @Post("versions")
  async createVersion(
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BattleRuleVersion> {
    const parsed = createBattleRuleVersionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest("作战规则版本内容无效。", parsed.error.issues);
    }
    try {
      return battleRuleVersionSchema.parse(
        await this.manager.createVersion({
          actor: developmentActor(tenantId, userId),
          ...parsed.data,
        }),
      );
    } catch (error) {
      return mapError(error);
    }
  }

  @Post("releases")
  async releaseVersion(
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ReleasedBattleRule> {
    const parsed = releaseBattleRuleVersionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest("作战规则发布内容无效。", parsed.error.issues);
    }
    try {
      return releasedBattleRuleSchema.parse(
        await this.manager.releaseVersion({
          actor: developmentActor(tenantId, userId),
          ...parsed.data,
        }),
      );
    } catch (error) {
      return mapError(error);
    }
  }
}

function mapError(error: unknown): never {
  if (
    error instanceof InvalidBattleRuleSetError ||
    error instanceof InvalidBattleRuleManagementInputError ||
    error instanceof InvalidBattleRuleCursorError
  ) {
    throw invalidRequest(error.message);
  }
  if (error instanceof BattleRuleVersionNotFoundError) {
    throw new NotFoundException(
      payload("BATTLE_RULE_VERSION_NOT_FOUND", error.message),
    );
  }
  if (error instanceof BattleRuleReleaseNotFoundError) {
    throw new NotFoundException(
      payload("BATTLE_RULE_RELEASE_NOT_FOUND", error.message),
    );
  }
  if (error instanceof BattleRuleAccessDeniedError) {
    throw new ForbiddenException(
      payload("BATTLE_RULE_FORBIDDEN", error.message),
    );
  }
  if (error instanceof BattleRuleUnavailableError) {
    throw new ServiceUnavailableException(
      payload("BATTLE_RULE_UNAVAILABLE", error.message),
    );
  }
  throw error;
}

function invalidRequest(message: string, issues?: unknown[]) {
  return new BadRequestException(
    payload(
      "INVALID_BATTLE_RULE_REQUEST",
      message,
      issues ? normalizeIssues(issues) : undefined,
    ),
  );
}

function payload(code: string, message: string, issues?: unknown[]) {
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
