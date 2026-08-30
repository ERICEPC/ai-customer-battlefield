export interface DevelopmentActor {
  userId: string;
  displayName: string;
}

const defaultUserId = "30000000-0000-4000-8000-000000000001";

export function developmentActorConfiguration(
  environment: Record<string, string | undefined> = process.env,
): DevelopmentActor {
  const userId = environment.NEXT_PUBLIC_DEV_USER_ID ?? defaultUserId;
  const configuredName = environment.NEXT_PUBLIC_DEV_USER_DISPLAY_NAME?.trim();
  return {
    userId,
    displayName:
      configuredName ||
      (userId === defaultUserId
        ? "alpha-owner"
        : `开发用户 ${userId.slice(-8)}`),
  };
}
