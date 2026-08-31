import type {
  InboxPage,
  MarkNotificationReadResponse,
} from "@battlefield/contracts";
import { KyselyNotificationStore } from "@battlefield/database";
import type { Provider } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";

export interface InboxStore {
  listInbox(input: {
    actor: { tenantId: string; userId: string };
    unreadOnly?: boolean;
    cursor?: string;
    limit: number;
  }): Promise<InboxPage>;
  markRead(input: {
    actor: { tenantId: string; userId: string };
    notificationId: string;
    readAt: string;
  }): Promise<MarkNotificationReadResponse>;
}

export class NotificationStoreUnavailableError extends Error {
  constructor() {
    super("Notification persistence is unavailable.");
    this.name = "NotificationStoreUnavailableError";
  }
}

export const INBOX_STORE = Symbol("INBOX_STORE");

const unavailableStore: InboxStore = {
  async listInbox() {
    throw new NotificationStoreUnavailableError();
  },
  async markRead() {
    throw new NotificationStoreUnavailableError();
  },
};

export const notificationProviders: Provider[] = [
  {
    provide: INBOX_STORE,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle): InboxStore =>
      database ? new KyselyNotificationStore(database.db) : unavailableStore,
  },
];
