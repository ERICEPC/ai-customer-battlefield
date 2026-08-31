import { randomUUID } from "node:crypto";
import {
  type InboxPage,
  inboxPageSchema,
  inboxQuerySchema,
  type MarkNotificationReadResponse,
  markNotificationReadResponseSchema,
} from "@battlefield/contracts";
import {
  InvalidInboxCursorError,
  NotificationNotFoundError,
} from "@battlefield/database";
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";

import { developmentActor } from "../followup-drafts/followup-http.js";
import {
  INBOX_STORE,
  type InboxStore,
  NotificationStoreUnavailableError,
} from "./notifications.providers.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("inbox")
export class InboxController {
  constructor(
    @Inject(INBOX_STORE)
    private readonly store: InboxStore,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<InboxPage> {
    const actor = developmentActor(tenantId, userId);
    const parsed = inboxQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(
        errorPayload(
          "INVALID_INBOX_QUERY",
          "Invalid inbox query.",
          parsed.error.issues,
        ),
      );
    }
    try {
      return inboxPageSchema.parse(
        await this.store.listInbox({
          actor,
          limit: parsed.data.limit ?? 50,
          ...(parsed.data.unreadOnly === undefined
            ? {}
            : { unreadOnly: parsed.data.unreadOnly }),
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      return mapNotificationError(error);
    }
  }

  @Post(":notificationId/read")
  async markRead(
    @Param("notificationId") notificationId: string,
    @Headers("x-tenant-id") tenantId?: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<MarkNotificationReadResponse> {
    const actor = developmentActor(tenantId, userId);
    if (!UUID_PATTERN.test(notificationId)) {
      throw new BadRequestException(
        errorPayload(
          "INVALID_NOTIFICATION_ID",
          "Notification identifier must be a UUID.",
        ),
      );
    }
    try {
      return markNotificationReadResponseSchema.parse(
        await this.store.markRead({
          actor,
          notificationId,
          readAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      return mapNotificationError(error);
    }
  }
}

function mapNotificationError(error: unknown): never {
  if (error instanceof InvalidInboxCursorError) {
    throw new BadRequestException(
      errorPayload("INVALID_INBOX_QUERY", error.message),
    );
  }
  if (error instanceof NotificationNotFoundError) {
    throw new NotFoundException(
      errorPayload("NOTIFICATION_NOT_FOUND", error.message),
    );
  }
  if (error instanceof NotificationStoreUnavailableError) {
    throw new ServiceUnavailableException(
      errorPayload("NOTIFICATION_STORE_UNAVAILABLE", error.message),
    );
  }
  throw error;
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
