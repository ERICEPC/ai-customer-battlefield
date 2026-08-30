import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseHandle } from "../src/database-handle.js";
import type { BattlefieldDatabase } from "../src/database-types.js";
import { migrateDatabase } from "../src/migrate.js";
import { createPgliteDatabase } from "../src/testing/pglite-database.js";

const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

const TENANT_ALPHA = "10000000-0000-4000-8000-000000000001";
const TENANT_BETA = "20000000-0000-4000-8000-000000000001";
const USER_ALPHA = "30000000-0000-4000-8000-000000000001";
const USER_ALPHA_SECOND = "30000000-0000-4000-8000-000000000003";
const USER_BETA = "30000000-0000-4000-8000-000000000002";
const TYPE_ALPHA = "40000000-0000-4000-8000-000000000001";
const TYPE_BETA = "40000000-0000-4000-8000-000000000002";
const ENTITY_ALPHA = "50000000-0000-4000-8000-000000000001";
const ENTITY_ALPHA_SECOND = "50000000-0000-4000-8000-000000000003";
const ENTITY_BETA = "50000000-0000-4000-8000-000000000002";
const OPPORTUNITY_ALPHA = "70000000-0000-4000-8000-000000000001";
const OPPORTUNITY_ALPHA_SECOND_ENTITY = "70000000-0000-4000-8000-000000000004";
const SOURCE_ALPHA = "80000000-0000-4000-8000-000000000001";
const DRAFT_ALPHA = "81000000-0000-4000-8000-000000000001";
const FOLLOWUP_ALPHA = "82000000-0000-4000-8000-000000000001";
const FACT_ALPHA = "83000000-0000-4000-8000-000000000001";
const RUN_ALPHA = "90000000-0000-4000-8000-000000000001";
const SIGNAL_ALPHA = "91000000-0000-4000-8000-000000000001";
const STATE_ALPHA = "92000000-0000-4000-8000-000000000001";
const PROPOSAL_ALPHA = "93000000-0000-4000-8000-000000000001";
const ACTION_ALPHA = "94000000-0000-4000-8000-000000000001";
const HISTORY_ALPHA = "95000000-0000-4000-8000-000000000001";
const INPUT_VERSION = "a".repeat(64);
const OTHER_INPUT_VERSION = "b".repeat(64);

