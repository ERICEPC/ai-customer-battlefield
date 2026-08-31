import { describe, expect, test, vi } from "vitest";

import {
  InvalidAsyncWorkListInputError,
  InvalidAsyncWorkReplayInputError,
  ListAsyncWorkFailures,
  ReplayAsyncWorkItem,
  type WorkerOperationsRepository,
} from "./manage-worker-operations.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000072",
};

describe("worker operations use cases", () => {
  test("passes only authenticated actor scope into failure queries", async () => {
    const repository = repositoryStub();
    const subject = new ListAsyncWorkFailures(repository);
    await subject.execute({
      actor,
      limit: 25,
      kind: "outbox",
      status: "dead_lettered",
    });
    expect(repository.listFailures).toHaveBeenCalledWith({
      actor,
      limit: 25,
      kind: "outbox",
      status: "dead_lettered",
    });
  });

  test("rejects invalid list bounds before touching persistence", async () => {
    const repository = repositoryStub();
    expect(() =>
      new ListAsyncWorkFailures(repository).execute({ actor, limit: 0 }),
    ).toThrow(InvalidAsyncWorkListInputError);
    expect(repository.listFailures).not.toHaveBeenCalled();
  });

  test("requires a safe idempotency key, UUID and explicit replay reason", async () => {
    const repository = repositoryStub();
    const subject = new ReplayAsyncWorkItem(repository);
    expect(() =>
      subject.execute({
        actor,
        kind: "outbox",
        workItemId: "not-a-uuid",
        reason: "处理器已修复",
        idempotencyKey: "replay-1",
      }),
    ).toThrow(InvalidAsyncWorkReplayInputError);
    expect(() =>
      subject.execute({
        actor,
        kind: "outbox",
        workItemId: "d1000000-0000-4000-8000-000000000001",
        reason: " ",
        idempotencyKey: "unsafe key",
      }),
    ).toThrow(InvalidAsyncWorkReplayInputError);
    expect(repository.replay).not.toHaveBeenCalled();
  });
});

function repositoryStub(): WorkerOperationsRepository {
  return {
    getHealth: vi.fn().mockResolvedValue({}),
    listFailures: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    replay: vi.fn().mockResolvedValue({}),
  } as unknown as WorkerOperationsRepository;
}
