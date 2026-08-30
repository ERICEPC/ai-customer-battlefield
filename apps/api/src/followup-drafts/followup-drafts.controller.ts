import {
  createFollowupDraftRequestSchema,
  type FollowupDraftResponse,
  followupDraftResponseSchema,
} from "@battlefield/contracts";
import type { CreateFollowupDraft } from "@battlefield/core";
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  UnauthorizedException,
} from "@nestjs/common";

import { CREATE_FOLLOWUP_DRAFT } from "./followup-draft.providers.js";

@Controller("followup-drafts")
export class FollowupDraftsController {
  constructor(
    @Inject(CREATE_FOLLOWUP_DRAFT)
    private readonly createFollowupDraft: CreateFollowupDraft,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<FollowupDraftResponse> {
    // Development-only actor adapter. Production fails closed until real authentication is installed.
    if (process.env.NODE_ENV === "production" || !tenantId || !userId) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const parsedRequest = createFollowupDraftRequestSchema.safeParse(body);
    if (!parsedRequest.success) {
      throw new BadRequestException({
        message: "Invalid follow-up draft request.",
        issues: parsedRequest.error.issues,
      });
    }

    const draft = await this.createFollowupDraft.execute({
      actor: { tenantId, userId },
      rawInput: parsedRequest.data.rawInput,
    });

    return followupDraftResponseSchema.parse(draft);
  }
}
