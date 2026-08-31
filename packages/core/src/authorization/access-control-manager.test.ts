import { describe, expect, test, vi } from "vitest";

import {
  type AccessControlRepository,
  InvalidAccessControlInputError,
  ReplaceRoleCapabilities,
} from "./access-control-manager.js";

const actor = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "30000000-0000-4000-8000-000000000072",
};

describe("ReplaceRoleCapabilities", () => {
  test("normalizes the full desired set before persistence", async () => {
    const replaceRoleCapabilities = vi
      .fn<AccessControlRepository["replaceRoleCapabilities"]>()
      .mockResolvedValue({
        roleCode: "sales",
        capabilities: ["audit.read", "worker_operations.manage"],
        changed: true,
        updatedAt: "2026-09-01T07:30:00.000Z",
      });
    const useCase = new ReplaceRoleCapabilities({
      getSnapshot: vi.fn(),
      replaceRoleCapabilities,
    });

    await useCase.execute({
      actor,
      roleCode: "sales",
      capabilities: ["worker_operations.manage", "audit.read"],
      reason: "  临时承担审计与运维职责  ",
      idempotencyKey: "grant-sales-ops-1",
    });

    expect(replaceRoleCapabilities).toHaveBeenCalledWith({
      actor,
      roleCode: "sales",
      capabilities: ["audit.read", "worker_operations.manage"],
      reason: "临时承担审计与运维职责",
      idempotencyKey: "grant-sales-ops-1",
    });
  });

  test.each([
    {
      roleCode: "Sales Team",
      capabilities: ["audit.read"],
      reason: "invalid role",
      idempotencyKey: "grant-1",
    },
    {
      roleCode: "sales",
      capabilities: ["audit.read", "audit.read"],
      reason: "duplicate",
      idempotencyKey: "grant-2",
    },
    {
      roleCode: "sales",
      capabilities: ["audit.read"],
      reason: " ",
      idempotencyKey: "grant-3",
    },
    {
      roleCode: "sales",
      capabilities: ["audit.read"],
      reason: "valid",
      idempotencyKey: "unsafe key",
    },
  ])("rejects invalid management input before persistence", async (input) => {
    const repository: AccessControlRepository = {
      getSnapshot: vi.fn(),
      replaceRoleCapabilities: vi.fn(),
    };
    await expect(
      new ReplaceRoleCapabilities(repository).execute({
        actor,
        ...input,
        capabilities: input.capabilities as ["audit.read"],
      }),
    ).rejects.toBeInstanceOf(InvalidAccessControlInputError);
    expect(repository.replaceRoleCapabilities).not.toHaveBeenCalled();
  });
});
