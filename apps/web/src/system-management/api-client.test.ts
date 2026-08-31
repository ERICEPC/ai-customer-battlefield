import type {
  AiRuntimeConfigVersionPage,
  AsyncWorkReplayResponse,
} from "@battlefield/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createAiRuntimeConfigVersion,
  listAiRuntimeConfigVersions,
  releaseAiRuntimeConfigVersion,
  replayAsyncWorkItem,
  SystemManagementApiError,
} from "./api-client";

const VERSION_ID = "f2243ec1-f995-4c58-8ced-984e1c1d86eb";
const WORK_ITEM_ID = "d1000000-0000-4000-8000-000000000001";
const versionPage: AiRuntimeConfigVersionPage = {
  items: [],
  currentVersionId: null,
  nextCursor: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("system-management API client", () => {
  test("uses strict configuration endpoints and request bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(versionPage))
      .mockResolvedValueOnce(
        response({
          versionId: VERSION_ID,
          configKey: "followup_extraction",
          versionNo: "2",
          name: "销售跟进拆解 V2",
          provider: "senseaudio",
          defaultModelId: "senseaudio-s2-flash",
          systemPrompt: "只返回严格 JSON。",
          parameters: { temperature: 0.1, maxTokens: 1200 },
          contentFingerprint: "a".repeat(64),
          createdBy: "30000000-0000-4000-8000-000000000072",
          createdAt: "2026-09-01T05:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        response({
          configId: VERSION_ID,
          configKey: "followup_extraction",
          versionNo: "2",
          releaseNo: "2",
          name: "销售跟进拆解 V2",
          provider: "senseaudio",
          defaultModelId: "senseaudio-s2-flash",
          systemPrompt: "只返回严格 JSON。",
          parameters: { temperature: 0.1, maxTokens: 1200 },
          releasedAt: "2026-09-01T05:30:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await listAiRuntimeConfigVersions();
    await createAiRuntimeConfigVersion({
      name: "销售跟进拆解 V2",
      defaultModelId: "senseaudio-s2-flash",
      systemPrompt: "只返回严格 JSON。",
      parameters: { temperature: 0.1, maxTokens: 1200 },
    });
    await releaseAiRuntimeConfigVersion(VERSION_ID, "严格契约已验收");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/api/v1/ai-runtime-configs/followup_extraction/versions?limit=100",
      "http://localhost:3001/api/v1/ai-runtime-configs/followup_extraction/versions",
      "http://localhost:3001/api/v1/ai-runtime-configs/followup_extraction/releases",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          versionId: VERSION_ID,
          reason: "严格契约已验收",
        }),
      }),
    );
  });

  test("requires an idempotency key for worker replay", async () => {
    const replay: AsyncWorkReplayResponse = {
      replayId: "d5000000-0000-4000-8000-000000000001",
      kind: "outbox",
      workItemId: WORK_ITEM_ID,
      status: "queued",
      replayedAt: "2026-09-01T06:01:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(response(replay));
    vi.stubGlobal("fetch", fetchMock);

    await replayAsyncWorkItem(
      "outbox",
      WORK_ITEM_ID,
      "处理器已修复",
      "worker-replay-1",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3001/api/v1/worker-operations/outbox/${WORK_ITEM_ID}/replay`,
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          "Idempotency-Key": "worker-replay-1",
        }),
      }),
    );
  });

  test("preserves stable server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            code: "CAPABILITY_FORBIDDEN",
            message: "当前账号未获得该管理能力。",
            requestId: "request-worker-1",
          },
          403,
        ),
      ),
    );

    const error = await listAiRuntimeConfigVersions().catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SystemManagementApiError);
    expect(error).toMatchObject({
      status: 403,
      code: "CAPABILITY_FORBIDDEN",
      requestId: "request-worker-1",
    });
  });
});

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
