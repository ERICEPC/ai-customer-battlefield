import { fileURLToPath } from "node:url";
import {
  actionDecisionResponseSchema,
  actionProposalPageSchema,
  actionProposalRecordSchema,
  actionTransitionResponseSchema,
  battleAnalysisResultSchema,
  battleMapPageSchema,
  battleStateDetailSchema,
  businessActionPageSchema,
  businessActionRecordSchema,
  followupDraftResponseSchema,
} from "@battlefield/contracts";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  migrateDatabase,
} from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_ENTITY_ID,
  SYNTHETIC_OTHER_ENTITY_ID,
  SYNTHETIC_OTHER_TENANT_ID,
  SYNTHETIC_OTHER_USER_ID,
  SYNTHETIC_TENANT_ID,
  SYNTHETIC_USER_ID,
  seedSyntheticBusinessEntityDirectory,
} from "@battlefield/database/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AppModule } from "../src/app.module.js";
import { DATABASE_HANDLE } from "../src/database/database.module.js";
import { configureApp } from "../src/main.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations", import.meta.url),
);

describe("battle analysis and confirmed action API", () => {
  let app: INestApplication;
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeAll(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(database)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  test("moves a confirmed fact through analysis, map, proposal acceptance, and action transition", async () => {
    await createConfirmedBudgetFact(app);

    const analysis = battleAnalysisResultSchema.parse(
      (
        await actorRequest(app)
          .post(
            `/api/v1/business-entities/${SYNTHETIC_ENTITY_ID}/analysis-runs`,
          )
          .send({})
          .expect(201)
      ).body,
    );
    expect(analysis).toMatchObject({
      entityId: SYNTHETIC_ENTITY_ID,
      status: "completed",
      battleStateVersionNo: "1",
    });

    const detail = battleStateDetailSchema.parse(
      (
        await actorRequest(app)
          .get(`/api/v1/business-entities/${SYNTHETIC_ENTITY_ID}/battle-state`)
          .expect(200)
      ).body,
    );
    expect(detail.state).toMatchObject({
      battleStateVersionId: analysis.battleStateVersionId,
      dataSufficiency: "sufficient",
    });
    expect(detail.evidenceFacts).toHaveLength(1);
    expect(detail.signals).toHaveLength(1);

    const map = battleMapPageSchema.parse(
      (
        await actorRequest(app)
          .get(
            "/api/v1/battle-map?isT0=true&dataSufficiency=sufficient&limit=20",
          )
          .expect(200)
      ).body,
    );
    expect(map.items).toHaveLength(1);
    expect(map.items[0]).toMatchObject({
      entityId: SYNTHETIC_ENTITY_ID,
    });
    expect(map.items[0]?.state?.versionNo).toBe("1");

    const proposalPage = actionProposalPageSchema.parse(
      (
        await actorRequest(app)
          .get("/api/v1/action-proposals?status=pending_confirmation&limit=20")
          .expect(200)
      ).body,
    );
    const proposal = proposalPage.items[0];
    if (!proposal) throw new Error("Expected an action proposal.");
    expect(
      actionProposalRecordSchema.parse(
        (
          await actorRequest(app)
            .get(`/api/v1/action-proposals/${proposal.proposalId}`)
            .expect(200)
        ).body,
      ),
    ).toEqual(proposal);

    const stale = await actorRequest(app)
      .post(`/api/v1/action-proposals/${proposal.proposalId}/accept`)
      .set("idempotency-key", "accept-stale-proposal-e2e")
      .send({
        versionNo: "2",
        title: proposal.title,
        description: proposal.description,
        ownerUserId: SYNTHETIC_USER_ID,
        priority: "high",
        plannedAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(409);
    expect(stale.body).toMatchObject({
      code: "ACTION_PROPOSAL_VERSION_CONFLICT",
    });

    const plannedAt = new Date(Date.now() + 86_400_000).toISOString();
    const acceptRequest = () =>
      actorRequest(app)
        .post(`/api/v1/action-proposals/${proposal.proposalId}/accept`)
        .set("idempotency-key", "accept-proposal-e2e-001")
        .send({
          versionNo: "1",
          title: "提交正式解决方案",
          description: "包含安全方案与实施排期。",
          ownerUserId: SYNTHETIC_USER_ID,
          priority: "urgent",
          plannedAt,
        });
    const accepted = actionDecisionResponseSchema.parse(
      (await acceptRequest().expect(201)).body,
    );
    expect(
      actionDecisionResponseSchema.parse(
        (await acceptRequest().expect(201)).body,
      ),
    ).toEqual(accepted);
    if (accepted.status !== "accepted") {
      throw new Error("Expected accepted proposal receipt.");
    }

    const actionPage = businessActionPageSchema.parse(
      (
        await actorRequest(app)
          .get(
            `/api/v1/actions?ownerUserId=${SYNTHETIC_USER_ID}&status=planned`,
          )
          .expect(200)
      ).body,
    );
    expect(actionPage.items).toHaveLength(1);
    const action = businessActionRecordSchema.parse(
      (
        await actorRequest(app)
          .get(`/api/v1/actions/${accepted.actionId}`)
          .expect(200)
      ).body,
    );
    expect(action).toMatchObject({
      actionId: accepted.actionId,
      sourceProposalId: proposal.proposalId,
      status: "planned",
      versionNo: "1",
    });

    const transitioned = actionTransitionResponseSchema.parse(
      (
        await actorRequest(app)
          .post(`/api/v1/actions/${accepted.actionId}/transition`)
          .send({
            versionNo: "1",
            toStatus: "in_progress",
            reason: "开始准备材料",
          })
          .expect(201)
      ).body,
    );
    expect(transitioned).toMatchObject({
      actionId: accepted.actionId,
      status: "in_progress",
      versionNo: "2",
    });
  });

  test("rejects a separate proposal without creating another formal action", async () => {
    const analysis = battleAnalysisResultSchema.parse(
      (
        await actorRequest(app)
          .post(
            `/api/v1/business-entities/${SYNTHETIC_ENTITY_ID}/analysis-runs`,
          )
          .send({})
          .expect(201)
      ).body,
    );
    if (analysis.status !== "completed" || !analysis.proposalIds[0]) {
      throw new Error("Expected a second action proposal.");
    }
    const rejected = actionDecisionResponseSchema.parse(
      (
        await actorRequest(app)
          .post(`/api/v1/action-proposals/${analysis.proposalIds[0]}/reject`)
          .set("idempotency-key", "reject-proposal-e2e-001")
          .send({ versionNo: "1", reason: "当前时机不合适" })
          .expect(201)
      ).body,
    );
    expect(rejected).toMatchObject({ status: "rejected", actionId: null });
    const actions = businessActionPageSchema.parse(
      (await actorRequest(app).get("/api/v1/actions").expect(200)).body,
    );
    expect(actions.items).toHaveLength(1);
  });

  test("represents an entity without confirmed facts as insufficient data", async () => {
    const analysis = battleAnalysisResultSchema.parse(
      (
        await request(app.getHttpServer())
          .post(
            `/api/v1/business-entities/${SYNTHETIC_OTHER_ENTITY_ID}/analysis-runs`,
          )
          .set("x-tenant-id", SYNTHETIC_OTHER_TENANT_ID)
          .set("x-user-id", SYNTHETIC_OTHER_USER_ID)
          .send({})
          .expect(201)
      ).body,
    );
    expect(analysis).toMatchObject({ status: "completed", proposalIds: [] });
    const detail = battleStateDetailSchema.parse(
      (
        await request(app.getHttpServer())
          .get(
            `/api/v1/business-entities/${SYNTHETIC_OTHER_ENTITY_ID}/battle-state`,
          )
          .set("x-tenant-id", SYNTHETIC_OTHER_TENANT_ID)
          .set("x-user-id", SYNTHETIC_OTHER_USER_ID)
          .expect(200)
      ).body,
    );
    expect(detail).toMatchObject({
      state: {
        dataSufficiency: "insufficient",
        relationshipScore: null,
        potentialScore: null,
      },
      evidenceFacts: [],
      signals: [],
    });
  });

  test("maps malformed input, stale watermarks, missing actors, and tenant isolation", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/business-entities/${SYNTHETIC_ENTITY_ID}/battle-state`)
      .expect(401);
    await actorRequest(app)
      .get("/api/v1/action-proposals/not-a-uuid")
      .expect(400);
    await actorRequest(app)
      .get("/api/v1/battle-map?cursor=not-a-valid-cursor")
      .expect(400);
    await actorRequest(app)
      .get("/api/v1/actions?cursor=not-a-valid-cursor")
      .expect(400);
    const stale = await actorRequest(app)
      .post(`/api/v1/business-entities/${SYNTHETIC_ENTITY_ID}/analysis-runs`)
      .send({ expectedInputVersion: "f".repeat(64) })
      .expect(409);
    expect(stale.body).toMatchObject({ code: "ANALYSIS_INPUT_STALE" });
    await request(app.getHttpServer())
      .get(`/api/v1/business-entities/${SYNTHETIC_ENTITY_ID}/battle-state`)
      .set("x-tenant-id", SYNTHETIC_OTHER_TENANT_ID)
      .set("x-user-id", SYNTHETIC_OTHER_USER_ID)
      .expect(404);
  });
});

async function createConfirmedBudgetFact(app: INestApplication) {
  const created = followupDraftResponseSchema.parse(
    (
      await actorRequest(app)
        .post("/api/v1/followup-drafts")
        .send({
          entityId: SYNTHETIC_ENTITY_ID,
          rawInput: "客户确认预算",
          occurredAt: new Date(Date.now() - 60_000).toISOString(),
        })
        .expect(201)
    ).body,
  );
  const candidate = {
    ...created.candidate,
    facts: [{ factType: "budget_status", factValue: "预算已确认" }],
  };
  const revised = followupDraftResponseSchema.parse(
    (
      await actorRequest(app)
        .patch(`/api/v1/followup-drafts/${created.draftId}`)
        .send({ versionNo: "1", candidate })
        .expect(200)
    ).body,
  );
  await actorRequest(app)
    .post(`/api/v1/followup-drafts/${created.draftId}/confirm`)
    .set("idempotency-key", "confirm-battle-e2e-001")
    .send({ versionNo: revised.versionNo })
    .expect(201);
}

function actorRequest(app: INestApplication) {
  return {
    get: (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set("x-tenant-id", SYNTHETIC_TENANT_ID)
        .set("x-user-id", SYNTHETIC_USER_ID),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set("x-tenant-id", SYNTHETIC_TENANT_ID)
        .set("x-user-id", SYNTHETIC_USER_ID),
    patch: (path: string) =>
      request(app.getHttpServer())
        .patch(path)
        .set("x-tenant-id", SYNTHETIC_TENANT_ID)
        .set("x-user-id", SYNTHETIC_USER_ID),
  };
}
