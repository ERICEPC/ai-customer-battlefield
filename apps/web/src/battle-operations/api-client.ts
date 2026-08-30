import {
  type AcceptActionProposalRequest,
  type ActionDecisionResponse,
  type ActionOwnerListQuery,
  type ActionOwnerPage,
  type ActionProposalListQuery,
  type ActionProposalPage,
  type ActionProposalRecord,
  type ActionTransitionResponse,
  acceptActionProposalRequestSchema,
  actionApiErrorSchema,
  actionDecisionResponseSchema,
  actionOwnerListQuerySchema,
  actionOwnerPageSchema,
  actionProposalListQuerySchema,
  actionProposalPageSchema,
  actionProposalRecordSchema,
  actionTransitionResponseSchema,
  type BattleAnalysisResult,
  type BattleMapPage,
  type BattleMapQuery,
  type BattleStateDetail,
  type BusinessActionListQuery,
  type BusinessActionPage,
  battleAnalysisResultSchema,
  battleMapPageSchema,
  battleMapQuerySchema,
  battleStateDetailSchema,
  businessActionListQuerySchema,
  businessActionPageSchema,
  type RejectActionProposalRequest,
  rejectActionProposalRequestSchema,
  type TransitionBusinessActionRequest,
  transitionBusinessActionRequestSchema,
} from "@battlefield/contracts";

export class BattleOperationsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "BattleOperationsApiError";
  }
}

function configuration(): {
  baseUrl: string;
  headers: Record<string, string>;
} {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (process.env.NODE_ENV === "production") {
    if (!configuredBaseUrl) {
      throw new Error("The production API endpoint is not configured.");
    }
    throw new Error("Production authentication is not configured.");
  }
  return {
    baseUrl: configuredBaseUrl ?? "http://localhost:3001",
    headers: {
      "x-tenant-id":
        process.env.NEXT_PUBLIC_DEV_TENANT_ID ??
        "10000000-0000-4000-8000-000000000001",
      "x-user-id":
        process.env.NEXT_PUBLIC_DEV_USER_ID ??
        "30000000-0000-4000-8000-000000000001",
    },
  };
}

async function request<T>(
  path: string,
  schema: { parse(input: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  const { baseUrl, headers } = configuration();
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = actionApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new BattleOperationsApiError(
        response.status,
        parsed.data.code,
        parsed.data.message,
        parsed.data.requestId,
      );
    }
    throw new BattleOperationsApiError(
      response.status,
      "UNEXPECTED_RESPONSE",
      `请求失败（${response.status}），请稍后重试。`,
    );
  }
  return schema.parse(payload);
}

function queryString(input: Record<string, unknown>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  const serialized = parameters.toString();
  return serialized ? `?${serialized}` : "";
}

export async function listBattleMap(
  input: BattleMapQuery,
): Promise<BattleMapPage> {
  const query = battleMapQuerySchema.parse(input);
  return request(`/battle-map${queryString(query)}`, battleMapPageSchema);
}

export async function getBattleState(
  entityId: string,
  battleStateVersionId?: string,
): Promise<BattleStateDetail> {
  return request(
    battleStateVersionId
      ? `/business-entities/${encodeURIComponent(entityId)}/battle-states/${encodeURIComponent(battleStateVersionId)}`
      : `/business-entities/${encodeURIComponent(entityId)}/battle-state`,
    battleStateDetailSchema,
  );
}

export async function requestBattleAnalysis(
  entityId: string,
): Promise<BattleAnalysisResult> {
  return request(
    `/business-entities/${encodeURIComponent(entityId)}/analysis-runs`,
    battleAnalysisResultSchema,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
}

export async function listActionProposals(
  input: ActionProposalListQuery,
): Promise<ActionProposalPage> {
  const query = actionProposalListQuerySchema.parse(input);
  return request(
    `/action-proposals${queryString(query)}`,
    actionProposalPageSchema,
  );
}

export async function listActionOwners(
  input: ActionOwnerListQuery,
): Promise<ActionOwnerPage> {
  const query = actionOwnerListQuerySchema.parse(input);
  return request(`/action-owners${queryString(query)}`, actionOwnerPageSchema);
}

export async function getActionProposal(
  proposalId: string,
): Promise<ActionProposalRecord> {
  return request(
    `/action-proposals/${encodeURIComponent(proposalId)}`,
    actionProposalRecordSchema,
  );
}

export async function acceptActionProposal(
  proposalId: string,
  input: AcceptActionProposalRequest,
  idempotencyKey: string,
): Promise<ActionDecisionResponse> {
  const body = acceptActionProposalRequestSchema.parse(input);
  return request(
    `/action-proposals/${encodeURIComponent(proposalId)}/accept`,
    actionDecisionResponseSchema,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
}

export async function rejectActionProposal(
  proposalId: string,
  input: RejectActionProposalRequest,
  idempotencyKey: string,
): Promise<ActionDecisionResponse> {
  const body = rejectActionProposalRequestSchema.parse(input);
  return request(
    `/action-proposals/${encodeURIComponent(proposalId)}/reject`,
    actionDecisionResponseSchema,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
}

export async function listBusinessActions(
  input: BusinessActionListQuery,
): Promise<BusinessActionPage> {
  const query = businessActionListQuerySchema.parse(input);
  return request(`/actions${queryString(query)}`, businessActionPageSchema);
}

export async function transitionBusinessAction(
  actionId: string,
  input: TransitionBusinessActionRequest,
): Promise<ActionTransitionResponse> {
  const body = transitionBusinessActionRequestSchema.parse(input);
  return request(
    `/actions/${encodeURIComponent(actionId)}/transition`,
    actionTransitionResponseSchema,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
