import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";
const REQUEST_ID = "90000000-0000-4000-8000-000000000216";

describe("management capability existing-tenant backfill", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("grants defaults to a tenant that predates the capability tables", async () => {
    const database = await createPgliteDatabase<BattlefieldDatabase>();
    const stagedDirectory = await mkdtemp(
      join(tmpdir(), "battlefield-capability-migrations-"),
    );
    temporaryDirectories.push(stagedDirectory);

    try {
      await copyMigrations(stagedDirectory, (name) => name < "0014_");
      await migrateDatabase(database.migrations, stagedDirectory);
      await withTenantTransaction(
        database.db,
        { tenantId: TENANT_ID, userId: USER_ID, requestId: REQUEST_ID },
        (transaction) =>
          transaction
            .insertInto("app.tenants")
            .values({ id: TENANT_ID, slug: "alpha", name: "Alpha" })
            .executeTakeFirstOrThrow(),
      );

      await copyMigrations(stagedDirectory, (name) => name < "0015_");
      await migrateDatabase(database.migrations, stagedDirectory);
      await withTenantTransaction(
        database.db,
        { tenantId: TENANT_ID, userId: USER_ID, requestId: REQUEST_ID },
        (transaction) =>
          transaction
            .deleteFrom("app.role_capability_grants")
            .where("tenant_id", "=", TENANT_ID)
            .execute(),
      );

      await copyMigrations(stagedDirectory, () => true);
      await migrateDatabase(database.migrations, stagedDirectory);
      const grants = await withTenantTransaction(
        database.db,
        { tenantId: TENANT_ID, userId: USER_ID, requestId: REQUEST_ID },
        (transaction) =>
          transaction
            .selectFrom("app.role_capability_grants")
            .select("capability_code")
            .where("tenant_id", "=", TENANT_ID)
            .where("role_code", "=", "department_leader")
            .orderBy("capability_code")
            .execute(),
      );

      expect(grants.map((grant) => grant.capability_code)).toEqual([
        "access_control.manage",
        "ai_runtime_config.manage",
        "audit.read",
        "management_query.execute",
        "worker_operations.manage",
      ]);
    } finally {
      await database.close();
    }
  });
});

async function copyMigrations(
  targetDirectory: string,
  include: (name: string) => boolean,
): Promise<void> {
  const filenames = (await readdir(MIGRATION_DIRECTORY))
    .filter((name) => name.endsWith(".sql") && include(name))
    .sort();
  await Promise.all(
    filenames.map((filename) =>
      copyFile(
        join(MIGRATION_DIRECTORY, filename),
        join(targetDirectory, basename(filename)),
      ),
    ),
  );
}
