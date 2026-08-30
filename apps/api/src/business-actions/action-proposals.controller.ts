import {
  type ActionDecisionResponse,
  type ActionProposalPage,
  type ActionProposalRecord,
  acceptActionProposalRequestSchema,
  actionDecisionResponseSchema,
  actionProposalListQuerySchema,
  actionProposalPageSchema,
  actionProposalRecordSchema,
  rejectActionProposalRequestSchema,
} from "@battlefield/contracts";
import type {
  AcceptActionProposal,
  ActionQueryReader,
  RejectActionProposal,
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
  actionIdempotencyKey,
  invalidActionRequest,
  mapActionError,
  resourceIdentifier,
} from "../battle-analysis/battle-http.js";
import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  ACCEPT_ACTION_PROPOSAL,
  ACTION_QUERY_READER,
  REJECT_ACTION_PROPOSAL,
} from "./business-actions.providers.js";

@Controller("action-proposals")
export class ActionProposalsController {
  constructor(
    @Inject(ACTION_QUERY_READER)
    private readonly reader: ActionQueryReader,
    @Inject(ACCEPT_ACTION_PROPOSAL)
    private readonly acceptProposal: AcceptActionProposal,
    @Inject(REJECT_ACTION_PROPOSAL)
    private readonly rejectProposal: RejectActionProposal,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ActionProposalPage> {
    const actor = developmentActor(tenantId, userId);
    const parsed = actionProposalListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidActionRequest(
        "Invalid action-proposal query.",
        parsed.error.issues,
      );
    }
    try {
      return actionProposalPageSchema.parse(
        await this.reader.listProposals({
          actor,
          limit: parsed.data.limit ?? 20,
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
          ...(parsed.data.priority ? { priority: parsed.data.priority } : {}),
          ...(parsed.data.entityId ? { entityId: parsed.data.entityId } : {}),
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      return mapActionError(error);
    }
  }

  @Get(":proposalId")
  async get(
    @Param("proposalId") rawProposalId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ActionProposalRecord> {
    const actor = developmentActor(tenantId, userId);
    const proposalId = resourceIdentifier(rawProposalId, "Action proposal");
    try {
      return actionProposalRecordSchema.parse(
        await this.reader.getProposal({ actor, proposalId }),
      );
    } catch (error) {
      return mapActionError(error);
    }
  }

  @Post(":proposalId/accept")
  async accept(
    @Param("proposalId") rawProposalId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ActionDecisionResponse> {
    const actor = developmentActor(tenantId, userId);
    const proposalId = resourceIdentifier(rawProposalId, "Action proposal");
    const idempotencyKey = actionIdempotencyKey(rawIdempotencyKey);
    const parsed = acceptActionProposalRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidActionRequest(
        "Invalid action-proposal acceptance.",
        parsed.error.issues,
      );
    }
    try {
      return actionDecisionResponseSchema.parse(
        await this.acceptProposal.execute({
          actor,
          proposalId,
          idempotencyKey,
          ...parsed.data,
        }),
      );
    } catch (error) {
      return mapActionError(error, parsed.data.versionNo);
    }
  }

  @Post(":proposalId/reject")
  async reject(
    @Param("proposalId") rawProposalId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") rawIdempotencyKey?: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<ActionDecisionResponse> {
    const actor = developmentActor(tenantId, userId);
    const proposalId = resourceIdentifier(rawProposalId, "Action proposal");
    const idempotencyKey = actionIdempotencyKey(rawIdempotencyKey);
    const parsed = rejectActionProposalRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidActionRequest(
        "Invalid action-proposal rejection.",
        parsed.error.issues,
      );
    }
    try {
      return actionDecisionResponseSchema.parse(
        await this.rejectProposal.execute({
          actor,
          proposalId,
          idempotencyKey,
          ...parsed.data,
        }),
      );
    } catch (error) {
      return mapActionError(error, parsed.data.versionNo);
    }
  }
}