describe("0004_battle_analysis_actions migration", () => {
  let database: DatabaseHandle<BattlefieldDatabase>;

  beforeEach(async () => {
    database = await createPgliteDatabase<BattlefieldDatabase>();
    await migrateDatabase(database.migrations, MIGRATION_DIRECTORY);
  });

  afterEach(async () => {
    await database.close();
  });

  test("creates and force-protects every battle-analysis and action table", async () => {
    const tables = [
      "action_proposals",
      "action_status_history",
      "analysis_runs",
      "battle_state_current",
      "battle_state_evidence_links",
      "battle_state_versions",
      "business_actions",
      "business_signals",
    ];
    const result = await sql<{
      protected_count: number;
      total_count: number;
    }>`
      select
        count(*) filter (where class.relrowsecurity and class.relforcerowsecurity)::int
          as protected_count,
        count(*)::int as total_count
      from pg_class as class
      inner join pg_namespace as namespace on namespace.oid = class.relnamespace
      where namespace.nspname = 'app'
        and class.relkind = 'r'
        and class.relname in (${sql.join(tables)})
    `.execute(database.db);

    expect(result.rows[0]).toEqual({ protected_count: 8, total_count: 8 });
  });

  test("rejects cross-tenant and cross-entity analysis references", async () => {
    await seedAnalysisFacts(database);

    await expect(
      insertAnalysisRun(database, {
        runId: "90000000-0000-4000-8000-000000000002",
        tenantId: TENANT_BETA,
        entityId: ENTITY_ALPHA,
        createdBy: USER_BETA,
      }),
    ).rejects.toThrow();

    await insertAnalysisRun(database);
    await expect(
      insertSignal(database, {
        signalId: "91000000-0000-4000-8000-000000000002",
        entityId: ENTITY_ALPHA_SECOND,
      }),
    ).rejects.toThrow();
    await expect(
      insertBattleState(database, {
        stateId: "92000000-0000-4000-8000-000000000002",
        primaryOpportunityId: OPPORTUNITY_ALPHA_SECOND_ENTITY,
      }),
    ).rejects.toThrow();
  });

  test("constrains analysis lifecycle metadata and exact input watermarks", async () => {
    await seedAnalysisFacts(database);

    await expect(
      insertAnalysisRun(database, {
        runId: "90000000-0000-4000-8000-000000000002",
        inputVersion: "not-a-watermark",
      }),
    ).rejects.toThrow();
    await insertAnalysisRun(database);
    await expect(
      sql`
        update app.analysis_runs
        set status = 'failed', finished_at = '2026-08-31T03:01:00.000Z'::timestamptz
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${RUN_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await completeAnalysisRun(database);
    await expect(
      insertBattleState(database, {
        stateId: "92000000-0000-4000-8000-000000000002",
        inputVersion: OTHER_INPUT_VERSION,
      }),
    ).rejects.toThrow();
  });

  test("keeps battle-state versions immutable, coherent, and uniquely numbered", async () => {
    await seedCompletedAnalysis(database);
    await insertBattleState(database);

    await expect(
      insertBattleState(database, {
        stateId: "92000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow();
    await expect(
      insertBattleState(database, {
        stateId: "92000000-0000-4000-8000-000000000003",
        versionNo: 2,
        relationshipScore: 101,
      }),
    ).rejects.toThrow();
    await expect(
      insertBattleState(database, {
        stateId: "92000000-0000-4000-8000-000000000004",
        versionNo: 2,
        dataSufficiency: "sufficient",
        relationshipScore: null,
        potentialScore: null,
        quadrantCode: null,
      }),
    ).rejects.toThrow();
    await expect(
      insertBattleState(database, {
        stateId: "92000000-0000-4000-8000-000000000005",
        versionNo: 2,
        dataSufficiency: "insufficient",
        dataGaps: [],
        relationshipScore: null,
        potentialScore: null,
        quadrantCode: null,
      }),
    ).rejects.toThrow();
    await expect(
      sql`
        update app.battle_state_versions
        set summary = 'tampered'
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${STATE_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      sql`
        delete from app.battle_state_versions
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${STATE_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
  });

  test("stores one current projection with the source version and watermark", async () => {
    await seedBattleState(database);
    await insertCurrentProjection(database);

    await expect(
      insertCurrentProjection(database, {
        stateId: "92000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toThrow();
    await expect(
      sql`
        update app.battle_state_current
        set input_version = ${OTHER_INPUT_VERSION}
        where tenant_id = ${TENANT_ALPHA}::uuid and entity_id = ${ENTITY_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      insertCurrentProjection(database, {
        entityId: ENTITY_ALPHA_SECOND,
      }),
    ).rejects.toThrow();
  });

  test("requires evidence to reference exactly one same-entity fact or signal", async () => {
    await seedBattleState(database);
    await insertSignal(database);

    await expect(
      insertEvidenceLink(database, {
        linkId: "96000000-0000-4000-8000-000000000001",
        factId: null,
        signalId: null,
      }),
    ).rejects.toThrow();
    await expect(
      insertEvidenceLink(database, {
        linkId: "96000000-0000-4000-8000-000000000002",
        factId: FACT_ALPHA,
        signalId: SIGNAL_ALPHA,
      }),
    ).rejects.toThrow();
    await insertEvidenceLink(database, {
      linkId: "96000000-0000-4000-8000-000000000003",
      factId: FACT_ALPHA,
    });
    await expect(
      insertEvidenceLink(database, {
        linkId: "96000000-0000-4000-8000-000000000004",
        factId: FACT_ALPHA,
      }),
    ).rejects.toThrow();
    await expect(
      insertEvidenceLink(database, {
        linkId: "96000000-0000-4000-8000-000000000005",
        entityId: ENTITY_ALPHA_SECOND,
        factId: FACT_ALPHA,
      }),
    ).rejects.toThrow();
  });

  test("constrains proposal expiry, versions, and terminal metadata", async () => {
    await seedBattleState(database);

    await expect(
      insertProposal(database, {
        proposalId: "93000000-0000-4000-8000-000000000002",
        expiresAt: "2026-08-31T03:00:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      insertProposal(database, {
        proposalId: "93000000-0000-4000-8000-000000000003",
        versionNo: 0,
      }),
    ).rejects.toThrow();
    await insertProposal(database);
    await expect(
      sql`
        update app.action_proposals
        set status = 'rejected', decided_at = now(), decided_by = ${USER_ALPHA}::uuid
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${PROPOSAL_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      database.db.transaction().execute(async (transaction) => {
        await sql`
          update app.action_proposals
          set status = 'accepted', decided_at = now(), decided_by = ${USER_ALPHA}::uuid,
              version_no = version_no + 1
          where tenant_id = ${TENANT_ALPHA}::uuid and id = ${PROPOSAL_ALPHA}::uuid
        `.execute(transaction);
      }),
    ).rejects.toThrow();
  });

  test("accepts a proposal atomically into exactly one same-entity formal action", async () => {
    await seedPendingProposal(database);
    await acceptProposal(database);

    const result = await sql<{
      action_count: number;
      history_count: number;
      proposal_status: string;
    }>`
      select
        (select count(*)::int from app.business_actions where tenant_id = ${TENANT_ALPHA}::uuid and source_proposal_id = ${PROPOSAL_ALPHA}::uuid) as action_count,
        (select count(*)::int from app.action_status_history where tenant_id = ${TENANT_ALPHA}::uuid and action_id = ${ACTION_ALPHA}::uuid) as history_count,
        (select status from app.action_proposals where tenant_id = ${TENANT_ALPHA}::uuid and id = ${PROPOSAL_ALPHA}::uuid) as proposal_status
    `.execute(database.db);

    expect(result.rows[0]).toEqual({
      action_count: 1,
      history_count: 1,
      proposal_status: "accepted",
    });
    await expect(
      database.db.transaction().execute(async (transaction) => {
        await insertAction(transaction, {
          actionId: "94000000-0000-4000-8000-000000000002",
        });
        await insertActionHistory(transaction, {
          historyId: "95000000-0000-4000-8000-000000000002",
          actionId: "94000000-0000-4000-8000-000000000002",
        });
      }),
    ).rejects.toThrow();
  });

  test("rejects cross-tenant owners, cross-entity opportunities, and invalid action time", async () => {
    await seedPendingProposal(database);

    await expect(
      acceptProposal(database, { ownerUserId: USER_BETA }),
    ).rejects.toThrow();
    await expect(
      acceptProposal(database, {
        opportunityId: OPPORTUNITY_ALPHA_SECOND_ENTITY,
      }),
    ).rejects.toThrow();
    await expect(
      acceptProposal(database, {
        plannedAt: "2026-08-31T03:04:00.000Z",
      }),
    ).rejects.toThrow();
  });

  test("requires coherent completion metadata and immutable valid status history", async () => {
    await seedAcceptedAction(database);

    await expect(
      sql`
        update app.business_actions
        set status = 'completed', version_no = 2
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${ACTION_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
    await expect(
      database.db.transaction().execute(async (transaction) => {
        await sql`
          update app.business_actions
          set status = 'completed', completed_at = '2026-09-01T11:00:00.000Z'::timestamptz,
              version_no = 2, updated_at = '2026-09-01T11:00:00.000Z'::timestamptz
          where tenant_id = ${TENANT_ALPHA}::uuid and id = ${ACTION_ALPHA}::uuid
        `.execute(transaction);
        await insertActionHistory(transaction, {
          historyId: "95000000-0000-4000-8000-000000000002",
          versionNo: 2,
          fromStatus: "planned",
          toStatus: "completed",
        });
      }),
    ).rejects.toThrow();
    await transitionAction(database, "in_progress", 2);
    await transitionAction(database, "completed", 3);
    await expect(
      sql`
        update app.action_status_history
        set reason = 'tampered'
        where tenant_id = ${TENANT_ALPHA}::uuid and id = ${HISTORY_ALPHA}::uuid
      `.execute(database.db),
    ).rejects.toThrow();
  });
});

type SqlExecutor = Pick<
  DatabaseHandle<BattlefieldDatabase>["db"],
  "executeQuery"
>;

async function seedAnalysisFacts(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedTenant(database, {
    tenantId: TENANT_ALPHA,
    userId: USER_ALPHA,
    typeId: TYPE_ALPHA,
    entityId: ENTITY_ALPHA,
    slug: "alpha",
  });
  await sql`
    insert into app.users (tenant_id, id, display_name)
    values (${TENANT_ALPHA}::uuid, ${USER_ALPHA_SECOND}::uuid, 'alpha-second-user')
  `.execute(database.db);
  await sql`
    insert into app.business_entities (tenant_id, id, type_id, name)
    values (${TENANT_ALPHA}::uuid, ${ENTITY_ALPHA_SECOND}::uuid, ${TYPE_ALPHA}::uuid, 'alpha-second-entity')
  `.execute(database.db);
  await insertOpportunity(
    database.db,
    TENANT_ALPHA,
    OPPORTUNITY_ALPHA,
    ENTITY_ALPHA,
    "alpha-opportunity",
  );
  await insertOpportunity(
    database.db,
    TENANT_ALPHA,
    OPPORTUNITY_ALPHA_SECOND_ENTITY,
    ENTITY_ALPHA_SECOND,
    "other-entity-opportunity",
  );
  await seedTenant(database, {
    tenantId: TENANT_BETA,
    userId: USER_BETA,
    typeId: TYPE_BETA,
    entityId: ENTITY_BETA,
    slug: "beta",
  });
  await seedConfirmedFact(database);
}

async function seedTenant(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    tenantId: string;
    userId: string;
    typeId: string;
    entityId: string;
    slug: string;
  },
): Promise<void> {
  await sql`
    insert into app.tenants (id, slug, name)
    values (${input.tenantId}::uuid, ${input.slug}, ${input.slug})
  `.execute(database.db);
  await sql`
    insert into app.users (tenant_id, id, display_name)
    values (${input.tenantId}::uuid, ${input.userId}::uuid, ${`${input.slug}-user`})
  `.execute(database.db);
  await sql`
    insert into app.business_entity_types (tenant_id, id, code, name)
    values (${input.tenantId}::uuid, ${input.typeId}::uuid, 'customer', '客户')
  `.execute(database.db);
  await sql`
    insert into app.business_entities (tenant_id, id, type_id, name)
    values (${input.tenantId}::uuid, ${input.entityId}::uuid, ${input.typeId}::uuid, ${`${input.slug}-entity`})
  `.execute(database.db);
}

async function insertOpportunity(
  executor: SqlExecutor,
  tenantId: string,
  opportunityId: string,
  entityId: string,
  name: string,
): Promise<void> {
  await sql`
    insert into app.opportunities (
      tenant_id, id, entity_id, name, stage_code, stage_progress
    ) values (
      ${tenantId}::uuid, ${opportunityId}::uuid, ${entityId}::uuid,
      ${name}, 'qualification', 20
    )
  `.execute(executor);
}

async function seedConfirmedFact(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`
    insert into app.source_inputs (
      tenant_id, id, source_type, submitted_by, raw_content, content_hash,
      received_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${SOURCE_ALPHA}::uuid, 'web', ${USER_ALPHA}::uuid,
      '客户确认预算', repeat('c', 64), '2026-08-31T02:30:00.000Z'::timestamptz
    )
  `.execute(database.db);
  await sql`
    insert into app.followup_drafts (
      tenant_id, id, source_input_id, entity_id, status, candidate_payload,
      created_by, expires_at, confirmed_at, confirmed_by
    ) values (
      ${TENANT_ALPHA}::uuid, ${DRAFT_ALPHA}::uuid, ${SOURCE_ALPHA}::uuid,
      ${ENTITY_ALPHA}::uuid, 'confirmed', '{}'::jsonb, ${USER_ALPHA}::uuid,
      '2026-09-07T02:30:00.000Z'::timestamptz,
      '2026-08-31T02:35:00.000Z'::timestamptz, ${USER_ALPHA}::uuid
    )
  `.execute(database.db);
  await sql`
    insert into app.followups (
      tenant_id, id, entity_id, source_input_id, source_draft_id, occurred_at,
      followup_type, summary, submitted_by, confirmed_by, confirmed_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${FOLLOWUP_ALPHA}::uuid, ${ENTITY_ALPHA}::uuid,
      ${SOURCE_ALPHA}::uuid, ${DRAFT_ALPHA}::uuid,
      '2026-08-31T02:30:00.000Z'::timestamptz, 'meeting', '客户确认预算',
      ${USER_ALPHA}::uuid, ${USER_ALPHA}::uuid,
      '2026-08-31T02:35:00.000Z'::timestamptz
    )
  `.execute(database.db);
  await sql`
    insert into app.business_facts (
      tenant_id, id, entity_id, opportunity_id, followup_id, fact_type,
      fact_value, occurred_at, confirmed_at, confirmed_by
    ) values (
      ${TENANT_ALPHA}::uuid, ${FACT_ALPHA}::uuid, ${ENTITY_ALPHA}::uuid,
      ${OPPORTUNITY_ALPHA}::uuid, ${FOLLOWUP_ALPHA}::uuid, 'budget_status',
      '预算已确认', '2026-08-31T02:30:00.000Z'::timestamptz,
      '2026-08-31T02:35:00.000Z'::timestamptz, ${USER_ALPHA}::uuid
    )
  `.execute(database.db);
}

async function insertAnalysisRun(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    runId?: string;
    tenantId?: string;
    entityId?: string;
    createdBy?: string;
    inputVersion?: string;
  } = {},
): Promise<void> {
  await sql`
    insert into app.analysis_runs (
      tenant_id, id, entity_id, rule_version, analyzer_config_version,
      input_version, status, started_at, created_by
    ) values (
      ${input.tenantId ?? TENANT_ALPHA}::uuid,
      ${input.runId ?? RUN_ALPHA}::uuid,
      ${input.entityId ?? ENTITY_ALPHA}::uuid,
      'rules-v1', 'deterministic-v1', ${input.inputVersion ?? INPUT_VERSION},
      'running', '2026-08-31T03:00:00.000Z'::timestamptz,
      ${input.createdBy ?? USER_ALPHA}::uuid
    )
  `.execute(database.db);
}

async function completeAnalysisRun(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await sql`
    update app.analysis_runs
    set status = 'completed', finished_at = '2026-08-31T03:01:00.000Z'::timestamptz
    where tenant_id = ${TENANT_ALPHA}::uuid and id = ${RUN_ALPHA}::uuid
  `.execute(database.db);
}

async function seedCompletedAnalysis(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedAnalysisFacts(database);
  await insertAnalysisRun(database);
  await completeAnalysisRun(database);
}

async function insertSignal(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: { signalId?: string; entityId?: string } = {},
): Promise<void> {
  await sql`
    insert into app.business_signals (
      tenant_id, id, entity_id, fact_id, analysis_run_id, dimension, direction,
      strength, reason, created_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.signalId ?? SIGNAL_ALPHA}::uuid,
      ${input.entityId ?? ENTITY_ALPHA}::uuid, ${FACT_ALPHA}::uuid,
      ${RUN_ALPHA}::uuid, 'potential', 'positive', 85, '预算已确认',
      '2026-08-31T03:01:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertBattleState(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    stateId?: string;
    entityId?: string;
    versionNo?: number;
    inputVersion?: string;
    relationshipScore?: number | null;
    potentialScore?: number | null;
    quadrantCode?: string | null;
    primaryOpportunityId?: string | null;
    dataSufficiency?: string;
    dataGaps?: string[];
  } = {},
): Promise<void> {
  await sql`
    insert into app.battle_state_versions (
      tenant_id, id, entity_id, version_no, input_version,
      relationship_score, potential_score, quadrant_code,
      primary_opportunity_id, risk_level, data_sufficiency, data_gaps, summary,
      analysis_run_id, effective_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.stateId ?? STATE_ALPHA}::uuid,
      ${input.entityId ?? ENTITY_ALPHA}::uuid, ${input.versionNo ?? 1},
      ${input.inputVersion ?? INPUT_VERSION},
      ${input.relationshipScore === undefined ? 70 : input.relationshipScore},
      ${input.potentialScore === undefined ? 90 : input.potentialScore},
      ${input.quadrantCode === undefined ? "strategic" : input.quadrantCode},
      ${input.primaryOpportunityId === undefined ? OPPORTUNITY_ALPHA : input.primaryOpportunityId}::uuid,
      'medium', ${input.dataSufficiency ?? "sufficient"},
      ${JSON.stringify(input.dataGaps ?? [])}::jsonb,
      '关系稳固且潜力较高', ${RUN_ALPHA}::uuid,
      '2026-08-31T03:01:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function seedBattleState(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedCompletedAnalysis(database);
  await insertBattleState(database);
}

async function insertCurrentProjection(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: { entityId?: string; stateId?: string } = {},
): Promise<void> {
  await sql`
    insert into app.battle_state_current (
      tenant_id, entity_id, battle_state_version_id, version_no, input_version,
      updated_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.entityId ?? ENTITY_ALPHA}::uuid,
      ${input.stateId ?? STATE_ALPHA}::uuid, 1, ${INPUT_VERSION},
      '2026-08-31T03:01:00.000Z'::timestamptz
    )
  `.execute(database.db);
}

async function insertEvidenceLink(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    linkId: string;
    entityId?: string;
    factId?: string | null;
    signalId?: string | null;
  },
): Promise<void> {
  await sql`
    insert into app.battle_state_evidence_links (
      tenant_id, id, entity_id, battle_state_version_id, fact_id, signal_id,
      contribution
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.linkId}::uuid,
      ${input.entityId ?? ENTITY_ALPHA}::uuid, ${STATE_ALPHA}::uuid,
      ${input.factId ?? null}::uuid, ${input.signalId ?? null}::uuid,
      '该事实支撑当前判断'
    )
  `.execute(database.db);
}

async function insertProposal(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    proposalId?: string;
    versionNo?: number;
    expiresAt?: string;
  } = {},
): Promise<void> {
  await sql`
    insert into app.action_proposals (
      tenant_id, id, entity_id, opportunity_id, title, description,
      suggested_owner_id, suggested_priority, suggested_planned_at,
      source_battle_state_version_id, status, version_no, proposed_at,
      expires_at
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.proposalId ?? PROPOSAL_ALPHA}::uuid,
      ${ENTITY_ALPHA}::uuid, ${OPPORTUNITY_ALPHA}::uuid, '确认下一次高层沟通',
      '与客户高层确认项目优先级', ${USER_ALPHA}::uuid, 'high',
      '2026-09-02T09:00:00.000Z'::timestamptz, ${STATE_ALPHA}::uuid,
      'pending_confirmation', ${input.versionNo ?? 1},
      '2026-08-31T03:02:00.000Z'::timestamptz,
      ${input.expiresAt ?? "2026-09-07T03:02:00.000Z"}::timestamptz
    )
  `.execute(database.db);
}

