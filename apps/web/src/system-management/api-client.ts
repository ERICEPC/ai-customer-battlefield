import {
  type AccessControlSnapshot,
  type AiRuntimeConfigVersion,
  type AiRuntimeConfigVersionPage,
  type AsyncWorkFailurePage,
  type AsyncWorkKind,
  type AsyncWorkReplayResponse,
  type AuditEntryListQuery,
  type AuditEntryPage,
  accessControlApiErrorSchema,
  accessControlRoleCodeSchema,
  accessControlSnapshotSchema,
  aiRuntimeConfigApiErrorSchema,
  aiRuntimeConfigVersionPageSchema,
  aiRuntimeConfigVersionSchema,
  asyncWorkFailurePageSchema,
  asyncWorkReplayResponseSchema,
  auditEntryListQuerySchema,
  auditEntryPageSchema,
  auditLogApiErrorSchema,
  type CreateAiRuntimeConfigVersionRequest,
  createAiRuntimeConfigVersionRequestSchema,
  idempotencyKeySchema,
  type ManagementCapability,
  type ReleasedAiRuntimeConfig,
  type RoleCapabilityUpdate,
  releaseAiRuntimeConfigVersionRequestSchema,
  releasedAiRuntimeConfigSchema,
  replaceRoleCapabilitiesRequestSchema,
  replayAsyncWorkItemRequestSchema,
  roleCapabilityUpdateSchema,
  type WorkerOperationsHealth,
  workerOperationsApiErrorSchema,
  workerOperationsHealthSchema,
} from "@battlefield/contracts";

import { apiBaseUrl, withSessionCredentials } from "../api/api-configuration";

export class SystemManagementApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "SystemManagementApiError";
  }
}

export function listAiRuntimeConfigVersions(): Promise<AiRuntimeConfigVersionPage> {
  return request(
    "/ai-runtime-configs/followup_extraction/versions?limit=100",
    aiRuntimeConfigVersionPageSchema,
  );
}

export function createAiRuntimeConfigVersion(
  input: CreateAiRuntimeConfigVersionRequest,
): Promise<AiRuntimeConfigVersion> {
  return request(
    "/ai-runtime-configs/followup_extraction/versions",
    aiRuntimeConfigVersionSchema,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createAiRuntimeConfigVersionRequestSchema.parse(input),
      ),
    },
  );
}

export function releaseAiRuntimeConfigVersion(
  versionId: string,
  reason: string,
): Promise<ReleasedAiRuntimeConfig> {
  const body = releaseAiRuntimeConfigVersionRequestSchema.parse({
    versionId,
    reason,
  });
  return request(
    "/ai-runtime-configs/followup_extraction/releases",
    releasedAiRuntimeConfigSchema,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function getWorkerOperationsHealth(): Promise<WorkerOperationsHealth> {
  return request("/worker-operations/health", workerOperationsHealthSchema);
}

export function listAsyncWorkFailures(): Promise<AsyncWorkFailurePage> {
  return request(
    "/worker-operations/failures?limit=100",
    asyncWorkFailurePageSchema,
  );
}

export function replayAsyncWorkItem(
  kind: AsyncWorkKind,
  workItemId: string,
  reason: string,
  idempotencyKey: string,
): Promise<AsyncWorkReplayResponse> {
  const body = replayAsyncWorkItemRequestSchema.parse({ reason });
  const key = idempotencyKeySchema.parse(idempotencyKey);
  return request(
    `/worker-operations/${kind}/${encodeURIComponent(assertUuid(workItemId))}/replay`,
    asyncWorkReplayResponseSchema,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    },
  );
}

export function listRecentAuditEntries(
  input: AuditEntryListQuery = {},
): Promise<AuditEntryPage> {
  const query = auditEntryListQuerySchema.parse({
    limit: input.limit ?? 20,
    ...input,
  });
  const search = new URLSearchParams();
  for (const key of [
    "limit",
    "cursor",
    "actorUserId",
    "aggregateType",
    "aggregateId",
    "action",
    "occurredFrom",
    "occurredBefore",
  ] as const) {
    const value = query[key];
    if (value !== undefined) search.set(key, String(value));
  }
  return request(`/audit-entries?${search}`, auditEntryPageSchema);
}

export function getAccessControlSnapshot(): Promise<AccessControlSnapshot> {
  return request(
    "/access-control/role-capabilities",
    accessControlSnapshotSchema,
  );
}

export function replaceRoleCapabilities(
  roleCode: string,
  capabilities: ManagementCapability[],
  reason: string,
  idempotencyKey: string,
): Promise<RoleCapabilityUpdate> {
  const role = accessControlRoleCodeSchema.parse(roleCode);
  const body = replaceRoleCapabilitiesRequestSchema.parse({
    capabilities,
    reason,
  });
  const key = idempotencyKeySchema.parse(idempotencyKey);
  return request(
    `/access-control/roles/${encodeURIComponent(role)}/capabilities`,
    roleCapabilityUpdateSchema,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    },
  );
}

async function request<Output>(
  path: string,
  schema: { parse(input: unknown): Output },
  init: RequestInit = {},
): Promise<Output> {
  const response = await fetch(
    `${apiBaseUrl()}/api/v1${path}`,
    withSessionCredentials(init),
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw decodeError(response.status, payload);
  return schema.parse(payload);
}

function decodeError(
  status: number,
  payload: unknown,
): SystemManagementApiError {
  for (const schema of [
    accessControlApiErrorSchema,
    aiRuntimeConfigApiErrorSchema,
    workerOperationsApiErrorSchema,
    auditLogApiErrorSchema,
  ]) {
    const parsed = schema.safeParse(payload);
    if (parsed.success) {
      return new SystemManagementApiError(
        status,
        parsed.data.code,
        parsed.data.message,
        parsed.data.requestId,
      );
    }
  }
  return new SystemManagementApiError(
    status,
    "UNEXPECTED_RESPONSE",
    `系统管理请求失败（${status}），请稍后重试。`,
  );
}

function assertUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError("异步任务标识无效。");
  }
  return value;
}
