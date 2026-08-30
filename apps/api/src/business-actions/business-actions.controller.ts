import {
  type ActionTransitionResponse,
  actionTransitionResponseSchema,
  type BusinessActionPage,
  type BusinessActionRecord,
  businessActionListQuerySchema,
  businessActionPageSchema,
  businessActionRecordSchema,
  transitionBusinessActionRequestSchema,
} from "@battlefield/contracts";
import type {
  ActionQueryReader,
  TransitionBusinessAction,
} from "@battlefield/core";
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";

import {
  invalidActionRequest,
  mapActionError,
  resourceIdentifier,
} from "../battle-analysis/battle-http.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  ACTION_QUERY_READER,
  TRANSITION_BUSINESS_ACTION,
} from "./business-actions.providers.js";

@Controller("actions")
export class BusinessActionsController {
  constructor(
    @Inject(ACTION_QUERY_READER)
    private readonly reader: ActionQueryReader,
    @Inject(TRANSITION_BUSINESS_ACTION)
    private readonly transitionAction: TransitionBusinessAction,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BusinessActionPage> {
    const actor = developmentActor(tenantId, userId);
    const parsed = businessActionListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidActionRequest(
        "Invalid business-action query.",
        parsed.error.issues,
      );
    }
    try {
      return businessActionPageSchema.parse(
        await this.reader.listActions({
          actor,
          limit: parsed.data.limit ?? 20,
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
          ...(parsed.data.priority ? { priority: parsed.data.priority } : {}),
          ...(parsed.data.entityId ? { entityId: parsed.data.entityId } : {}),
          ...(parsed.data.ownerUserId
            ? { ownerUserId: parsed.data.ownerUserId }
            : {}),
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      return mapActionError(error);
    }
  }

  @Get(":actionId")
  async get(
    @Param("actionId") rawActionId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<BusinessActionRecord> {
    const actor = developmentActor(tenantId, userId);
    const actionId = resourceIdentifier(rawActionId, "Business action");
    try {
      return businessActionRecordSchema.parse(
        await this.reader.getAction({ actor, actionId }),
      );
    } catch (error) {
      return mapActionError(error);
    }
  }

  @Post(":actionId/transition")
  async transition(
    @Param("actionId") rawActionId: string,
    @Body() body: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ActionTransitionResponse> {
    const actor = developmentActor(tenantId, userId);
    const actionId = resourceIdentifier(rawActionId, "Business action");
    const parsed = transitionBusinessActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidActionRequest(
        "Invalid business-action transition.",
        parsed.error.issues,
      );
    }
    try {
      return actionTransitionResponseSchema.parse(
        await this.transitionAction.execute({
          actor,
          actionId,
          versionNo: parsed.data.versionNo,
          toStatus: parsed.data.toStatus,
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        }),
      );
    } catch (error) {
      return mapActionError(error, parsed.data.versionNo);
    }
  }
}
