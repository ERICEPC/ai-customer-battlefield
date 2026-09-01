import { createHash, randomUUID } from "node:crypto";
import {
  BattleRuleAccessDeniedError,
  type BattleRuleManager,
  BattleRuleReleaseNotFoundError,
  type BattleRuleResolver,
  type BattleRuleSet,
  BattleRuleVersionNotFoundError,
  type BattleRuleVersionPage,
  type BattleRuleVersionRecord,
  InvalidBattleRuleCursorError,
  InvalidBattleRuleManagementInputError,
  parseBattleRuleSet,
  type ReleasedBattleRule,
  type ResolvedBattleRule,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import { appendAuditEntry } from "../audit/append-audit-entry.js";
import { actorHasManagementCapability } from "../authorization/management-capabilities.js";
import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface VersionCursor {
  versionNo: string;
  id: string;
}

export interface KyselyBattleRuleStoreOptions {
  requestIdFactory?: () => string;
}

export class KyselyBattleRuleStore
  implements BattleRuleResolver, BattleRuleManager
{
  private readonly requestIdFactory: () => string;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyBattleRuleStoreOptions = {},
  ) {
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async resolve(
    input: Parameters<BattleRuleResolver["resolve"]>[0],
  ): Promise<ResolvedBattleRule> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const row = await transaction
          .selectFrom("app.battle_rule_releases as release")
          .innerJoin("app.battle_rule_versions as version", (join) =>
            join
              .onRef("version.tenant_id", "=", "release.tenant_id")
              .onRef("version.id", "=", "release.version_id"),
          )
          .select(["version.version_no", "version.rules", "release.release_no"])
          .where("release.tenant_id", "=", input.actor.tenantId)
          .executeTakeFirst();
        if (!row) throw new BattleRuleReleaseNotFoundError();
        return {
          ruleVersion: ruleVersion(row.version_no, row.release_no),
          rules: decodeBattleRuleSet(row.rules),
        };
      },
    );
  }

  async listVersions(
    input: Parameters<BattleRuleManager["listVersions"]>[0],
  ): Promise<BattleRuleVersionPage> {
    if (!validLimit(input.limit)) {
      throw new InvalidBattleRuleManagementInputError();
    }
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        await assertManager(transaction, input.actor);
        let query = transaction
          .selectFrom("app.battle_rule_versions")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId);
        if (cursor) {
          query = query.where(
            sql<boolean>`(version_no, id) < (${cursor.versionNo}::bigint, ${cursor.id}::uuid)`,
          );
        }
        const rows = await query
          .orderBy("version_no", "desc")
          .orderBy("id", "desc")
          .limit(input.limit + 1)
          .execute();
        const release = await transaction
          .selectFrom("app.battle_rule_releases")
          .select(["version_id", "release_no"])
          .where("tenant_id", "=", input.actor.tenantId)
          .executeTakeFirst();
        if (!release) throw new BattleRuleReleaseNotFoundError();
        const hasNextPage = rows.length > input.limit;
        const pageRows = rows.slice(0, input.limit);
        const last = pageRows.at(-1);
        return {
          items: pageRows.map(mapVersion),
          currentVersionId: release.version_id,
          currentReleaseNo: String(release.release_no),
          nextCursor:
            hasNextPage && last
              ? encodeCursor({
                  versionNo: String(last.version_no),
                  id: last.id,
                })
              : null,
        };
      },
    );
  }

  async createVersion(
    input: Parameters<BattleRuleManager["createVersion"]>[0],
  ): Promise<BattleRuleVersionRecord> {
    const normalized = normalizeVersionInput(input);
    const requestId = this.requestIdFactory();
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        await assertManager(transaction, input.actor);
        await lockRules(transaction, input.actor.tenantId);
        const fingerprint = fingerprintVersion(normalized);
        const existing = await transaction
          .selectFrom("app.battle_rule_versions")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("content_fingerprint", "=", fingerprint)
          .executeTakeFirst();
        if (existing) return mapVersion(existing);
        const latest = await transaction
          .selectFrom("app.battle_rule_versions")
          .select("version_no")
          .where("tenant_id", "=", input.actor.tenantId)
          .orderBy("version_no", "desc")
          .limit(1)
          .executeTakeFirst();
        const createdAt = await currentTimestamp(transaction);
        const created = await transaction
          .insertInto("app.battle_rule_versions")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            version_no: BigInt(String(latest?.version_no ?? 0)) + 1n,
            name: normalized.name,
            rules: JSON.stringify(normalized.rules),
            content_fingerprint: fingerprint,
            created_by: input.actor.userId,
            created_at: createdAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await appendAuditEntry(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "battle_rule",
          aggregateId: created.id,
          action: "battle_rule.version_created",
          occurredAt: createdAt.toISOString(),
          requestId,
          afterPayload: {
            versionNo: String(created.version_no),
            contentFingerprint: fingerprint,
          },
        });
        return mapVersion(created);
      },
    );
  }

  async releaseVersion(
    input: Parameters<BattleRuleManager["releaseVersion"]>[0],
  ): Promise<ReleasedBattleRule> {
    const reason = input.reason.trim();
    if (
      !validUuid(input.versionId) ||
      reason.length < 1 ||
      reason.length > 1_000
    ) {
      throw new InvalidBattleRuleManagementInputError();
    }
    const requestId = this.requestIdFactory();
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        await assertManager(transaction, input.actor);
        await lockRules(transaction, input.actor.tenantId);
        const target = await transaction
          .selectFrom("app.battle_rule_versions")
          .selectAll()
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.versionId)
          .executeTakeFirst();
        if (!target) throw new BattleRuleVersionNotFoundError();
        decodeBattleRuleSet(target.rules);
        const current = await transaction
          .selectFrom("app.battle_rule_releases as release")
          .innerJoin("app.battle_rule_versions as version", (join) =>
            join
              .onRef("version.tenant_id", "=", "release.tenant_id")
              .onRef("version.id", "=", "release.version_id"),
          )
          .select([
            "release.version_id",
            "release.release_no",
            "release.released_at",
            "version.version_no as current_version_no",
          ])
          .where("release.tenant_id", "=", input.actor.tenantId)
          .executeTakeFirst();
        if (!current) throw new BattleRuleReleaseNotFoundError();
        if (current.version_id === target.id) {
          return mapReleased(target, {
            releaseNo: String(current.release_no),
            releasedAt: current.released_at,
          });
        }
        const releaseNo = BigInt(String(current.release_no)) + 1n;
        const releasedAt = await currentTimestamp(transaction);
        await transaction
          .updateTable("app.battle_rule_releases")
          .set({
            version_id: target.id,
            release_no: releaseNo,
            released_by: input.actor.userId,
            released_at: releasedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.battle_rule_release_history")
          .values({
            tenant_id: input.actor.tenantId,
            id: randomUUID(),
            release_no: releaseNo,
            version_id: target.id,
            released_by: input.actor.userId,
            released_at: releasedAt,
            reason,
          })
          .executeTakeFirstOrThrow();
        const rolledBack =
          BigInt(String(target.version_no)) <
          BigInt(String(current.current_version_no));
        await appendAuditEntry(transaction, {
          tenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          aggregateType: "battle_rule",
          aggregateId: target.id,
          action: rolledBack
            ? "battle_rule.rolled_back"
            : "battle_rule.released",
          occurredAt: releasedAt.toISOString(),
          requestId,
          beforePayload: {
            versionId: current.version_id,
            releaseNo: String(current.release_no),
          },
          afterPayload: {
            versionId: target.id,
            versionNo: String(target.version_no),
            releaseNo: String(releaseNo),
          },
          reason,
        });
        return mapReleased(target, {
          releaseNo: String(releaseNo),
          releasedAt,
        });
      },
    );
  }
}

