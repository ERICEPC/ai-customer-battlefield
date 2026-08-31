import {
  type FollowupAutomationStatus,
  type FormalFollowupRecord,
  followupAutomationStatusSchema,
  formalFollowupRecordSchema,
} from "@battlefield/contracts";
import type {
  GetFollowupAutomationStatus,
  GetFormalFollowup,
} from "@battlefield/core";
import { Controller, Get, Headers, Inject, Param } from "@nestjs/common";

import {
  GET_FOLLOWUP_AUTOMATION_STATUS,
  GET_FORMAL_FOLLOWUP,
} from "../followup-drafts/followup-draft.providers.js";
import {
  developmentActor,
  eventIdentifier,
  followupIdentifier,
  mapFollowupError,
} from "../followup-drafts/followup-http.js";

@Controller("followups")
export class FollowupsController {
  constructor(
    @Inject(GET_FORMAL_FOLLOWUP)
    private readonly getFormalFollowup: GetFormalFollowup,
    @Inject(GET_FOLLOWUP_AUTOMATION_STATUS)
    private readonly getFollowupAutomationStatus: GetFollowupAutomationStatus,
  ) {}

  @Get(":followupId")
  async get(
    @Param("followupId") rawFollowupId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<FormalFollowupRecord> {
    const actor = developmentActor(tenantId, userId);
    const followupId = followupIdentifier(rawFollowupId);
    try {
      return formalFollowupRecordSchema.parse(
        await this.getFormalFollowup.execute({ actor, followupId }),
      );
    } catch (error) {
      return mapFollowupError(error);
    }
  }

  @Get(":followupId/automation-status/:eventId")
  async getAutomationStatus(
    @Param("followupId") rawFollowupId: string,
    @Param("eventId") rawEventId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<FollowupAutomationStatus> {
    const actor = developmentActor(tenantId, userId);
    const followupId = followupIdentifier(rawFollowupId);
    const eventId = eventIdentifier(rawEventId);
    try {
      return followupAutomationStatusSchema.parse(
        await this.getFollowupAutomationStatus.execute({
          actor,
          followupId,
          eventId,
        }),
      );
    } catch (error) {
      return mapFollowupError(error);
    }
  }
}
