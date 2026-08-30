import { fileURLToPath } from "node:url";
import { InvalidBusinessEntityListInputError } from "@battlefield/core";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { KyselyBusinessEntityReader } from "../src/business-entities/kysely-business-entity-reader.js";
import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { withTenantTransaction } from "../src/tenant-session.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const TENANT_ALPHA = "10000000-0000-4000-8000-000000000001";
const TENANT_BETA = "20000000-0000-4000-8000-000000000001";
const USER_ALPHA = "30000000-0000-4000-8000-000000000001";
const USER_BETA = "30000000-0000-4000-8000-000000000002";
const TYPE_ALPHA = "40000000-0000-4000-8000-000000000001";
const TYPE_BETA = "40000000-0000-4000-8000-000000000002";
const ENTITY_AURORA = "50000000-0000-4000-8000-000000000001";
const ENTITY_BEACON = "50000000-0000-4000-8000-000000000002";
const ENTITY_CEDAR = "50000000-0000-4000-8000-000000000003";
const ENTITY_HIDDEN = "50000000-0000-4000-8000-000000000004";
const REQUEST_ID = "90000000-0000-4000-8000-000000000001";

const actorAlpha = { tenantId: TENANT_ALPHA, userId: USER_ALPHA };

describe("KyselyBusinessEntityReader", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;
  let reader: KyselyBusinessEntityReader;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
    await seedDirectory(database);
    reader = new KyselyBusinessEntityReader(database.db, {
      requestIdFactory: () => REQUEST_ID,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("keeps tenant scope and projects current primary owner and opportunity", async () => {
    const page = await reader.list({ actor: actorAlpha, limit: 10 });
    const searchPage = await reader.list({
      actor: actorAlpha,
      search: "aUrOrA",
      limit: 10,
    });
    const archivedPage = await reader.list({
      actor: actorAlpha,
      status: "archived",
      limit: 10,
    });

    expect(page.items.map((item) => item.id)).toEqual([
      ENTITY_AURORA,
      ENTITY_BEACON,
      ENTITY_CEDAR,
    ]);
    expect(page.items.some((item) => item.id === ENTITY_HIDDEN)).toBe(false);
    expect(searchPage.items).toEqual([
      {
        id: ENTITY_AURORA,
        typeCode: "customer",
        name: "Aurora Systems",
        shortName: "Aurora",
        status: "active",
        isT0: true,
        primaryOwnerName: "销售甲",
        primaryOpportunity: {
          id: "70000000-0000-4000-8000-000000000001",
          name: "Aurora 年度平台项目",
          stageCode: "proposal",
          stageProgress: "30.00",
        },
        updatedAt: "2026-08-31T03:00:00.000Z",
        versionNo: "3",
      },
    ]);
    expect(archivedPage.items.map((item) => item.id)).toEqual([ENTITY_BEACON]);
  });

  test("paginates by updated time and id without duplicates or gaps", async () => {
    const firstPage = await reader.list({ actor: actorAlpha, limit: 2 });
    expect(firstPage.items.map((item) => item.id)).toEqual([
      ENTITY_AURORA,
      ENTITY_BEACON,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await reader.list({
      actor: actorAlpha,
      cursor: firstPage.nextCursor ?? undefined,
      limit: 2,
    });
    expect(secondPage.items.map((item) => item.id)).toEqual([ENTITY_CEDAR]);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.id))
        .size,
    ).toBe(3);
  });

  test("rejects a non-canonical or malformed cursor", async () => {
    await expect(
      reader.list({ actor: actorAlpha, cursor: "not*a*cursor", limit: 2 }),
    ).rejects.toBeInstanceOf(InvalidBusinessEntityListInputError);
  });
});

