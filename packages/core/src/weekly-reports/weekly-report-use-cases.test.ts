import { describe, expect, it, vi } from "vitest";

import type {
  WeeklyReportDetail,
  WeeklyReportRepository,
} from "./weekly-report-repository.js";
import {
  GenerateWeeklyReport,
  InvalidWeeklyReportClockError,
  InvalidWeeklyReportListLimitError,
  InvalidWeeklyReportPeriodError,
  ListWeeklyReports,
  PublishWeeklyReport,
  ReviewWeeklyReport,
  ReviseWeeklyReport,
} from "./weekly-report-use-cases.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000001",
};
const versionId = "92000000-0000-4000-8000-000000000001";

const detail: WeeklyReportDetail = {
  reportId: "91000000-0000-4000-8000-000000000001",
  versionId,
  reportType: "personal",
  revisionNo: 1,
  lockVersion: 1,
  status: "in_review",
  title: "个人周报",
  note: "",
  period: {
    start: "2026-08-24T00:00:00.000Z",
    end: "2026-08-31T00:00:00.000Z",
  },
  dataCutoffAt: "2026-08-31T00:00:00.000Z",
  scope: { label: "本人责任范围", entityCount: 0, contributorCount: 1 },
  metrics: {
    confirmedFollowupCount: 0,
    validFactCount: 0,
    stageChangeCount: 0,
    completedActionCount: 0,
    openActionCount: 0,
    overdueActionCount: 0,
  },
  generator: { kind: "deterministic", version: "weekly-progress-v1" },
  sections: [
    { kind: "progress", items: [] },
    { kind: "risk", items: [] },
    { kind: "next_action", items: [] },
    { kind: "data_gap", items: [] },
  ],
  previousVersionId: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  publishedAt: null,
  capabilities: { canReview: true, canPublish: true, canRevise: false },
};

class RecordingClock {
  calls = 0;

  constructor(private readonly value: Date) {}

  now(): Date {
    this.calls += 1;
    return this.value;
  }
}

function repository(): WeeklyReportRepository {
  return {
    generate: vi.fn().mockResolvedValue(detail),
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    get: vi.fn().mockResolvedValue(detail),
    review: vi.fn().mockResolvedValue(detail),
    publish: vi.fn().mockResolvedValue(detail),
    revise: vi.fn().mockResolvedValue(detail),
  };
}

describe("GenerateWeeklyReport", () => {
  it("captures the clock once and delegates a personal snapshot without a model", async () => {
    const repo = repository();
    const clock = new RecordingClock(new Date("2026-08-31T02:00:00.000Z"));
    const useCase = new GenerateWeeklyReport({ repository: repo, clock });

    await expect(
      useCase.execute({
        actor,
        idempotencyKey: "weekly-report-1",
        reportType: "personal",
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
      }),
    ).resolves.toEqual(detail);
    expect(repo.generate).toHaveBeenCalledWith({
      actor,
      idempotencyKey: "weekly-report-1",
      reportType: "personal",
      periodStart: "2026-08-24T00:00:00.000Z",
      periodEnd: "2026-08-31T00:00:00.000Z",
      generatedAt: "2026-08-31T02:00:00.000Z",
      dataCutoffAt: "2026-08-31T00:00:00.000Z",
    });
    expect(clock.calls).toBe(1);
  });

  it("rejects invalid/future periods and invalid clocks before persistence", async () => {
    for (const [periodStart, periodEnd] of [
      ["2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
      ["2026-09-01T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
      ["2026-07-01T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
      ["2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z"],
    ]) {
      const repo = repository();
      const useCase = new GenerateWeeklyReport({
        repository: repo,
        clock: new RecordingClock(new Date("2026-08-31T02:00:00.000Z")),
      });
      await expect(
        useCase.execute({
          actor,
          idempotencyKey: "weekly-report-invalid",
          reportType: "personal",
          periodStart,
          periodEnd,
        }),
      ).rejects.toBeInstanceOf(InvalidWeeklyReportPeriodError);
      expect(repo.generate).not.toHaveBeenCalled();
    }

    const repo = repository();
    await expect(
      new GenerateWeeklyReport({
        repository: repo,
        clock: new RecordingClock(new Date(Number.NaN)),
      }).execute({
        actor,
        idempotencyKey: "weekly-report-invalid-clock",
        reportType: "personal",
        periodStart: "2026-08-24T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(InvalidWeeklyReportClockError);
    expect(repo.generate).not.toHaveBeenCalled();
  });
});

describe("weekly-report lifecycle use cases", () => {
  it("delegates bounded list, review, publish and revision commands exactly", async () => {
    const repo = repository();
    await new ListWeeklyReports({ repository: repo }).execute({
      actor,
      reportType: "personal",
      cursor: "next",
      limit: 20,
    });
    await new ReviewWeeklyReport({ repository: repo }).execute({
      actor,
      versionId,
      lockVersion: 1,
      note: "保留风险说明。",
      items: [
        {
          itemId: "93000000-0000-4000-8000-000000000001",
          included: false,
        },
      ],
    });
    await new PublishWeeklyReport({ repository: repo }).execute({
      actor,
      versionId,
      lockVersion: 2,
      idempotencyKey: "publish-report-1",
    });
    await new ReviseWeeklyReport({ repository: repo }).execute({
      actor,
      versionId,
      lockVersion: 2,
      idempotencyKey: "revise-report-1",
    });

    expect(repo.list).toHaveBeenCalledWith({
      actor,
      reportType: "personal",
      cursor: "next",
      limit: 20,
    });
    expect(repo.review).toHaveBeenCalledWith({
      actor,
      versionId,
      lockVersion: 1,
      note: "保留风险说明。",
      items: [
        {
          itemId: "93000000-0000-4000-8000-000000000001",
          included: false,
        },
      ],
    });
    expect(repo.publish).toHaveBeenCalledWith({
      actor,
      versionId,
      lockVersion: 2,
      idempotencyKey: "publish-report-1",
    });
    expect(repo.revise).toHaveBeenCalledWith({
      actor,
      versionId,
      lockVersion: 2,
      idempotencyKey: "revise-report-1",
    });
  });

  it("rejects invalid list limits before persistence", async () => {
    for (const limit of [0, 101, 1.5]) {
      const repo = repository();
      await expect(
        new ListWeeklyReports({ repository: repo }).execute({ actor, limit }),
      ).rejects.toBeInstanceOf(InvalidWeeklyReportListLimitError);
      expect(repo.list).not.toHaveBeenCalled();
    }
  });
});
