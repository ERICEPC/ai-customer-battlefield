import {
  type FormalFollowupRecord,
  formalFollowupRecordSchema,
} from "@battlefield/contracts";
import type { GetFormalFollowup } from "@battlefield/core";
import { Controller, Get, Headers, Inject, Param } from "@nestjs/common";

import { GET_FORMAL_FOLLOWUP } from "../followup-drafts/followup-draft.providers.js";
import {
  developmentActor,
  followupIdentifier,
  mapFollowupError,
} from "../followup-drafts/followup-http.js";

@Controller("followups")
export class FollowupsController {
  constructor(
    @Inject(GET_FORMAL_FOLLOWUP)
    private readonly getFormalFollowup: GetFormalFollowup,
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
}
