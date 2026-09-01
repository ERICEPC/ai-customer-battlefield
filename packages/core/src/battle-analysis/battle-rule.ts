import type { ActorScope } from "../followup-drafts/followup-draft-agent.js";
import type {
  BattleDimension,
  BattleRiskLevel,
  SuggestedActionPriority,
} from "./battle-analysis-store.js";

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

export interface BattleRuleSet {
  minimumFactCount: number;
  relationshipScore: ScoreRule;
  potentialScore: ScoreRule;
  insufficientResult: {
    riskLevel: BattleRiskLevel;
    dataGap: string;
    summary: string;
  };
  sufficientResult: {
    quadrantCode: string;
    riskLevel: BattleRiskLevel;
    signalDimension: BattleDimension;
    signalStrength: number;
    summaryTemplate: string;
  };
  actionProposal: {
    title: string;
    description: string;
    priority: SuggestedActionPriority;
  };
  stageLabels: Record<string, string>;
}

export interface ScoreRule {
  base: number;
  perFact: number;
  maximum: number;
}

export interface ResolvedBattleRule {
  ruleVersion: string;
  rules: BattleRuleSet;
}

export interface BattleRuleResolver {
  resolve(input: { actor: ActorScope }): Promise<ResolvedBattleRule>;
}

export interface BattleRuleVersionRecord {
  versionId: string;
  versionNo: string;
  name: string;
  rules: BattleRuleSet;
  contentFingerprint: string;
  createdBy: string | null;
  createdAt: string;
}

export interface BattleRuleVersionPage {
  items: BattleRuleVersionRecord[];
  currentVersionId: string;
  currentReleaseNo: string;
  nextCursor: string | null;
}

export interface ReleasedBattleRule extends ResolvedBattleRule {
  versionId: string;
  versionNo: string;
  releaseNo: string;
  name: string;
  releasedAt: string;
}

export interface BattleRuleManager {
  listVersions(input: {
    actor: ActorScope;
    limit: number;
    cursor?: string;
  }): Promise<BattleRuleVersionPage>;
  createVersion(input: {
    actor: ActorScope;
    name: string;
    rules: BattleRuleSet;
  }): Promise<BattleRuleVersionRecord>;
  releaseVersion(input: {
    actor: ActorScope;
    versionId: string;
    reason: string;
  }): Promise<ReleasedBattleRule>;
}

export class InvalidBattleRuleSetError extends Error {
  constructor() {
    super("Battle rule set is invalid.");
    this.name = "InvalidBattleRuleSetError";
  }
}

export class BattleRuleAccessDeniedError extends Error {
  constructor() {
    super("Current actor cannot manage tenant battle rules.");
    this.name = "BattleRuleAccessDeniedError";
  }
}

export class BattleRuleVersionNotFoundError extends Error {
  constructor() {
    super("Battle rule version was not found.");
    this.name = "BattleRuleVersionNotFoundError";
  }
}

export class BattleRuleReleaseNotFoundError extends Error {
  constructor() {
    super("No released battle rule is available for the tenant.");
    this.name = "BattleRuleReleaseNotFoundError";
  }
}

export class InvalidBattleRuleManagementInputError extends Error {
  constructor() {
    super("Battle rule management input is invalid.");
    this.name = "InvalidBattleRuleManagementInputError";
  }
}

export class InvalidBattleRuleCursorError extends Error {
  constructor(options?: ErrorOptions) {
    super("Battle rule cursor is invalid.", options);
    this.name = "InvalidBattleRuleCursorError";
  }
}

export const defaultBattleRuleSet: BattleRuleSet = {
  minimumFactCount: 1,
  relationshipScore: { base: 60, perFact: 5, maximum: 90 },
  potentialScore: { base: 70, perFact: 5, maximum: 95 },
  insufficientResult: {
    riskLevel: "medium",
    dataGap: "缺少已确认的正式经营事实",
    summary: "当前正式事实不足，暂不生成精确作战坐标。",
  },
  sufficientResult: {
    quadrantCode: "high_relationship_high_potential",
    riskLevel: "low",
    signalDimension: "potential",
    signalStrength: 70,
    summaryTemplate: "已基于 {factCount} 条正式事实生成可回放的确定性分析。",
  },
  actionProposal: {
    title: "确认下一步客户经营动作",
    description: "结合最新正式事实，与客户确认负责人、时间和预期结果。",
    priority: "high",
  },
  stageLabels: {
    intent_communication: "意向沟通",
    opportunity_confirmed: "商机确认",
    needs_confirmed: "需求确认",
    solution_communication: "方案沟通",
    solution_validation: "方案验证",
    proposal: "方案与报价",
    commercial_negotiation: "商务谈判",
    contract_signing: "客户签约",
    won: "赢单",
  },
};

export class StaticBattleRuleResolver implements BattleRuleResolver {
  private readonly resolved: ResolvedBattleRule;

  constructor(input: ResolvedBattleRule) {
    if (!validVersion(input.ruleVersion)) {
      throw new InvalidBattleRuleSetError();
    }
    this.resolved = {
      ruleVersion: input.ruleVersion.trim(),
      rules: parseBattleRuleSet(input.rules),
    };
  }

