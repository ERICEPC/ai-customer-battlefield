import type { IdentityRole } from "@battlefield/core";
import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE = "battlefield.public-route";
export const REQUIRED_ROLES = "battlefield.required-roles";
export const SESSION_COOKIE_NAME = "battlefield_session";

export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true);
export const RequireRoles = (...roles: IdentityRole[]) =>
  SetMetadata(REQUIRED_ROLES, roles);
