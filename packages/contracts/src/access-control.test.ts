import { describe, expect, test } from "vitest";

import {
  accessControlSnapshotSchema,
  replaceRoleCapabilitiesRequestSchema,
  roleCapabilityUpdateSchema,
} from "./access-control.js";

const capabilities = [
  "access_control.manage",
  "ai_runtime_config.manage",
  "audit.read",
  "management_query.execute",
  "worker_operations.manage",
] as const;

describe("access-control contracts", () => {
  test("accepts a strict capability catalog and current role projection", () => {
    expect(
      accessControlSnapshotSchema.parse({
        capabilities: capabilities.map((code) => ({
          code,
          name: code,
          description: `${code} description`,
        })),
        roles: [
          {
            roleCode: "department_leader",
            displayName: "部门领导",
            activeUserCount: 1,
            capabilities,
          },
          {
            roleCode: "sales",
            displayName: "销售",
            activeUserCount: 8,
            capabilities: [],
          },
        ],
      }).roles[0]?.capabilities,
    ).toEqual(capabilities);
  });

  test("requires a unique closed capability set and explicit reason", () => {
    expect(
      replaceRoleCapabilitiesRequestSchema.safeParse({
        capabilities: ["audit.read"],
        reason: "授予审计查询职责",
      }).success,
    ).toBe(true);
    expect(
      replaceRoleCapabilitiesRequestSchema.safeParse({
        capabilities: ["audit.read", "audit.read"],
        reason: "重复能力",
      }).success,
    ).toBe(false);
    expect(
      replaceRoleCapabilitiesRequestSchema.safeParse({
        capabilities: ["tenant.superuser"],
        reason: "未知能力",
      }).success,
    ).toBe(false);
    expect(
      replaceRoleCapabilitiesRequestSchema.safeParse({
        capabilities: [],
        reason: " ",
      }).success,
    ).toBe(false);
  });

  test("keeps mutation responses strict and auditable", () => {
    expect(
      roleCapabilityUpdateSchema.parse({
        roleCode: "sales",
        capabilities: ["audit.read"],
        changed: true,
        updatedAt: "2026-09-01T07:30:00.000Z",
      }),
    ).toEqual({
      roleCode: "sales",
      capabilities: ["audit.read"],
      changed: true,
      updatedAt: "2026-09-01T07:30:00.000Z",
    });
    expect(
      roleCapabilityUpdateSchema.safeParse({
        roleCode: "sales",
        capabilities: [],
        changed: false,
        updatedAt: "2026-09-01T07:30:00.000Z",
        tenantId: "10000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });
});
