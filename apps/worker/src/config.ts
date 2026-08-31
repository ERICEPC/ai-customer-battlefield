import type { FeishuChannelConfig } from "./channels/channel-registry.js";

export interface WorkerConfig {
  databaseUrl: string;
  actor: { tenantId: string; userId: string };
  batchSize: number;
  idlePollMs: number;
  busyPollMs: number;
  leaseMs: number;
  feishu: FeishuChannelConfig | null;
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
    feishu: loadFeishuConfig(environment),
  };
}

function loadFeishuConfig(
  environment: Record<string, string | undefined>,
): FeishuChannelConfig | null {
  const appId = optional(environment.FEISHU_APP_ID);
  const appSecret = optional(environment.FEISHU_APP_SECRET);
  if (!appId && !appSecret) {
    return null;
  }
  if (!appId || !appSecret) {
    throw new Error(
      "FEISHU_APP_ID and FEISHU_APP_SECRET must be configured together.",
    );
  }
  const receiveIdType =
    optional(environment.FEISHU_RECEIVE_ID_TYPE) ?? "open_id";
  if (receiveIdType !== "open_id") {
    throw new Error("FEISHU_RECEIVE_ID_TYPE must be open_id.");
  }
  const publicWebBaseUrl = normalizePublicWebBaseUrl(
    required(environment, "PUBLIC_WEB_BASE_URL"),
  );
  return { appId, appSecret, publicWebBaseUrl, receiveIdType };
}

function normalizePublicWebBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("PUBLIC_WEB_BASE_URL must be an absolute HTTPS URL.");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
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

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
