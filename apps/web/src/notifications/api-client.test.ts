import type {
  InboxPage,
  MarkNotificationReadResponse,
} from "@battlefield/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  listInbox,
  markNotificationRead,
  NotificationApiError,
} from "./api-client";

const notificationId = "f0000000-0000-4000-8000-000000000071";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notification API client", () => {
  test("serializes inbox filters and validates the page", async () => {
    const page: InboxPage = { items: [], nextCursor: null };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listInbox({ unreadOnly: true, limit: 50, cursor: "next-page" }),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/v1/inbox?unreadOnly=true&cursor=next-page&limit=50",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  test("marks the encoded notification route read", async () => {
    const receipt: MarkNotificationReadResponse = {
      notificationId,
      readAt: "2026-08-31T00:10:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(receipt), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(markNotificationRead(notificationId)).resolves.toEqual(
      receipt,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3001/api/v1/inbox/${notificationId}/read`,
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
      }),
    );
  });

  test("preserves stable notification errors and hides arbitrary bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "NOTIFICATION_STORE_UNAVAILABLE",
            message: "通知服务暂不可用。",
            requestId: "request-071",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const error = await listInbox({ limit: 50 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NotificationApiError);
    expect(error).toMatchObject({
      status: 503,
      code: "NOTIFICATION_STORE_UNAVAILABLE",
      message: "通知服务暂不可用。",
      requestId: "request-071",
    });
  });
});
