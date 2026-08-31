import { z } from "zod";

const boundedCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scoreSchema = z
  .string()
  .regex(/^(?:(?:0|[1-9]\d?)(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/);
const codeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,99}$/);
const scoreDeltaSchema = z.number().min(-100).max(100);
const actionDeepLinkSchema = z
  .string()
  .max(2_000)
  .regex(
    /^\/actions\?actionId=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const battleDeepLinkSchema = z
  .string()
  .max(2_000)
  .regex(
    /^\/battle-map\?entityId=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}&stateVersion=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

export const workspaceScopeModeSchema = z.enum([
  "personal",
  "observed_portfolio",
  "mixed",
]);

export const workspaceKpisSchema = z.strictObject({
  assignedEntityCount: boundedCountSchema,
  pendingDraftCount: boundedCountSchema,
  pendingProposalCount: boundedCountSchema,
  overdueActionCount: boundedCountSchema,
  unreadNotificationCount: boundedCountSchema,
  highRiskEntityCount: boundedCountSchema,
  dataIncompleteEntityCount: boundedCountSchema,
});

export const workspacePriorityActionSchema = z.strictObject({
  actionId: z.uuid(),
  entityId: z.uuid(),
  entityName: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  ownerUserId: z.uuid(),
  ownerName: z.string().trim().min(1).max(200),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  status: z.enum(["planned", "in_progress"]),
  plannedAt: z.iso.datetime(),
  isOverdue: z.boolean(),
  deepLink: actionDeepLinkSchema,
});

export const workspacePreviousBattleStateSchema = z.strictObject({
  battleStateVersionId: z.uuid(),
  relationshipScore: scoreSchema.nullable(),
  potentialScore: scoreSchema.nullable(),
  quadrantCode: codeSchema.nullable(),
});

export const workspaceBattleChangeSchema = z
  .strictObject({
    entityId: z.uuid(),
    entityName: z.string().trim().min(1).max(300),
    isT0: z.boolean(),
    battleStateVersionId: z.uuid(),
    effectiveAt: z.iso.datetime(),
    relationshipScore: scoreSchema.nullable(),
    potentialScore: scoreSchema.nullable(),
    quadrantCode: codeSchema.nullable(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    dataSufficiency: z.enum(["insufficient", "partial", "sufficient"]),
    dataGaps: z.array(z.string().trim().min(1).max(500)).max(20),
    previousState: workspacePreviousBattleStateSchema.nullable(),
    relationshipDelta: scoreDeltaSchema.nullable(),
    potentialDelta: scoreDeltaSchema.nullable(),
    quadrantChanged: z.boolean(),
    changeKind: z.enum(["new_baseline", "updated"]),
    deepLink: battleDeepLinkSchema,
  })
  .superRefine((change, context) => {
    const expectedLink = `/battle-map?entityId=${change.entityId}&stateVersion=${change.battleStateVersionId}`;
    if (change.deepLink !== expectedLink) {
      context.addIssue({
        code: "custom",
        path: ["deepLink"],
        message: "The battle-map link must reference this exact state.",
      });
    }

    if (change.changeKind === "new_baseline") {
      if (
        change.previousState !== null ||
        change.relationshipDelta !== null ||
        change.potentialDelta !== null ||
        change.quadrantChanged
      ) {
        context.addIssue({
          code: "custom",
          path: ["changeKind"],
          message: "A new baseline cannot contain fabricated previous values.",
        });
      }
      return;
    }

    if (!change.previousState) {
      context.addIssue({
        code: "custom",
        path: ["previousState"],
        message: "An updated state requires its immediately previous version.",
      });
      return;
    }
    if (
      change.previousState.battleStateVersionId === change.battleStateVersionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousState", "battleStateVersionId"],
        message: "Current and previous state identifiers must differ.",
      });
    }
    const hasRelationshipPair =
      change.relationshipScore !== null &&
      change.previousState.relationshipScore !== null;
    if (hasRelationshipPair !== (change.relationshipDelta !== null)) {
      context.addIssue({
        code: "custom",
        path: ["relationshipDelta"],
        message: "A relationship delta requires both score values.",
      });
    }
    const hasPotentialPair =
      change.potentialScore !== null &&
      change.previousState.potentialScore !== null;
    if (hasPotentialPair !== (change.potentialDelta !== null)) {
      context.addIssue({
        code: "custom",
        path: ["potentialDelta"],
        message: "A potential delta requires both score values.",
      });
    }
    if (
      change.quadrantChanged !==
      (change.quadrantCode !== change.previousState.quadrantCode)
    ) {
      context.addIssue({
        code: "custom",
        path: ["quadrantChanged"],
        message: "The quadrant change flag must match the two versions.",
      });
    }
  });

