import { randomUUID } from "node:crypto";
import {
  type AiRuntimeConfigVersion,
  type AiRuntimeConfigVersionPage,
  aiRuntimeConfigKeySchema,
  aiRuntimeConfigVersionListQuerySchema,
  aiRuntimeConfigVersionPageSchema,
  aiRuntimeConfigVersionSchema,
  createAiRuntimeConfigVersionRequestSchema,
  type ReleasedAiRuntimeConfig,
  releaseAiRuntimeConfigVersionRequestSchema,
  releasedAiRuntimeConfigSchema,
} from "@battlefield/contracts";
import {
  AiRuntimeConfigAccessDeniedError,
  type AiRuntimeConfigManager,
  AiRuntimeConfigVersionNotFoundError,
  InvalidAiRuntimeConfigCursorError,
  InvalidAiRuntimeConfigManagementInputError,
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
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";

import { RequireCapabilities } from "../auth/auth.constants.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  AI_RUNTIME_CONFIG_MANAGER,
  AiRuntimeConfigUnavailableError,
} from "./ai-runtime-config.providers.js";

@RequireCapabilities("ai_runtime_config.manage")
@Controller("ai-runtime-configs")
export class AiRuntimeConfigController {
  constructor(
    @Inject(AI_RUNTIME_CONFIG_MANAGER)
    private readonly manager: AiRuntimeConfigManager,
  ) {}

  @Get(":configKey/versions")
  async listVersions(
    @Param("configKey") configKey: string,
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<AiRuntimeConfigVersionPage> {
    const parsedQuery = aiRuntimeConfigVersionListQuerySchema.safeParse(query);
    const parsedConfigKey = aiRuntimeConfigKeySchema.safeParse(configKey);
    if (!parsedConfigKey.success) {
      throw invalidRequest(
        "AI 运行配置查询参数无效。",
        parsedConfigKey.error.issues,
      );
    }
    if (!parsedQuery.success) {
      throw invalidRequest(
        "AI 运行配置查询参数无效。",
        parsedQuery.error.issues,
      );
    }
    try {
      return aiRuntimeConfigVersionPageSchema.parse(
        await this.manager.listVersions({
          actor: developmentActor(tenantId, userId),
          configKey: parsedConfigKey.data,
          limit: parsedQuery.data.limit ?? 50,
          ...(parsedQuery.data.cursor
            ? { cursor: parsedQuery.data.cursor }
            : {}),
        }),
      );
    } catch (error) {
      return mapManagementError(error);
    }
  }

  @Post(":configKey/versions")
  async createVersion(
    @Param("configKey") configKey: string,
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<AiRuntimeConfigVersion> {
    const parsedBody =
      createAiRuntimeConfigVersionRequestSchema.safeParse(body);
    const parsedConfigKey = aiRuntimeConfigKeySchema.safeParse(configKey);
    if (!parsedConfigKey.success) {
      throw invalidRequest(
        "AI 运行配置版本内容无效。",
        parsedConfigKey.error.issues,
      );
    }
    if (!parsedBody.success) {
      throw invalidRequest(
        "AI 运行配置版本内容无效。",
        parsedBody.error.issues,
      );
    }
    try {
      return aiRuntimeConfigVersionSchema.parse(
        await this.manager.createVersion({
          actor: developmentActor(tenantId, userId),
          configKey: parsedConfigKey.data,
          ...parsedBody.data,
        }),
      );
    } catch (error) {
      return mapManagementError(error);
    }
  }

  @Post(":configKey/releases")
  async releaseVersion(
    @Param("configKey") configKey: string,
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ReleasedAiRuntimeConfig> {
    const parsedBody =
      releaseAiRuntimeConfigVersionRequestSchema.safeParse(body);
    const parsedConfigKey = aiRuntimeConfigKeySchema.safeParse(configKey);
    if (!parsedConfigKey.success) {
      throw invalidRequest(
        "AI 运行配置发布内容无效。",
        parsedConfigKey.error.issues,
      );
    }
    if (!parsedBody.success) {
      throw invalidRequest(
        "AI 运行配置发布内容无效。",
        parsedBody.error.issues,
      );
    }
    try {
      return releasedAiRuntimeConfigSchema.parse(
        await this.manager.releaseVersion({
          actor: developmentActor(tenantId, userId),
          configKey: parsedConfigKey.data,
          ...parsedBody.data,
        }),
      );
    } catch (error) {
      return mapManagementError(error);
    }
  }
}

function mapManagementError(error: unknown): never {
  if (
    error instanceof InvalidAiRuntimeConfigManagementInputError ||
    error instanceof InvalidAiRuntimeConfigCursorError
  ) {
    throw invalidRequest(error.message);
  }
  if (error instanceof AiRuntimeConfigVersionNotFoundError) {
    throw new NotFoundException(
      payload("AI_RUNTIME_CONFIG_VERSION_NOT_FOUND", error.message),
    );
  }
  if (error instanceof AiRuntimeConfigAccessDeniedError) {
    throw new ForbiddenException(
      payload("AI_RUNTIME_CONFIG_FORBIDDEN", error.message),
    );
  }
  if (error instanceof AiRuntimeConfigUnavailableError) {
    throw new ServiceUnavailableException(
      payload("AI_RUNTIME_CONFIG_UNAVAILABLE", error.message),
    );
  }
  throw error;
}

function invalidRequest(message: string, issues?: unknown[]) {
  return new BadRequestException(
    payload(
      "INVALID_AI_RUNTIME_CONFIG_REQUEST",
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
