import type { AuthenticatedIdentity } from "@battlefield/core";

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthenticatedIdentity;
}
