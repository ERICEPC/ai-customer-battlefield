export function apiBaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  const configured = environment.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  if (environment.NODE_ENV === "production") {
    throw new Error("The production API endpoint is not configured.");
  }
  return "http://localhost:3001";
}

export function withSessionCredentials(init: RequestInit = {}): RequestInit {
  return { ...init, credentials: "include" };
}
