import { fileURLToPath } from "node:url";
import { AuthenticateSession } from "@battlefield/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { KyselyIdentityStore } from "../src/identity/kysely-identity-store.js";
import { migrateDatabase } from "../src/migrate.js";
import {
  createPgliteDatabase,
  SYNTHETIC_DEMO_PASSWORD,
  SYNTHETIC_LEADER_EMAIL,
  SYNTHETIC_SALES_EMAIL,
  seedSyntheticBusinessEntityDirectory,
  seedSyntheticManagementObserver,
  seedSyntheticTwoLevelIdentity,
} from "../src/testing/index.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

describe("synthetic two-level identity", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedSyntheticBusinessEntityDirectory(database);
    await seedSyntheticManagementObserver(database);
  });

  afterEach(async () => {
    await database.close();
  });

  test("seeds repeatable Sales 1 and Leader A login profiles", async () => {
    await seedSyntheticTwoLevelIdentity(database);
    await seedSyntheticTwoLevelIdentity(database);
    const store = new KyselyIdentityStore(database.db);

    const sales = await authenticate(store, SYNTHETIC_SALES_EMAIL);
    const leader = await authenticate(store, SYNTHETIC_LEADER_EMAIL);

    expect(sales.session).toMatchObject({
      user: { displayName: "销售1", email: SYNTHETIC_SALES_EMAIL },
      role: "sales",
      capabilities: [],
      department: { name: "商业化一部" },
      directLeader: { displayName: "领导A" },
      teamMembers: [],
    });
    expect(leader.session).toMatchObject({
      user: { displayName: "领导A", email: SYNTHETIC_LEADER_EMAIL },
      role: "department_leader",
      capabilities: [
        "access_control.manage",
        "ai_runtime_config.manage",
        "audit.read",
        "management_query.execute",
        "worker_operations.manage",
      ],
      department: { name: "商业化一部" },
      directLeader: null,
      teamMembers: [{ displayName: "销售1" }],
    });

    const counts = await database.db
      .selectFrom("app.user_memberships")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("role_code", "in", ["sales", "department_leader"])
      .executeTakeFirstOrThrow();
    expect(Number(counts.count)).toBe(2);
  });
});

async function authenticate(store: KyselyIdentityStore, email: string) {
  return new AuthenticateSession({
    store,
    clock: { now: () => new Date("2026-08-31T12:00:00.000Z") },
    idGenerator: { next: () => crypto.randomUUID() },
    tokenGenerator: {
      next: () => `synthetic-${crypto.randomUUID().replaceAll("-", "")}`,
    },
    sessionDurationMs: 8 * 60 * 60 * 1_000,
  }).execute({
    tenantSlug: "alpha",
    email,
    password: SYNTHETIC_DEMO_PASSWORD,
  });
}
