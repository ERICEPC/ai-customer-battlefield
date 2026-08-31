import "@testing-library/jest-dom/vitest";

import type {
  AiRuntimeConfigVersion,
  AiRuntimeConfigVersionPage,
  AsyncWorkFailureRecord,
  AuditEntryPage,
  CreateAiRuntimeConfigVersionRequest,
  WorkerOperationsHealth,
} from "@battlefield/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SystemManagementWorkspace,
  type SystemManagementWorkspaceApi,
} from "./system-management-workspace";

const V1_ID = "f48fc0b0-0711-4649-bfd9-281ab0a5b5dc";
const V2_ID = "f2243ec1-f995-4c58-8ced-984e1c1d86eb";
const WORK_ITEM_ID = "d1000000-0000-4000-8000-000000000001";
const versions: AiRuntimeConfigVersionPage = {
  items: [version(V2_ID, "2", "严格契约 V2"), version(V1_ID, "1", "基础 V1")],
  currentVersionId: V2_ID,
  nextCursor: null,
};
const health: WorkerOperationsHealth = {
  observedAt: "2026-09-01T06:00:00.000Z",
  worker: {
    workerKey: "reminder_worker",
    state: "healthy",
    instanceId: "d3000000-0000-4000-8000-000000000001",
    startedAt: "2026-09-01T05:00:00.000Z",
    lastTickStartedAt: "2026-09-01T05:59:58.000Z",
    lastTickCompletedAt: "2026-09-01T05:59:59.000Z",
    lastSuccessAt: "2026-09-01T05:59:59.000Z",
    lastFailureAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  },
  queues: [
    queue("outbox", 0),
    queue("reminder", 0),
    queue("notification_delivery", 1),
  ],
};
const failure: AsyncWorkFailureRecord = {
  kind: "notification_delivery",
  workItemId: WORK_ITEM_ID,
  category: "feishu",
  status: "dead_lettered",
  attemptCount: 8,
  lastErrorCode: "NOTIFICATION_ATTEMPTS_EXHAUSTED",
  lastErrorMessage: "消息自动重试次数已用尽。",
  availableAt: "2026-09-01T05:00:00.000Z",
  claimedAt: null,
  createdAt: "2026-09-01T05:00:00.000Z",
  relatedResource: {
    type: "notification_event",
    id: "c1000000-0000-4000-8000-000000000001",
  },
};
const audits: AuditEntryPage = {
  items: [
    {
      entryId: "a1000000-0000-4000-8000-000000000001",
      aggregateType: "ai_runtime_config",
      aggregateId: V2_ID,
      action: "ai_runtime_config.released",
      actor: {
        userId: "30000000-0000-4000-8000-000000000072",
        displayName: "领导A",
      },
      requestId: "request-1",
      reason: "严格契约已验收",
      occurredAt: "2026-09-01T05:30:00.000Z",
    },
  ],
  nextCursor: null,
};

afterEach(cleanup);

