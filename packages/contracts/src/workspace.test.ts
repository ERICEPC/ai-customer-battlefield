import { describe, expect, it } from "vitest";

import { workspaceSnapshotSchema } from "./workspace.js";

const actorId = "30000000-0000-4000-8000-000000000001";
const entityId = "50000000-0000-4000-8000-000000000001";
const actionId = "d0000000-0000-4000-8000-000000000001";
const currentStateId = "b0000000-0000-4000-8000-000000000002";
const previousStateId = "b0000000-0000-4000-8000-000000000001";

function validSnapshot() {
  return {
    generatedAt: "2026-08-31T04:00:00.000Z",
    scopeMode: "mixed" as const,
    kpis: {
      assignedEntityCount: 2,
      pendingDraftCount: 1,
      pendingProposalCount: 1,
      overdueActionCount: 1,
      unreadNotificationCount: 2,
      highRiskEntityCount: 1,
      dataIncompleteEntityCount: 1,
    },
    priorityActions: [
      {
        actionId,
        entityId,
        entityName: "Aurora Systems",
        title: "提交正式方案",
        ownerUserId: actorId,
        ownerName: "演示销售",
        priority: "high" as const,
        status: "planned" as const,
        plannedAt: "2026-08-31T03:00:00.000Z",
        isOverdue: true,
        deepLink: `/actions?actionId=${actionId}`,
      },
    ],
    recentBattleChanges: [
      {
        entityId,
        entityName: "Aurora Systems",
        isT0: true,
        battleStateVersionId: currentStateId,
        effectiveAt: "2026-08-31T03:30:00.000Z",
        relationshipScore: "72.50",
        potentialScore: "81.00",
        quadrantCode: "focus",
        riskLevel: "high" as const,
        dataSufficiency: "partial" as const,
        dataGaps: ["缺少采购时间表"],
        previousState: {
          battleStateVersionId: previousStateId,
          relationshipScore: "65.00",
          potentialScore: "80.00",
          quadrantCode: "develop",
        },
        relationshipDelta: 7.5,
        potentialDelta: 1,
        quadrantChanged: true,
        changeKind: "updated" as const,
        deepLink: `/battle-map?entityId=${entityId}&stateVersion=${currentStateId}`,
      },
    ],
    quadrantDistribution: [
      { quadrantCode: "focus", count: 1 },
      { quadrantCode: null, count: 1 },
    ],
  };
}

describe("workspace snapshot contract", () => {
  it("accepts one bounded, evidence-oriented role-scoped snapshot", () => {
    expect(workspaceSnapshotSchema.parse(validSnapshot())).toEqual(
      validSnapshot(),
    );
  });

  it("rejects unknown fields, invalid identifiers, and unbounded collections", () => {
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        tenantId: "10000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        priorityActions: [
          {
            ...validSnapshot().priorityActions[0],
            actionId: "not-a-uuid",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        recentBattleChanges: Array.from(
          { length: 6 },
          () => validSnapshot().recentBattleChanges[0],
        ),
      }).success,
    ).toBe(false);
  });

  it("keeps counts coherent with assigned scope and quadrant buckets", () => {
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        kpis: {
          ...validSnapshot().kpis,
          highRiskEntityCount: 3,
        },
      }).success,
    ).toBe(false);
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        quadrantDistribution: [{ quadrantCode: "focus", count: 1 }],
      }).success,
    ).toBe(false);
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        quadrantDistribution: [
          { quadrantCode: "focus", count: 1 },
          { quadrantCode: "focus", count: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires overdue flags to agree with the server snapshot time", () => {
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        priorityActions: [
          {
            ...validSnapshot().priorityActions[0],
            plannedAt: "2026-08-31T05:00:00.000Z",
            isOverdue: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        priorityActions: [
          {
            ...validSnapshot().priorityActions[0],
            plannedAt: "2026-08-31T03:00:00.000Z",
            isOverdue: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires new baselines to omit fabricated previous values and deltas", () => {
    const change = validSnapshot().recentBattleChanges[0];
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        recentBattleChanges: [
          {
            ...change,
            previousState: null,
            relationshipDelta: null,
            potentialDelta: null,
            quadrantChanged: false,
            changeKind: "new_baseline",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      workspaceSnapshotSchema.safeParse({
        ...validSnapshot(),
        recentBattleChanges: [
          {
            ...change,
            previousState: null,
            changeKind: "updated",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
