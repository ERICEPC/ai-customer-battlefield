import { afterEach, describe, expect, it, vi } from "vitest";

import { getSession, login, logout } from "./api-client";

const salesSession = {
  user: {
    id: "30000000-0000-4000-8000-000000000001",
    displayName: "销售1",
    email: "sales1@demo.local",
  },
  role: "sales" as const,
  capabilities: [],
  department: {
    id: "31000000-0000-4000-8000-000000000001",
    name: "商业化一部",
  },
  directLeader: {
    id: "30000000-0000-4000-8000-000000000072",
    displayName: "领导A",
  },
  teamMembers: [],
  expiresAt: "2026-09-01T08:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authentication API client", () => {
  it("logs in with cookie credentials and returns the session", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ session: salesSession }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      login({
        tenantSlug: "alpha",
        email: "sales1@demo.local",
        password: "Demo@2026",
      }),
    ).resolves.toEqual(salesSession);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/v1/auth/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("loads and revokes the current browser session", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(salesSession), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(getSession()).resolves.toEqual(salesSession);
    await expect(logout()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3001/api/v1/auth/session",
      { credentials: "include" },
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3001/api/v1/auth/logout",
      { method: "POST", credentials: "include" },
    );
  });
});