describe("SystemManagementWorkspace", () => {
  test("shows the current Agent version, worker health, queues and audit trail", async () => {
    render(<SystemManagementWorkspace api={api()} />);

    expect(await screen.findByText("Worker 运行正常")).toBeVisible();
    expect(screen.getByText("严格契约 V2")).toBeVisible();
    expect(screen.getByText("当前发布")).toBeVisible();
    expect(screen.getByText("消息自动重试次数已用尽。")).toBeVisible();
    expect(screen.getByText("ai_runtime_config.released")).toBeVisible();
    expect(
      within(screen.getByLabelText("租户默认模型")).getAllByRole("option"),
    ).toHaveLength(19);
  });

  test("creates an immutable version before allowing a separate release", async () => {
    const managementApi = api();
    render(<SystemManagementWorkspace api={managementApi} />);
    await screen.findByText("严格契约 V2");

    fireEvent.change(screen.getByLabelText("版本名称"), {
      target: { value: "销售跟进拆解 V3" },
    });
    fireEvent.change(screen.getByLabelText("System Prompt"), {
      target: { value: "只提取明确事实并返回严格 JSON。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建不可变版本" }));

    expect(managementApi.createVersion).toHaveBeenCalledWith({
      name: "销售跟进拆解 V3",
      defaultModelId: "senseaudio-s2-flash",
      systemPrompt: "只提取明确事实并返回严格 JSON。",
      parameters: { temperature: 0.1, maxTokens: 1200 },
    });
    expect(
      await screen.findByText("版本 3 已创建，尚未影响线上 Agent。"),
    ).toBeVisible();
  });

  test("supports explicit rollback reasons and dead-letter replay reasons", async () => {
    const managementApi = api();
    render(<SystemManagementWorkspace api={managementApi} />);
    await screen.findByText("严格契约 V2");

    fireEvent.change(screen.getByLabelText("待发布版本"), {
      target: { value: V1_ID },
    });
    fireEvent.change(screen.getByLabelText("发布或回滚原因"), {
      target: { value: "回滚验证" },
    });
    fireEvent.click(screen.getByRole("button", { name: "回滚到此版本" }));
    expect(managementApi.releaseVersion).toHaveBeenCalledWith(
      V1_ID,
      "回滚验证",
    );

    fireEvent.change(screen.getByLabelText("重放原因 feishu"), {
      target: { value: "飞书凭证已恢复" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重新进入队列" }));
    expect(managementApi.replayFailure).toHaveBeenCalledWith(
      failure,
      "飞书凭证已恢复",
      expect.any(String),
    );
  });
});

function api(): SystemManagementWorkspaceApi {
  const created = version(
    "f3000000-0000-4000-8000-000000000001",
    "3",
    "销售跟进拆解 V3",
  );
  return {
    listVersions: vi
      .fn()
      .mockResolvedValueOnce(versions)
      .mockResolvedValue({
        items: [created, ...versions.items],
        currentVersionId: versions.currentVersionId,
        nextCursor: null,
      }),
    createVersion: vi.fn(
      async (
        input: CreateAiRuntimeConfigVersionRequest,
      ): Promise<AiRuntimeConfigVersion> => ({ ...created, ...input }),
    ),
    releaseVersion: vi.fn().mockResolvedValue({
      configId: V1_ID,
      configKey: "followup_extraction",
      versionNo: "1",
      releaseNo: "3",
      name: "基础 V1",
      provider: "senseaudio",
      defaultModelId: "senseaudio-s2-flash",
      systemPrompt: "只返回严格 JSON。",
      parameters: { temperature: 0.1, maxTokens: 1200 },
      releasedAt: "2026-09-01T06:10:00.000Z",
    }),
    getHealth: vi.fn().mockResolvedValue(health),
    listFailures: vi.fn().mockResolvedValue({
      items: [failure],
      nextCursor: null,
    }),
    replayFailure: vi.fn().mockResolvedValue({ status: "queued" }),
    listAudits: vi.fn().mockResolvedValue(audits),
  };
}

function version(
  versionId: string,
  versionNo: string,
  name: string,
): AiRuntimeConfigVersion {
  return {
    versionId,
    configKey: "followup_extraction",
    versionNo,
    name,
    provider: "senseaudio",
    defaultModelId: "senseaudio-s2-flash",
    systemPrompt: "只返回严格 JSON。",
    parameters: { temperature: 0.1, maxTokens: 1200 },
    contentFingerprint: versionNo.repeat(64),
    createdBy: "30000000-0000-4000-8000-000000000072",
    createdAt: `2026-09-01T0${versionNo}:00:00.000Z`,
  };
}

function queue(
  kind: "outbox" | "reminder" | "notification_delivery",
  deadLetteredCount: number,
) {
  return {
    kind,
    readyCount: 0,
    processingCount: 0,
    failedCount: 0,
    deadLetteredCount,
    oldestReadyAt: null,
  };
}