export const workspaceQuadrantBucketSchema = z.strictObject({
  quadrantCode: codeSchema.nullable(),
  count: boundedCountSchema,
});

export const workspaceSnapshotSchema = z
  .strictObject({
    generatedAt: z.iso.datetime(),
    scopeMode: workspaceScopeModeSchema,
    kpis: workspaceKpisSchema,
    priorityActions: z.array(workspacePriorityActionSchema).max(5),
    recentBattleChanges: z.array(workspaceBattleChangeSchema).max(5),
    quadrantDistribution: z.array(workspaceQuadrantBucketSchema).max(101),
  })
  .superRefine((snapshot, context) => {
    if (
      snapshot.kpis.highRiskEntityCount > snapshot.kpis.assignedEntityCount ||
      snapshot.kpis.dataIncompleteEntityCount >
        snapshot.kpis.assignedEntityCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["kpis"],
        message: "Entity subset counts cannot exceed assigned scope.",
      });
    }

    const quadrantKeys = snapshot.quadrantDistribution.map(
      (bucket) => bucket.quadrantCode ?? "__unpositioned__",
    );
    if (new Set(quadrantKeys).size !== quadrantKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["quadrantDistribution"],
        message: "Each quadrant may appear at most once.",
      });
    }
    const distributedEntityCount = snapshot.quadrantDistribution.reduce(
      (total, bucket) => total + bucket.count,
      0,
    );
    if (distributedEntityCount !== snapshot.kpis.assignedEntityCount) {
      context.addIssue({
        code: "custom",
        path: ["quadrantDistribution"],
        message: "Quadrant buckets must cover the complete assigned scope.",
      });
    }

    const generatedAt = Date.parse(snapshot.generatedAt);
    for (const [index, action] of snapshot.priorityActions.entries()) {
      const expectedLink = `/actions?actionId=${action.actionId}`;
      if (action.deepLink !== expectedLink) {
        context.addIssue({
          code: "custom",
          path: ["priorityActions", index, "deepLink"],
          message: "The action link must reference this exact action.",
        });
      }
      const expectedOverdue = Date.parse(action.plannedAt) <= generatedAt;
      if (action.isOverdue !== expectedOverdue) {
        context.addIssue({
          code: "custom",
          path: ["priorityActions", index, "isOverdue"],
          message: "The overdue flag must use the snapshot server time.",
        });
      }
    }

    if (
      new Set(snapshot.priorityActions.map((action) => action.actionId))
        .size !== snapshot.priorityActions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["priorityActions"],
        message: "Priority actions must be unique.",
      });
    }
    if (
      new Set(
        snapshot.recentBattleChanges.map(
          (change) => change.battleStateVersionId,
        ),
      ).size !== snapshot.recentBattleChanges.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["recentBattleChanges"],
        message: "Battle changes must be unique.",
      });
    }
  });

export type WorkspaceScopeMode = z.infer<typeof workspaceScopeModeSchema>;
export type WorkspaceKpis = z.infer<typeof workspaceKpisSchema>;
export type WorkspacePriorityAction = z.infer<
  typeof workspacePriorityActionSchema
>;
export type WorkspaceBattleChange = z.infer<typeof workspaceBattleChangeSchema>;
export type WorkspaceQuadrantBucket = z.infer<
  typeof workspaceQuadrantBucketSchema
>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
