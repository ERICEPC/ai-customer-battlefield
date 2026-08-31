import { describe, expect, it, vi } from "vitest";
import type {
  ManagementQueryRepository,
  ManagementQueryResult,
} from "./management-query-repository.js";
import {
  InvalidManagementQueryClockError,
  InvalidManagementQueryPeriodError,
  InvalidManagementQuerySubjectLimitError,
  ListManagementQuerySubjects,
  RunManagementQuery,
} from "./run-management-query.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000072",
};
const subjectUserId = "30000000-0000-4000-8000-000000000001";

class RecordingClock {
  calls = 0;

  constructor(private readonly value: Date) {}

  now(): Date {
    this.calls += 1;
    return this.value;
  }
}

const result: ManagementQueryResult = {
  queryId: "90000000-0000-4000-8000-000000000081",
  capability: "sales_weekly_progress",
  subject: { userId: subjectUserId, displayName: "销售甲" },
  period: {
    start: "2026-08-24T00:00:00.000Z",
    end: "2026-08-31T23:59:59.999Z",
  },
  dataCutoffAt: "2026-08-31T04:00:00.000Z",
  scope: { kind: "observed_portfolio", entityCount: 0 },
  metrics: {
    confirmedFollowupCount: 0,
    validFactCount: 0,
    stageChangeCount: 0,
    completedActionCount: 0,
    openActionCount: 0,
    overdueActionCount: 0,
  },
  highlights: [],
  dataGaps: [],
};

function repository(): ManagementQueryRepository {
  return {
    listSubjects: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    runSalesWeeklyProgress: vi.fn().mockResolvedValue(result),
  };
}

describe("RunManagementQuery", () => {
  it("delegates the strict capability and actor scope without a model runtime", async () => {
    const repo = repository();
    const clock = new RecordingClock(new Date("2026-08-31T04:00:00.000Z"));
    const useCase = new RunManagementQuery({ repository: repo, clock });

    await expect(
      useCase.execute({
        actor,
        idempotencyKey: "management-query-core-1",
        capability: "sales_weekly_progress",
        subjectUserId,
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.999Z",
      }),
    ).resolves.toEqual(result);
    expect(repo.runSalesWeeklyProgress).toHaveBeenCalledWith({
      actor,
      idempotencyKey: "management-query-core-1",
      subjectUserId,
      periodStart: "2026-08-24T00:00:00.000Z",
      periodEnd: "2026-08-31T23:59:59.999Z",
      queryNow: "2026-08-31T04:00:00.000Z",
      dataCutoffAt: "2026-08-31T04:00:00.000Z",
    });
    expect(clock.calls).toBe(1);
  });

  it("rejects reversed, zero and over-31-day ranges before repository access", async () => {
    const invalidPeriods: Array<[string, string]> = [
      ["2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
      ["2026-09-01T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
      ["2026-07-01T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
    ];
    for (const [periodStart, periodEnd] of invalidPeriods) {
      const repo = repository();
      const clock = new RecordingClock(new Date("2026-08-31T04:00:00.000Z"));
      const useCase = new RunManagementQuery({ repository: repo, clock });
      await expect(
        useCase.execute({
          actor,
          idempotencyKey: "management-query-invalid-period",
          capability: "sales_weekly_progress",
          subjectUserId,
          periodStart,
          periodEnd,
        }),
      ).rejects.toBeInstanceOf(InvalidManagementQueryPeriodError);
      expect(repo.runSalesWeeklyProgress).not.toHaveBeenCalled();
      expect(clock.calls).toBe(0);
    }
  });

  it("rejects an invalid server clock before repository access", async () => {
    const repo = repository();
    const useCase = new RunManagementQuery({
      repository: repo,
      clock: new RecordingClock(new Date(Number.NaN)),
    });

    await expect(
      useCase.execute({
        actor,
        idempotencyKey: "management-query-invalid-clock",
        capability: "sales_weekly_progress",
        subjectUserId,
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.999Z",
      }),
    ).rejects.toBeInstanceOf(InvalidManagementQueryClockError);
    expect(repo.runSalesWeeklyProgress).not.toHaveBeenCalled();
  });
});

describe("ListManagementQuerySubjects", () => {
  it("delegates the actor, cursor and bounded limit", async () => {
    const repo = repository();
    const useCase = new ListManagementQuerySubjects({ repository: repo });

    await useCase.execute({ actor, cursor: "next-page", limit: 25 });

    expect(repo.listSubjects).toHaveBeenCalledWith({
      actor,
      cursor: "next-page",
      limit: 25,
    });
  });

  it("rejects invalid limits before repository access", async () => {
    for (const limit of [0, 101, 1.5]) {
      const repo = repository();
      const useCase = new ListManagementQuerySubjects({ repository: repo });

      await expect(useCase.execute({ actor, limit })).rejects.toBeInstanceOf(
        InvalidManagementQuerySubjectLimitError,
      );
      expect(repo.listSubjects).not.toHaveBeenCalled();
    }
  });
});
