import type { BattleAnalysisResult } from "../battle-analysis/battle-analysis-store.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";

export interface ConfirmedFollowupProgressNotificationStore {
  materializeFollowupProgress(input: {
    actor: ActorScope;
    eventId: string;
    followupId: string;
    draftId: string;
    entityId: string;
    battleStateVersionId: string;
    createdAt: string;
  }): Promise<boolean>;
}

export class ProcessConfirmedFollowup {
  constructor(
    private readonly dependencies: {
      analysis: {
        execute(input: {
          actor: ActorScope;
          entityId: string;
          triggerEventId: string;
        }): Promise<BattleAnalysisResult>;
      };
      notificationStore: ConfirmedFollowupProgressNotificationStore;
    },
  ) {}

  async execute(input: {
    actor: ActorScope;
    eventId: string;
    followupId: string;
    draftId: string;
    entityId: string;
    confirmedAt: string;
  }): Promise<{ status: "completed" | "superseded" }> {
    const analysis = await this.dependencies.analysis.execute({
      actor: input.actor,
      entityId: input.entityId,
      triggerEventId: input.eventId,
    });
    if (analysis.status === "superseded") {
      return { status: "superseded" };
    }
    const materialized =
      await this.dependencies.notificationStore.materializeFollowupProgress({
        actor: input.actor,
        eventId: input.eventId,
        followupId: input.followupId,
        draftId: input.draftId,
        entityId: input.entityId,
        battleStateVersionId: analysis.battleStateVersionId,
        createdAt: input.confirmedAt,
      });
    if (!materialized) {
      throw new ConfirmedFollowupAutomationNotFoundError();
    }
    return { status: "completed" };
  }
}

export class ConfirmedFollowupAutomationNotFoundError extends Error {
  constructor() {
    super(
      "The confirmed follow-up or its current department leader was not found.",
    );
    this.name = "ConfirmedFollowupAutomationNotFoundError";
  }
}