async function seedPendingProposal(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedBattleState(database);
  await insertProposal(database);
}

async function insertAction(
  executor: SqlExecutor,
  input: {
    actionId?: string;
    ownerUserId?: string;
    opportunityId?: string | null;
    plannedAt?: string;
  } = {},
): Promise<void> {
  await sql`
    insert into app.business_actions (
      tenant_id, id, entity_id, opportunity_id, title, description,
      owner_user_id, priority, status, planned_at, source_proposal_id,
      confirmed_by, confirmed_at, version_no
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.actionId ?? ACTION_ALPHA}::uuid,
      ${ENTITY_ALPHA}::uuid,
      ${input.opportunityId === undefined ? OPPORTUNITY_ALPHA : input.opportunityId}::uuid,
      '确认下一次高层沟通', '与客户高层确认项目优先级',
      ${input.ownerUserId ?? USER_ALPHA}::uuid, 'high', 'planned',
      ${input.plannedAt ?? "2026-09-02T09:00:00.000Z"}::timestamptz,
      ${PROPOSAL_ALPHA}::uuid, ${USER_ALPHA}::uuid,
      '2026-08-31T03:05:00.000Z'::timestamptz, 1
    )
  `.execute(executor);
}

async function insertActionHistory(
  executor: SqlExecutor,
  input: {
    historyId?: string;
    actionId?: string;
    versionNo?: number;
    fromStatus?: string | null;
    toStatus?: string;
  } = {},
): Promise<void> {
  await sql`
    insert into app.action_status_history (
      tenant_id, id, action_id, from_status, to_status, changed_by, reason,
      changed_at, version_no
    ) values (
      ${TENANT_ALPHA}::uuid, ${input.historyId ?? HISTORY_ALPHA}::uuid,
      ${input.actionId ?? ACTION_ALPHA}::uuid, ${input.fromStatus ?? null},
      ${input.toStatus ?? "planned"}, ${USER_ALPHA}::uuid, '人工确认建议动作',
      '2026-08-31T03:05:00.000Z'::timestamptz, ${input.versionNo ?? 1}
    )
  `.execute(executor);
}

