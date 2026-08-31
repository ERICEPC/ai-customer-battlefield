import type { ManagementCapability } from "@battlefield/core";
import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE = "battlefield.public-route";
export const REQUIRED_CAPABILITIES = "battlefield.required-capabilities";
export const SESSION_COOKIE_NAME = "battlefield_session";

export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true);
export const RequireCapabilities = (...capabilities: ManagementCapability[]) =>
  SetMetadata(REQUIRED_CAPABILITIES, capabilities);
