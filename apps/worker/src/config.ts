export interface WorkerConfig {
  databaseUrl: string;
  actor: { tenantId: string; userId: string };
  batchSize: number;
  idlePollMs: number;
  busyPollMs: number;
  leaseMs: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadWorkerConfig(
  environment: Record<string, string | undefined>,
): WorkerConfig {
  const databaseUrl = required(environment, "DATABASE_URL");
  const parsedUrl = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
  }
  const tenantId = required(environment, "WORKER_TENANT_ID");
  const userId = required(environment, "WORKER_USER_ID");
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(userId)) {
    throw new Error("Worker tenant and user identifiers must be UUIDs.");
  }
  return {
    databaseUrl,
    actor: { tenantId, userId },
    batchSize: boundedInteger(environment.WORKER_BATCH_SIZE, 50, 1, 50),
    idlePollMs: boundedInteger(
      environment.WORKER_IDLE_POLL_MS,
      5_000,
      10,
      300_000,
    ),
    busyPollMs: boundedInteger(environment.WORKER_BUSY_POLL_MS, 50, 10, 60_000),
    leaseMs: boundedInteger(
      environment.WORKER_LEASE_MS,
      60_000,
      1_000,
      3_600_000,
    ),
  };
}

function required(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Worker numeric configuration must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}