export function decodeBattleRuleSet(value: unknown): BattleRuleSet {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return parseBattleRuleSet(null);
    }
  }
  return parseBattleRuleSet(decoded);
}

function normalizeVersionInput(
  input: Parameters<BattleRuleManager["createVersion"]>[0],
): { name: string; rules: BattleRuleSet } {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) {
    throw new InvalidBattleRuleManagementInputError();
  }
  return { name, rules: canonicalRules(parseBattleRuleSet(input.rules)) };
}

function canonicalRules(rules: BattleRuleSet): BattleRuleSet {
  return {
    ...rules,
    stageLabels: Object.fromEntries(
      Object.entries(rules.stageLabels).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    ),
  };
}

function fingerprintVersion(input: { name: string; rules: BattleRuleSet }) {
  return createHash("sha256")
    .update(JSON.stringify({ name: input.name, rules: input.rules }))
    .digest("hex");
}

function mapVersion(row: {
  id: string;
  version_no: string | number | bigint;
  name: string;
  rules: unknown;
  content_fingerprint: string;
  created_by: string | null;
  created_at: Date | string;
}): BattleRuleVersionRecord {
  return {
    versionId: row.id,
    versionNo: String(row.version_no),
    name: row.name,
    rules: decodeBattleRuleSet(row.rules),
    contentFingerprint: row.content_fingerprint,
    createdBy: row.created_by,
    createdAt: isoString(row.created_at),
  };
}

function mapReleased(
  row: Parameters<typeof mapVersion>[0],
  release: { releaseNo: string; releasedAt: Date | string },
): ReleasedBattleRule {
  const version = mapVersion(row);
  return {
    versionId: version.versionId,
    versionNo: version.versionNo,
    releaseNo: release.releaseNo,
    ruleVersion: ruleVersion(version.versionNo, release.releaseNo),
    name: version.name,
    rules: version.rules,
    releasedAt: isoString(release.releasedAt),
  };
}

async function assertManager(
  transaction: DatabaseTransaction,
  actor: { tenantId: string; userId: string },
): Promise<void> {
  if (
    !(await actorHasManagementCapability(
      transaction,
      actor,
      "business_rules.manage",
    ))
  ) {
    throw new BattleRuleAccessDeniedError();
  }
}

async function lockRules(
  transaction: DatabaseTransaction,
  tenantId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:battle-rules`}))`.execute(
    transaction,
  );
}

async function currentTimestamp(transaction: DatabaseTransaction) {
  const row = await sql<{ now: Date }>`select current_timestamp as now`.execute(
    transaction,
  );
  const now = row.rows[0]?.now;
  if (!now) throw new InvalidBattleRuleManagementInputError();
  return now;
}

function isoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidBattleRuleManagementInputError();
  }
  return date.toISOString();
}

function ruleVersion(
  versionNo: string | number | bigint,
  releaseNo: string | number | bigint,
) {
  return `battle-rules-v${String(versionNo)}-r${String(releaseNo)}`;
}

function validLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 100;
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function encodeCursor(cursor: VersionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): VersionCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("non-canonical encoding");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "id,versionNo"
    ) {
      throw new Error("invalid payload");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.versionNo !== "string" ||
      !/^[1-9][0-9]*$/.test(candidate.versionNo) ||
      typeof candidate.id !== "string" ||
      !validUuid(candidate.id)
    ) {
      throw new Error("invalid values");
    }
    return { versionNo: candidate.versionNo, id: candidate.id };
  } catch (error) {
    throw new InvalidBattleRuleCursorError({ cause: error });
  }
}
