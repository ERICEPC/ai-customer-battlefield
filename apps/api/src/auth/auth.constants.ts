import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE = "battlefield.public-route";
export const SESSION_COOKIE_NAME = "battlefield_session";

export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true);
