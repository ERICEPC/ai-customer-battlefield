import { randomUUID } from "node:crypto";
import {
  type TestUserAiConnectionResponse,
  testUserAiConnectionResponseSchema,
  type UserAiSettingsResponse,
  updateUserAiSettingsRequestSchema,
  userAiSettingsResponseSchema,
} from "@battlefield/contracts";
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

import type { AuthenticatedRequest } from "../auth/authenticated-request.js";
import {
  type ApplicationUserAiSettingsService,
  USER_AI_SETTINGS_SERVICE,
} from "./user-ai-settings.providers.js";
import { UserAiSettingsError } from "./user-ai-settings.service.js";

@Controller("me/ai-settings")
export class UserAiSettingsController {
  constructor(
    @Inject(USER_AI_SETTINGS_SERVICE)
    private readonly service: ApplicationUserAiSettingsService,
  ) {}

  @Get()
  async get(
    @Req() request: AuthenticatedRequest,
  ): Promise<UserAiSettingsResponse> {
    return userAiSettingsResponseSchema.parse(
      await this.configured().get(actor(request)),
    );
  }

  @Patch()
  async update(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<UserAiSettingsResponse> {
    const parsed = updateUserAiSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        payload("INVALID_AI_SETTINGS", "请检查模型和 API Key 格式。"),
      );
    }
    return userAiSettingsResponseSchema.parse(
      await this.configured().update(actor(request), parsed.data),
    );
  }

  @Post("test")
  async testConnection(
    @Req() request: AuthenticatedRequest,
  ): Promise<TestUserAiConnectionResponse> {
    try {
      return testUserAiConnectionResponseSchema.parse(
        await this.configured().testConnection(actor(request)),
      );
    } catch (error) {
      if (error instanceof UserAiSettingsError) {
        if (error.code === "AI_KEY_NOT_CONFIGURED") {
          throw new BadRequestException(payload(error.code, error.message));
        }
        if (error.code === "AI_CONNECTION_FAILED") {
          throw new BadGatewayException(payload(error.code, error.message));
        }
      }
      throw unavailable();
    }
  }

  private configured() {
    if (!this.service) throw unavailable();
    return this.service;
  }
}

function actor(request: AuthenticatedRequest): {
  tenantId: string;
  userId: string;
} {
  if (!request.auth) {
    throw new UnauthorizedException(
      payload("AI_SETTINGS_UNAVAILABLE", "请先登录后继续。"),
    );
  }
  return request.auth.actor;
}

function payload(code: string, message: string) {
  return { code, message, requestId: randomUUID() };
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException(
    payload("AI_SETTINGS_UNAVAILABLE", "个人 AI 设置暂时不可用。"),
  );
}
