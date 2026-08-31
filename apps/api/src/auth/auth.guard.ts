import type { IdentityRole, ResolveSession } from "@battlefield/core";
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import {
  PUBLIC_ROUTE,
  REQUIRED_ROLES,
  SESSION_COOKIE_NAME,
} from "./auth.constants.js";
import { RESOLVE_SESSION } from "./auth.providers.js";
import type { AuthenticatedRequest } from "./authenticated-request.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RESOLVE_SESSION) private readonly resolveSession: ResolveSession,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookieValue = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    if (!cookieValue) {
      if (testActorHeadersAreValid(request.headers)) return true;
      throw authenticationRequired();
    }

    try {
      const identity = await this.resolveSession.execute({ cookieValue });
      if (!identity) throw authenticationRequired();
      request.auth = identity;
      request.headers["x-tenant-id"] = identity.actor.tenantId;
      request.headers["x-user-id"] = identity.actor.userId;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException({
        code: "AUTHENTICATION_UNAVAILABLE",
        message: "登录服务暂时不可用，请稍后重试。",
        requestId: crypto.randomUUID(),
      });
    }

    const requiredRoles = this.reflector.getAllAndOverride<IdentityRole[]>(
      REQUIRED_ROLES,
      [context.getHandler(), context.getClass()],
    );
    const authenticatedRole = request.auth?.session.role;
    if (
      requiredRoles?.length &&
      (!authenticatedRole || !requiredRoles.includes(authenticatedRole))
    ) {
      throw roleForbidden();
    }
    return true;
  }
}

function readCookie(
  header: string | string[] | undefined,
  name: string,
): string | null {
  const serialized = Array.isArray(header) ? header.join(";") : header;
  if (!serialized) return null;
  for (const part of serialized.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

function testActorHeadersAreValid(
  headers: AuthenticatedRequest["headers"],
): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  const tenantId = singleHeader(headers["x-tenant-id"]);
  const userId = singleHeader(headers["x-user-id"]);
  return UUID_PATTERN.test(tenantId ?? "") && UUID_PATTERN.test(userId ?? "");
}

function singleHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function authenticationRequired(): UnauthorizedException {
  return new UnauthorizedException({
    code: "AUTHENTICATION_REQUIRED",
    message: "请先登录后继续。",
    requestId: crypto.randomUUID(),
  });
}

function roleForbidden(): ForbiddenException {
  return new ForbiddenException({
    code: "ROLE_FORBIDDEN",
    message: "当前身份不能使用该功能。",
    requestId: crypto.randomUUID(),
  });
}
