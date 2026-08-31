import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loginRequestSchema, sessionProfileSchema } from "./auth.js";

describe("authentication contracts", () => {
  it("accepts a sales profile with its direct leader", () => {
    const profile = sessionProfileSchema.parse({
      user: {
        id: randomUUID(),
        displayName: "销售1",
        email: "sales1@demo.local",
      },
      role: "sales",
      department: { id: randomUUID(), name: "商业化一部" },
      directLeader: { id: randomUUID(), displayName: "领导A" },
      teamMembers: [],
      expiresAt: "2026-09-01T12:00:00.000Z",
    });

    expect(profile.role).toBe("sales");
    expect(profile.directLeader?.displayName).toBe("领导A");
  });

  it("accepts a department leader with its current sales roster", () => {
    const profile = sessionProfileSchema.parse({
      user: {
        id: randomUUID(),
        displayName: "领导A",
        email: "leader.a@demo.local",
      },
      role: "department_leader",
      department: { id: randomUUID(), name: "商业化一部" },
      directLeader: null,
      teamMembers: [{ id: randomUUID(), displayName: "销售1" }],
      expiresAt: "2026-09-01T12:00:00.000Z",
    });

    expect(profile.teamMembers.map((member) => member.displayName)).toEqual([
      "销售1",
    ]);
  });

  it("rejects roles outside the first two-level identity model", () => {
    expect(() =>
      sessionProfileSchema.parse({
        user: {
          id: randomUUID(),
          displayName: "区域负责人",
          email: "region@demo.local",
        },
        role: "regional_manager",
        department: { id: randomUUID(), name: "华东区" },
        directLeader: null,
        teamMembers: [],
        expiresAt: "2026-09-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("normalizes tenant and email identifiers without changing the password", () => {
    expect(
      loginRequestSchema.parse({
        tenantSlug: "ALPHA",
        email: " SALES1@DEMO.LOCAL ",
        password: "Demo@2026",
      }),
    ).toEqual({
      tenantSlug: "alpha",
      email: "sales1@demo.local",
      password: "Demo@2026",
    });
  });
});
