import {
  cancelFollowupDraftRequestSchema,
  confirmFollowupDraftRequestSchema,
  createFollowupDraftRequestSchema,
  type FollowupConfirmationResponse,
  type FollowupDraftResponse,
  followupConfirmationResponseSchema,
  followupDraftResponseSchema,
  reviseFollowupDraftRequestSchema,
} from "@battlefield/contracts";
import type {
  CancelFollowupDraft,
  ConfirmFollowupDraft,
  CreatePersistentFollowupDraft,
  GetFollowupDraft,
  ReviseFollowupDraft,
} from "@battlefield/core";
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";

import {
  CANCEL_FOLLOWUP_DRAFT,
  CONFIRM_FOLLOWUP_DRAFT,
  CREATE_FOLLOWUP_DRAFT,
  GET_FOLLOWUP_DRAFT,
  REVISE_FOLLOWUP_DRAFT,
} from "./followup-draft.providers.js";
import {
  developmentActor,
  draftIdentifier,
  idempotencyKey,
  invalidRequest,
  mapFollowupError,
} from "./followup-http.js";

@Controller("followup-drafts")
export class FollowupDraftsController {
  constructor(
    @Inject(CREATE_FOLLOWUP_DRAFT)
    private readonly createDraft: CreatePersistentFollowupDraft,
    @Inject(GET_FOLLOWUP_DRAFT)
    private readonly getDraft: GetFollowupDraft,
    @Inject(REVISE_FOLLOWUP_DRAFT)
    private readonly reviseDraft: ReviseFollowupDraft,
    @Inject(CANCEL_FOLLOWUP_DRAFT)
    private readonly cancelDraft: CancelFollowupDraft,
    @Inject(CONFIRM_FOLLOWUP_DRAFT)
    private readonly confirmDraft: ConfirmFollowupDraft,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<FollowupDraftResponse> {
    const actor = developmentActor(tenantId, userId);
    const parsed = createFollowupDraftRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest(
        "Invalid follow-up draft request.",
        parsed.error.issues,
      );
    }
    try {
      return followupDraftResponseSchema.parse(
        await this.createDraft.execute({
          actor,
          entityId: parsed.data.entityId,
          rawInput: parsed.data.rawInput,
          ...(parsed.data.occurredAt
            ? { occurredAt: parsed.data.occurredAt }
            : {}),
        }),
      );
    } catch (error) {
      return mapFollowupError(error);
    }
  }

  @Get(":draftId")
  async get(
    @Param("draftId") rawDraftId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<FollowupDraftResponse> {
    const actor = developmentActor(tenantId, userId);
    const draftId = draftIdentifier(rawDraftId);
    try {
      return followupDraftResponseSchema.parse(
        await this.getDraft.execute({ actor, draftId }),
      );
    } catch (error) {
      return mapFollowupError(error);
    }
  }

  @Patch(":draftId")
  async revise(
    @Param("draftId") rawDraftId: string,
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<FollowupDraftResponse> {
    const actor = developmentActor(tenantId, userId);
    const draftId = draftIdentifier(rawDraftId);
    const parsed = reviseFollowupDraftRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest("Invalid draft revision.", parsed.error.issues);
    }
    try {
      return followupDraftResponseSchema.parse(
        await this.reviseDraft.execute({
          actor,
          draftId,
          versionNo: parsed.data.versionNo,
          candidate: parsed.data.candidate,
          changedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      return mapFollowupError(error, parsed.data.versionNo);
    }
  }

  @Post(":draftId/cancel")
  async cancel(
    @Param("draftId") rawDraftId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<FollowupDraftResponse> {
    const actor = developmentActor(tenantId, userId);
    const draftId = draftIdentifier(rawDraftId);
    const key = idempotencyKey(rawIdempotencyKey);
    const parsed = cancelFollowupDraftRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest("Invalid draft cancellation.", parsed.error.issues);
    }
    try {
      return followupDraftResponseSchema.parse(
        await this.cancelDraft.execute({
          actor,
          draftId,
          versionNo: parsed.data.versionNo,
          idempotencyKey: key,
          cancelledAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      return mapFollowupError(error);
    }
  }

  @Post(":draftId/confirm")
  async confirm(
    @Param("draftId") rawDraftId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<FollowupConfirmationResponse> {
    const actor = developmentActor(tenantId, userId);
    const draftId = draftIdentifier(rawDraftId);
    const key = idempotencyKey(rawIdempotencyKey);
    const parsed = confirmFollowupDraftRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest("Invalid draft confirmation.", parsed.error.issues);
    }
    try {
      return followupConfirmationResponseSchema.parse(
        await this.confirmDraft.execute({
          actor,
          draftId,
          versionNo: parsed.data.versionNo,
          idempotencyKey: key,
          confirmedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      return mapFollowupError(error, parsed.data.versionNo);
    }
  }
}