  async resolve(): Promise<ResolvedBattleRule> {
    return this.resolved;
  }
}

export function parseBattleRuleSet(input: unknown): BattleRuleSet {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "minimumFactCount",
      "relationshipScore",
      "potentialScore",
      "insufficientResult",
      "sufficientResult",
      "actionProposal",
      "stageLabels",
    ])
  ) {
    throw new InvalidBattleRuleSetError();
  }
  const relationshipScore = parseScoreRule(input.relationshipScore);
  const potentialScore = parseScoreRule(input.potentialScore);
  const insufficientResult = input.insufficientResult;
  const sufficientResult = input.sufficientResult;
  const actionProposal = input.actionProposal;
  const stageLabels = input.stageLabels;
  if (
    !integerBetween(input.minimumFactCount, 1, 100) ||
    !isRecord(insufficientResult) ||
    !hasOnlyKeys(insufficientResult, ["riskLevel", "dataGap", "summary"]) ||
    !riskLevel(insufficientResult.riskLevel) ||
    !boundedText(insufficientResult.dataGap, 500) ||
    !boundedText(insufficientResult.summary, 5_000) ||
    !isRecord(sufficientResult) ||
    !hasOnlyKeys(sufficientResult, [
      "quadrantCode",
      "riskLevel",
      "signalDimension",
      "signalStrength",
      "summaryTemplate",
    ]) ||
    typeof sufficientResult.quadrantCode !== "string" ||
    !CODE_PATTERN.test(sufficientResult.quadrantCode) ||
    !riskLevel(sufficientResult.riskLevel) ||
    !dimension(sufficientResult.signalDimension) ||
    !integerBetween(sufficientResult.signalStrength, 0, 100) ||
    !boundedText(sufficientResult.summaryTemplate, 5_000) ||
    !isRecord(actionProposal) ||
    !hasOnlyKeys(actionProposal, ["title", "description", "priority"]) ||
    !boundedText(actionProposal.title, 300) ||
    !boundedText(actionProposal.description, 5_000) ||
    !priority(actionProposal.priority) ||
    !isRecord(stageLabels) ||
    Object.keys(stageLabels).length > 100
  ) {
    throw new InvalidBattleRuleSetError();
  }
  const normalizedStageLabels: Record<string, string> = {};
  for (const [code, label] of Object.entries(stageLabels)) {
    if (!CODE_PATTERN.test(code) || !boundedText(label, 200)) {
      throw new InvalidBattleRuleSetError();
    }
    normalizedStageLabels[code] = label.trim();
  }
  return {
    minimumFactCount: input.minimumFactCount,
    relationshipScore,
    potentialScore,
    insufficientResult: {
      riskLevel: insufficientResult.riskLevel,
      dataGap: insufficientResult.dataGap.trim(),
      summary: insufficientResult.summary.trim(),
    },
    sufficientResult: {
      quadrantCode: sufficientResult.quadrantCode,
      riskLevel: sufficientResult.riskLevel,
      signalDimension: sufficientResult.signalDimension,
      signalStrength: sufficientResult.signalStrength,
      summaryTemplate: sufficientResult.summaryTemplate.trim(),
    },
    actionProposal: {
      title: actionProposal.title.trim(),
      description: actionProposal.description.trim(),
      priority: actionProposal.priority,
    },
    stageLabels: normalizedStageLabels,
  };
}

function parseScoreRule(input: unknown): ScoreRule {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["base", "perFact", "maximum"]) ||
    !finiteBetween(input.base, 0, 100) ||
    !finiteBetween(input.perFact, 0, 100) ||
    !finiteBetween(input.maximum, 0, 100) ||
    input.base > input.maximum
  ) {
    throw new InvalidBattleRuleSetError();
  }
  return { base: input.base, perFact: input.perFact, maximum: input.maximum };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasOnlyKeys(input: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(input).length === keys.length &&
    keys.every((key) => Object.hasOwn(input, key)) &&
    Object.keys(input).every((key) => allowed.has(key))
  );
}

function finiteBetween(
  input: unknown,
  minimum: number,
  maximum: number,
): input is number {
  return (
    typeof input === "number" &&
    Number.isFinite(input) &&
    input >= minimum &&
    input <= maximum
  );
}

function integerBetween(
  input: unknown,
  minimum: number,
  maximum: number,
): input is number {
  return Number.isInteger(input) && finiteBetween(input, minimum, maximum);
}

function boundedText(input: unknown, maximum: number): input is string {
  return (
    typeof input === "string" &&
    input.trim().length >= 1 &&
    input.trim().length <= maximum
  );
}

function validVersion(input: unknown): input is string {
  return boundedText(input, 200);
}

function riskLevel(input: unknown): input is BattleRiskLevel {
  return ["low", "medium", "high", "critical"].includes(String(input));
}

function dimension(input: unknown): input is BattleDimension {
  return ["relationship", "potential", "risk", "stage"].includes(String(input));
}

function priority(input: unknown): input is SuggestedActionPriority {
  return ["low", "medium", "high", "urgent"].includes(String(input));
}
