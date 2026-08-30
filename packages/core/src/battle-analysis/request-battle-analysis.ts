import type {
  Clock,
  DraftIdGenerator,
} from "../followup-drafts/create-followup-draft.js";
import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type {
  BattleAnalysisCandidate,
  BattleAnalysisResult,
  BattleAnalysisStore,
  BattleAnalyzer,
  ConfirmedFactSnapshot,
  ConfirmedFactSnapshotReader,
} from "./battle-analysis-store.js";

const SCORE_PATTERN = /^(?:(?:0|[1-9]\d?)(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const BATTLE_DIMENSIONS = new Set<string>([
  "relationship",
  "potential",
  "risk",
  "stage",
]);
const SIGNAL_DIRECTIONS = new Set<string>(["positive", "negative", "neutral"]);
const RISK_LEVELS = new Set<string>(["low", "medium", "high", "critical"]);
const DATA_SUFFICIENCY = new Set<string>([
  "insufficient",
  "partial",
  "sufficient",
]);
const ACTION_PRIORITIES = new Set<string>(["low", "medium", "high", "urgent"]);

export class BattleAnalysisInputChangedError extends Error {
  constructor(readonly latestInputVersion: string) {
    super("Confirmed facts changed before analysis started.");
    this.name = "BattleAnalysisInputChangedError";
  }
}

export class InvalidBattleAnalysisCandidateError extends Error {
  constructor() {
    super("Battle analysis candidate is invalid or unexplainable.");
    this.name = "InvalidBattleAnalysisCandidateError";
  }
}

export class BattleAnalyzerExecutionError extends Error {
  constructor(options?: ErrorOptions) {
    super("Battle analyzer failed to produce a result.", options);
    this.name = "BattleAnalyzerExecutionError";
  }
}

export class RequestBattleAnalysis {
  constructor(
    private readonly dependencies: {
      reader: ConfirmedFactSnapshotReader;
      analyzer: BattleAnalyzer;
      store: BattleAnalysisStore;
      idGenerator: DraftIdGenerator;
      clock: Clock;
      ruleVersion: string;
      analyzerConfigVersion: string;
    },
  ) {}

  async execute(input: {
    actor: ActorScope;
    entityId: string;
    expectedInputVersion?: string;
  }): Promise<BattleAnalysisResult> {
    const snapshot = await this.dependencies.reader.read({
      actor: input.actor,
      entityId: input.entityId,
    });
    if (
      input.expectedInputVersion &&
      input.expectedInputVersion !== snapshot.inputVersion
    ) {
      throw new BattleAnalysisInputChangedError(snapshot.inputVersion);
    }

    const analysisRunId = this.dependencies.idGenerator.next();
    const startedAt = this.dependencies.clock.now().toISOString();
    await this.dependencies.store.start({
      actor: input.actor,
      analysisRunId,
      entityId: input.entityId,
      inputVersion: snapshot.inputVersion,
      ruleVersion: this.dependencies.ruleVersion,
      analyzerConfigVersion: this.dependencies.analyzerConfigVersion,
      startedAt,
    });

    let candidate: BattleAnalysisCandidate;
    try {
      const proposed = await this.dependencies.analyzer.analyze({
        actor: input.actor,
        snapshot,
        ruleVersion: this.dependencies.ruleVersion,
        analyzerConfigVersion: this.dependencies.analyzerConfigVersion,
      });
      candidate = normalizeCandidate(proposed, snapshot);
    } catch (error) {
      const invalid = error instanceof InvalidBattleAnalysisCandidateError;
      await this.dependencies.store.fail({
        actor: input.actor,
        analysisRunId,
        errorCode: invalid ? "INVALID_ANALYSIS_OUTPUT" : "ANALYZER_FAILED",
        finishedAt: this.dependencies.clock.now().toISOString(),
      });
      if (invalid) {
        throw error;
      }
      throw new BattleAnalyzerExecutionError({ cause: error });
    }

    return this.dependencies.store.complete({
      actor: input.actor,
      analysisRunId,
      inputVersion: snapshot.inputVersion,
      candidate,
      finishedAt: this.dependencies.clock.now().toISOString(),
    });
  }
}

function normalizeCandidate(
  input: BattleAnalysisCandidate,
  snapshot: ConfirmedFactSnapshot,
): BattleAnalysisCandidate {
  const evidenceFactIds = [...input.evidenceFactIds];
  const evidence = new Set(evidenceFactIds);
  const snapshotFacts = new Set(snapshot.facts.map((fact) => fact.factId));
  const summary = input.summary.trim();
  const dataGaps = input.dataGaps.map((gap) => gap.trim());
  const signals = input.signals.map((signal) => ({
    ...signal,
    reason: signal.reason.trim(),
  }));
  const actionProposals = input.actionProposals.map((proposal) => ({
    ...proposal,
    title: proposal.title.trim(),
    description: proposal.description.trim(),
  }));
  const sufficientCoordinates =
    input.relationshipScore !== null &&
    input.potentialScore !== null &&
    input.quadrantCode !== null;
  const validScores = [input.relationshipScore, input.potentialScore].every(
    (score) => score === null || SCORE_PATTERN.test(score),
  );

  if (
    !/^[a-f0-9]{64}$/.test(snapshot.inputVersion) ||
    summary.length === 0 ||
    summary.length > 5_000 ||
    !RISK_LEVELS.has(input.riskLevel) ||
    !DATA_SUFFICIENCY.has(input.dataSufficiency) ||
    !validScores ||
    (input.quadrantCode !== null && !CODE_PATTERN.test(input.quadrantCode)) ||
    new Set(evidenceFactIds).size !== evidenceFactIds.length ||
    evidenceFactIds.some((factId) => !snapshotFacts.has(factId)) ||
    signals.some(
      (signal) =>
        !evidence.has(signal.factId) ||
        !BATTLE_DIMENSIONS.has(signal.dimension) ||
        !SIGNAL_DIRECTIONS.has(signal.direction) ||
        !Number.isInteger(signal.strength) ||
        signal.strength < 0 ||
        signal.strength > 100 ||
        signal.reason.length === 0 ||
        signal.reason.length > 1_000,
    ) ||
    dataGaps.some((gap) => gap.length === 0 || gap.length > 500) ||
    actionProposals.some(
      (proposal) =>
        proposal.title.length === 0 ||
        proposal.title.length > 300 ||
        proposal.description.length === 0 ||
        proposal.description.length > 5_000 ||
        !ACTION_PRIORITIES.has(proposal.suggestedPriority) ||
        (proposal.suggestedPlannedAt !== null &&
          !Number.isFinite(Date.parse(proposal.suggestedPlannedAt))),
    ) ||
    (input.dataSufficiency === "sufficient" && !sufficientCoordinates) ||
    (input.dataSufficiency === "insufficient" &&
      (sufficientCoordinates ||
        input.relationshipScore !== null ||
        input.potentialScore !== null ||
        input.quadrantCode !== null ||
        dataGaps.length === 0))
  ) {
    throw new InvalidBattleAnalysisCandidateError();
  }

  return {
    ...input,
    summary,
    dataGaps,
    signals,
    evidenceFactIds,
    actionProposals,
  };
}