async function seedDirectory(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedTenant(database, {
    tenantId: TENANT_ALPHA,
    userId: USER_ALPHA,
    typeId: TYPE_ALPHA,
    slug: "alpha",
    userName: "销售甲",
    typeCode: "customer",
  });
  await withTenantTransaction(
    database.db,
    { ...actorAlpha, requestId: REQUEST_ID },
    async (transaction) => {
      await insertEntity(transaction, {
        entityId: ENTITY_AURORA,
        tenantId: TENANT_ALPHA,
        typeId: TYPE_ALPHA,
        name: "Aurora Systems",
        shortName: "Aurora",
        status: "active",
        isT0: true,
        versionNo: 3,
        updatedAt: "2026-08-31T03:00:00.000Z",
      });
      await insertEntity(transaction, {
        entityId: ENTITY_BEACON,
        tenantId: TENANT_ALPHA,
        typeId: TYPE_ALPHA,
        name: "Beacon Labs",
        shortName: null,
        status: "archived",
        isT0: false,
        versionNo: 2,
        updatedAt: "2026-08-31T02:00:00.000Z",
      });
      await insertEntity(transaction, {
        entityId: ENTITY_CEDAR,
        tenantId: TENANT_ALPHA,
        typeId: TYPE_ALPHA,
        name: "Cedar Works",
        shortName: "Cedar",
        status: "active",
        isT0: false,
        versionNo: 1,
        updatedAt: "2026-08-31T01:00:00.000Z",
      });
      await sql`
        insert into app.entity_assignments (
          tenant_id,
          id,
          entity_id,
          user_id,
          assignment_role,
          is_primary
        ) values (
          ${TENANT_ALPHA}::uuid,
          '60000000-0000-4000-8000-000000000001'::uuid,
          ${ENTITY_AURORA}::uuid,
          ${USER_ALPHA}::uuid,
          'owner',
          true
        )
      `.execute(transaction);
      await sql`
        insert into app.opportunities (
          tenant_id,
          id,
          entity_id,
          name,
          estimated_amount,
          currency,
          stage_code,
          stage_progress,
          status,
          is_primary
        ) values (
          ${TENANT_ALPHA}::uuid,
          '70000000-0000-4000-8000-000000000001'::uuid,
          ${ENTITY_AURORA}::uuid,
          'Aurora 年度平台项目',
          1000000,
          'CNY',
          'proposal',
          30,
          'open',
          true
        )
      `.execute(transaction);
    },
  );

  await seedTenant(database, {
    tenantId: TENANT_BETA,
    userId: USER_BETA,
    typeId: TYPE_BETA,
    slug: "beta",
    userName: "销售乙",
    typeCode: "partner",
  });
  await withTenantTransaction(
    database.db,
    { tenantId: TENANT_BETA, userId: USER_BETA, requestId: REQUEST_ID },
    (transaction) =>
      insertEntity(transaction, {
        entityId: ENTITY_HIDDEN,
        tenantId: TENANT_BETA,
        typeId: TYPE_BETA,
        name: "Hidden Tenant Entity",
        shortName: null,
        status: "active",
        isT0: true,
        versionNo: 1,
        updatedAt: "2026-08-31T04:00:00.000Z",
      }),
  );
}

async function seedTenant(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    tenantId: string;
    userId: string;
    typeId: string;
    slug: string;
    userName: string;
    typeCode: string;
  },
): Promise<void> {
  await withTenantTransaction(
    database.db,
    {
      tenantId: input.tenantId,
      userId: input.userId,
      requestId: REQUEST_ID,
    },
    async (transaction) => {
      await sql`
        insert into app.tenants (id, slug, name)
        values (${input.tenantId}::uuid, ${input.slug}, ${input.slug})
      `.execute(transaction);
      await sql`
        insert into app.users (tenant_id, id, display_name, email)
        values (
          ${input.tenantId}::uuid,
          ${input.userId}::uuid,
          ${input.userName},
          ${`${input.slug}@example.test`}
        )
      `.execute(transaction);
      await sql`
        insert into app.business_entity_types (tenant_id, id, code, name)
        values (
          ${input.tenantId}::uuid,
          ${input.typeId}::uuid,
          ${input.typeCode},
          ${input.typeCode}
        )
      `.execute(transaction);
    },
  );
}

async function insertEntity(
  transaction: Parameters<
    Parameters<typeof withTenantTransaction<BattlefieldDatabase, void>>[2]
  >[0],
  input: {
    entityId: string;
    tenantId: string;
    typeId: string;
    name: string;
    shortName: string | null;
    status: "active" | "inactive" | "archived";
    isT0: boolean;
    versionNo: number;
    updatedAt: string;
  },
): Promise<void> {
  await sql`
    insert into app.business_entities (
      tenant_id,
      id,
      type_id,
      name,
      short_name,
      status,
      is_t0,
      version_no,
      updated_at
    ) values (
      ${input.tenantId}::uuid,
      ${input.entityId}::uuid,
      ${input.typeId}::uuid,
      ${input.name},
      ${input.shortName},
      ${input.status},
      ${input.isT0},
      ${input.versionNo},
      ${input.updatedAt}::timestamptz
    )
  `.execute(transaction);
}
