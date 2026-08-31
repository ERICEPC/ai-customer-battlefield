import type { Clock } from "../followup-drafts/create-followup-draft.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type { WorkspaceReader, WorkspaceSnapshot } from "./workspace-reader.js";

export class InvalidWorkspaceClockError extends Error {
  constructor() {
    super("The workspace clock returned an invalid instant.");
    this.name = "InvalidWorkspaceClockError";
  }
}

export class GetWorkspaceSnapshot {
  constructor(
    private readonly dependencies: {
      reader: WorkspaceReader;
      clock: Clock;
    },
  ) {}

  async execute(input: { actor: ActorScope }): Promise<WorkspaceSnapshot> {
    const now = this.dependencies.clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new InvalidWorkspaceClockError();
    }
    const generatedAt = now.toISOString();
    const projection = await this.dependencies.reader.read({
      actor: input.actor,
      now: generatedAt,
    });
    return {
      generatedAt,
      ...projection,
    };
  }
}
