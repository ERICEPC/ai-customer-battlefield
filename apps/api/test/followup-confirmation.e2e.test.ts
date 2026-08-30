import { fileURLToPath } from "node:url";
import {
  followupApiErrorSchema,
  followupConfirmationResponseSchema,
  followupDraftResponseSchema,
  formalFollowupRecordSchema,
} from "@battlefield/contracts";
import {
  type BattlefieldDatabase,
  type DatabaseHandle,
  migrateDatabase,
} from "@battlefield/database";
import {
  createPgliteDatabase,
  SYNTHETIC_ENTITY_ID,
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

describe("persistent follow-up confirmation API", () => {
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

  test("creates, reads, revises, confirms idempotently, and retrieves the formal record", async () => {
    const occurredAt = new Date(Date.now() - 60_000).toISOString();
    const createResponse = await actorRequest(app)
      .post("/api/v1/followup-drafts")
      .send({
        entityId: SYNTHETIC_ENTITY_ID,
        rawInput: "客户确认预算，要求下周提交方案",
        occurredAt,
      })
      .expect(201);
    const created = followupDraftResponseSchema.parse(createResponse.body);
    expect(created).toMatchObject({
      status: "pending_confirmation",
      versionNo: "1",
      candidate: { entityId: SYNTHETIC_ENTITY_ID },
    });

    const getResponse = await actorRequest(app)
      .get(`/api/v1/followup-drafts/${created.draftId}`)
      .expect(200);
    expect(followupDraftResponseSchema.parse(getResponse.body)).toEqual(
      created,
    );

    const revisedCandidate = {
      ...created.candidate,
      summary: "客户确认预算；销售需在下周提交方案",
      followupType: "meeting" as const,
      facts: [{ factType: "budget_status", factValue: "预算已确认" }],
    };
    const reviseResponse = await actorRequest(app)
      .patch(`/api/v1/followup-drafts/${created.draftId}`)
      .send({ versionNo: "1", candidate: revisedCandidate })
      .expect(200);
    const revised = followupDraftResponseSchema.parse(reviseResponse.body);
    expect(revised).toMatchObject({
      versionNo: "2",
      candidate: revisedCandidate,
    });

    const staleResponse = await actorRequest(app)
      .post(`/api/v1/followup-drafts/${created.draftId}/confirm`)
      .set("idempotency-key", "confirm-stale-draft")
      .send({ versionNo: "1" })
      .expect(409);
    expect(followupApiErrorSchema.parse(staleResponse.body)).toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      issues: [{ path: "versionNo", reason: "expected 2, received 1" }],
    });

    await actorRequest(app)
      .post(`/api/v1/followup-drafts/${created.draftId}/confirm`)
      .send({ versionNo: "2" })
      .expect(400);

    const confirmRequest = () =>
      actorRequest(app)
        .post(`/api/v1/followup-drafts/${created.draftId}/confirm`)
        .set("idempotency-key", "confirm-draft-e2e-001")
        .send({ versionNo: "2" });
    const firstConfirmation = followupConfirmationResponseSchema.parse(
      (await confirmRequest().expect(201)).body,
    );
    const retriedConfirmation = followupConfirmationResponseSchema.parse(
      (await confirmRequest().expect(201)).body,
    );
    expect(retriedConfirmation).toEqual(firstConfirmation);

    const confirmedDraft = followupDraftResponseSchema.parse(
      (
        await actorRequest(app)
          .get(`/api/v1/followup-drafts/${created.draftId}`)
          .expect(200)
      ).body,
    );
    expect(confirmedDraft).toMatchObject({
      status: "confirmed",
      followupId: firstConfirmation.followupId,
      confirmedBy: SYNTHETIC_USER_ID,
      versionNo: "3",
    });

    const formalResponse = await actorRequest(app)
      .get(`/api/v1/followups/${firstConfirmation.followupId}`)
      .expect(200);
    expect(formalFollowupRecordSchema.parse(formalResponse.body)).toMatchObject(
      {
        followupId: firstConfirmation.followupId,
        sourceDraftId: created.draftId,
        entityId: SYNTHETIC_ENTITY_ID,
        summary: revisedCandidate.summary,
        followupType: "meeting",
        facts: [{ factType: "budget_status", factValue: "预算已确认" }],
      },
    );
  });

  test("keeps drafts tenant-scoped and maps malformed identifiers to 400", async () => {
    const created = followupDraftResponseSchema.parse(
      (
        await actorRequest(app)
          .post("/api/v1/followup-drafts")
          .send({ entityId: SYNTHETIC_ENTITY_ID, rawInput: "租户隔离测试" })
          .expect(201)
      ).body,
    );

    await request(app.getHttpServer())
      .get(`/api/v1/followup-drafts/${created.draftId}`)
      .set("x-tenant-id", SYNTHETIC_OTHER_TENANT_ID)
      .set("x-user-id", SYNTHETIC_OTHER_USER_ID)
      .expect(404);
    const malformed = await actorRequest(app)
      .get("/api/v1/followup-drafts/not-a-uuid")
      .expect(400);
    expect(followupApiErrorSchema.parse(malformed.body)).toMatchObject({
      code: "INVALID_FOLLOWUP_DRAFT",
    });
  });

  test("cancels idempotently and rejects confirmation of a cancelled draft", async () => {
    const created = followupDraftResponseSchema.parse(
      (
        await actorRequest(app)
          .post("/api/v1/followup-drafts")
          .send({ entityId: SYNTHETIC_ENTITY_ID, rawInput: "应取消的草稿" })
          .expect(201)
      ).body,
    );
    const cancelRequest = () =>
      actorRequest(app)
        .post(`/api/v1/followup-drafts/${created.draftId}/cancel`)
        .set("idempotency-key", "cancel-draft-e2e-001")
        .send({ versionNo: "1" });
    const cancelled = followupDraftResponseSchema.parse(
      (await cancelRequest().expect(201)).body,
    );
    expect(cancelled).toMatchObject({ status: "cancelled", versionNo: "2" });
    expect(
      followupDraftResponseSchema.parse(
        (await cancelRequest().expect(201)).body,
      ),
    ).toEqual(cancelled);

    const response = await actorRequest(app)
      .post(`/api/v1/followup-drafts/${created.draftId}/confirm`)
      .set("idempotency-key", "confirm-cancelled-draft-e2e")
      .send({ versionNo: "2" })
      .expect(409);
    expect(followupApiErrorSchema.parse(response.body)).toMatchObject({
      code: "DRAFT_NOT_PENDING",
    });
  });

  test("rejects requests without an actor before exposing draft state", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/followup-drafts/70000000-0000-4000-8000-000000000001")
      .expect(401);
  });
});

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
