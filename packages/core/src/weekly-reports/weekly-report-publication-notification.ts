import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type { WeeklyReportType } from "./weekly-report-repository.js";

export interface WeeklyReportPublicationNotificationInput {
  actor: ActorScope;
  reportId: string;
  reportVersionId: string;
  recipientUserId: string;
  reportType: WeeklyReportType;
  publishedAt: string;
}

export interface WeeklyReportPublicationNotificationStore {
  materialize(
    input: WeeklyReportPublicationNotificationInput,
  ): Promise<boolean>;
}

export class MaterializePublishedWeeklyReportNotification {
  constructor(
    private readonly dependencies: {
      store: WeeklyReportPublicationNotificationStore;
    },
  ) {}

  async execute(
    input: WeeklyReportPublicationNotificationInput,
  ): Promise<{ status: "materialized" }> {
    if (!(await this.dependencies.store.materialize(input))) {
      throw new PublishedWeeklyReportNotFoundError();
    }
    return { status: "materialized" };
  }
}

export class PublishedWeeklyReportNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The published weekly report or its recipient was not found.",
      options,
    );
    this.name = "PublishedWeeklyReportNotFoundError";
  }
}
