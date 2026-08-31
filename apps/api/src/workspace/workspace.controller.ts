import { randomUUID } from "node:crypto";
import {
  type WorkspaceSnapshot,
  workspaceQuerySchema,
  workspaceSnapshotSchema,
} from "@battlefield/contracts";
import type { GetWorkspaceSnapshot } from "@battlefield/core";
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";

import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  GET_WORKSPACE_SNAPSHOT,
  WorkspaceUnavailableError,
} from "./workspace.providers.js";

@Controller("workspace")
export class WorkspaceController {
  constructor(
    @Inject(GET_WORKSPACE_SNAPSHOT)
    private readonly getWorkspaceSnapshot: GetWorkspaceSnapshot,
  ) {}

  @Get()
  async get(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<WorkspaceSnapshot> {
    const actor = developmentActor(tenantId, userId);
    const parsed = workspaceQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(
        errorPayload(
          "INVALID_WORKSPACE_QUERY",
          "Invalid workspace query.",
          parsed.error.issues,
        ),
      );
    }

    try {
      return workspaceSnapshotSchema.parse(
        await this.getWorkspaceSnapshot.execute({ actor }),
      );
    } catch (error) {
      if (error instanceof WorkspaceUnavailableError) {
        throw new ServiceUnavailableException(
          errorPayload("WORKSPACE_UNAVAILABLE", error.message),
        );
      }
      throw error;
    }
  }
}

function errorPayload(code: string, message: string, issues?: unknown[]) {
  return {
    code,
    message,
    requestId: randomUUID(),
    ...(issues ? { issues: normalizeIssues(issues) } : {}),
  };
}

function normalizeIssues(issues: unknown[]) {
  return issues.map((issue, index) => {
    if (issue && typeof issue === "object") {
      const candidate = issue as { path?: unknown; message?: unknown };
      return {
        path: Array.isArray(candidate.path)
          ? candidate.path.map(String).join(".") || "query"
          : String(candidate.path ?? index),
        reason:
          typeof candidate.message === "string"
            ? candidate.message
            : "Invalid value.",
      };
    }
    return { path: String(index), reason: "Invalid value." };
  });
}
