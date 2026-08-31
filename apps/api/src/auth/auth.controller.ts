import { randomUUID } from "node:crypto";
import {
  type LoginResponse,
  loginRequestSchema,
  loginResponseSchema,
  type SessionProfile,
  sessionProfileSchema,
} from "@battlefield/contracts";
import {
  type AuthenticateSession,
  InvalidCredentialsError,
  type RevokeSession,
} from "@battlefield/core";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

import { PublicRoute, SESSION_COOKIE_NAME } from "./auth.constants.js";
import { AUTHENTICATE_SESSION, REVOKE_SESSION } from "./auth.providers.js";
import type { AuthenticatedRequest } from "./authenticated-request.js";

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AUTHENTICATE_SESSION)
    private readonly authenticateSession: AuthenticateSession,
    @Inject(REVOKE_SESSION)
    private readonly revokeSession: RevokeSession,
  ) {}

  @Post("login")
  @PublicRoute()
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HeaderResponse,
  ): Promise<LoginResponse> {
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: "INVALID_LOGIN_REQUEST",
        message: "请检查租户、邮箱和密码格式。",
        requestId: randomUUID(),
      });
    }
    try {
      const result = await this.authenticateSession.execute(parsed.data);
      response.setHeader("Set-Cookie", sessionCookie(result.cookieValue));
      return loginResponseSchema.parse({ session: result.session });
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        throw new UnauthorizedException({
          code: "INVALID_CREDENTIALS",
          message: "租户、邮箱或密码不正确。",
          requestId: randomUUID(),
        });
      }
      throw authenticationUnavailable();
    }
  }

  @Get("session")
  session(@Req() request: AuthenticatedRequest): SessionProfile {
    if (!request.auth) {
      throw new UnauthorizedException({
        code: "AUTHENTICATION_REQUIRED",
        message: "请先登录后继续。",
        requestId: randomUUID(),
      });
    }
    return sessionProfileSchema.parse(request.auth.session);
  }

  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ): Promise<void> {
    if (!request.auth) {
      throw new UnauthorizedException({
        code: "AUTHENTICATION_REQUIRED",
        message: "请先登录后继续。",
        requestId: randomUUID(),
      });
    }
    try {
      await this.revokeSession.execute({
        actor: request.auth.actor,
        sessionId: request.auth.sessionId,
      });
      response.setHeader("Set-Cookie", clearSessionCookie());
    } catch {
      throw authenticationUnavailable();
    }
  }
}

function sessionCookie(value: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=28800",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

function authenticationUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: "AUTHENTICATION_UNAVAILABLE",
    message: "登录服务暂时不可用，请稍后重试。",
    requestId: randomUUID(),
  });
}
