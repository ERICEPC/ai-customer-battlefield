import { describe, expect, it, vi } from "vitest";

import {
  MaterializePublishedWeeklyReportNotification,
  PublishedWeeklyReportNotFoundError,
  type WeeklyReportPublicationNotificationStore,
} from "./weekly-report-publication-notification.js";

const input = {
  actor: {
    tenantId: "10000000-0000-4000-8000-000000000001",
    userId: "30000000-0000-4000-8000-000000000001",
  },
  reportId: "91000000-0000-4000-8000-000000000001",
  reportVersionId: "92000000-0000-4000-8000-000000000001",
  recipientUserId: "30000000-0000-4000-8000-000000000001",
  reportType: "personal" as const,
  publishedAt: "2026-08-31T08:00:00.000Z",
};

describe("MaterializePublishedWeeklyReportNotification", () => {
  it("delegates a channel-neutral publication notification", async () => {
    const materialize = vi.fn().mockResolvedValue(true);
    const useCase = new MaterializePublishedWeeklyReportNotification({
      store: { materialize } satisfies WeeklyReportPublicationNotificationStore,
    });

    await expect(useCase.execute(input)).resolves.toEqual({
      status: "materialized",
    });
    expect(materialize).toHaveBeenCalledWith(input);
  });

  it("fails permanently when the published report or audience is absent", async () => {
    const store: WeeklyReportPublicationNotificationStore = {
      materialize: vi.fn().mockResolvedValue(false),
    };

    await expect(
      new MaterializePublishedWeeklyReportNotification({ store }).execute(
        input,
      ),
    ).rejects.toBeInstanceOf(PublishedWeeklyReportNotFoundError);
  });
});
