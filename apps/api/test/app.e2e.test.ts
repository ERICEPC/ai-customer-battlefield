import { followupDraftResponseSchema } from "@battlefield/contracts";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/main.js";

describe("public API v1", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports API health", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/health")
      .expect(200)
      .expect({ status: "ok" });
  });

  it("allows the configured Web origin without opening CORS to every site", async () => {
    const response = await request(app.getHttpServer())
      .options("/api/v1/followup-drafts")
      .set("origin", "http://localhost:3000")
      .set("access-control-request-method", "POST")
      .expect(204);

    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
  });

  it("returns an AI proposal as a pending-confirmation draft", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/followup-drafts")
      .set("x-tenant-id", "tenant-demo")
      .set("x-user-id", "user-demo")
      .send({
        entityId: "50000000-0000-4000-8000-000000000001",
        rawInput: "客户确认预算，下一步提交方案",
      })
      .expect(201);

    const draft = followupDraftResponseSchema.parse(response.body);
    expect(draft.status).toBe("pending_confirmation");
    expect(draft.rawInput).toBe("客户确认预算，下一步提交方案");
  });

  it("rejects a draft request without development actor headers", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/followup-drafts")
      .send({ rawInput: "客户确认预算" })
      .expect(401);
  });

  it("rejects blank follow-up input", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/followup-drafts")
      .set("x-tenant-id", "tenant-demo")
      .set("x-user-id", "user-demo")
      .send({
        entityId: "50000000-0000-4000-8000-000000000001",
        rawInput: "   ",
      })
      .expect(400);
  });
});