async function acceptProposal(
  database: DatabaseHandle<BattlefieldDatabase>,
  input: {
    ownerUserId?: string;
    opportunityId?: string | null;
    plannedAt?: string;
  } = {},
): Promise<void> {
  await database.db.transaction().execute(async (transaction) => {
    await sql`
      update app.action_proposals
      set status = 'accepted', decided_at = '2026-08-31T03:05:00.000Z'::timestamptz,
          decided_by = ${USER_ALPHA}::uuid, version_no = 2
      where tenant_id = ${TENANT_ALPHA}::uuid and id = ${PROPOSAL_ALPHA}::uuid
    `.execute(transaction);
    await insertAction(transaction, input);
    await insertActionHistory(transaction);
  });
}

async function seedAcceptedAction(
  database: DatabaseHandle<BattlefieldDatabase>,
): Promise<void> {
  await seedPendingProposal(database);
  await acceptProposal(database);
}

async function transitionAction(
  database: DatabaseHandle<BattlefieldDatabase>,
  toStatus: "in_progress" | "completed",
  versionNo: number,
): Promise<void> {
  await database.db.transaction().execute(async (transaction) => {
    const fromStatus = toStatus === "in_progress" ? "planned" : "in_progress";
    const completedAt =
      toStatus === "completed" ? "2026-09-01T11:00:00.000Z" : null;
    await sql`
      update app.business_actions
      set status = ${toStatus}, completed_at = ${completedAt}::timestamptz,
          version_no = ${versionNo}, updated_at = '2026-09-01T11:00:00.000Z'::timestamptz
      where tenant_id = ${TENANT_ALPHA}::uuid and id = ${ACTION_ALPHA}::uuid
    `.execute(transaction);
    await insertActionHistory(transaction, {
      historyId:
        versionNo === 2
          ? "95000000-0000-4000-8000-000000000002"
          : "95000000-0000-4000-8000-000000000003",
      versionNo,
      fromStatus,
      toStatus,
    });
  });
}
