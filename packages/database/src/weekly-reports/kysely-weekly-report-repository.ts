import { createHash, randomUUID } from "node:crypto";
import {
  InvalidWeeklyReportCursorError,
  type WeeklyReportDetail,
  WeeklyReportIdempotencyConflictError,
  WeeklyReportNotFoundError,
  type WeeklyReportRepository,
  WeeklyReportResultLimitExceededError,
  WeeklyReportScopeConflictError,
  type WeeklyReportStatus,
  type WeeklyReportType,
  WeeklyReportVersionConflictError,
} from "@battlefield/core";
import { type Kysely, sql, type Transaction } from "kysely";

import type { BattlefieldDatabase } from "../database-types.js";
import { withTenantTransaction } from "../tenant-session.js";
import {
  type WeeklyProgressEntityProjection as EntityProjection,
  projectWeeklyProgress,
  type WeeklyProgressEvidence as ReportEvidence,
  type WeeklyProgressProjection as WeeklyProjection,
} from "../weekly-progress/weekly-progress-projection.js";

type DatabaseTransaction = Transaction<BattlefieldDatabase>;

interface ScopeEntityRow {
  entity_id: string;
  entity_name: string;
}

interface ContributorRow {
  entity_id: string;
  user_id: string;
  display_name: string;
}

interface IdempotencyRow {
  request_hash: string;
  status: "in_progress" | "completed";
  response_payload: Record<string, unknown> | null;
}

interface WeeklyReportCursor {
  createdAt: string;
  versionId: string;
}

export interface KyselyWeeklyReportRepositoryOptions {
  reportIdFactory?: () => string;
  versionIdFactory?: () => string;
  itemIdFactory?: () => string;
  requestIdFactory?: () => string;
  eventIdFactory?: () => string;
  outboxIdFactory?: () => string;
  maxScopedEntities?: number;
  maxEventRowsPerKind?: number;
}

const DEFAULT_MAX_SCOPED_ENTITIES = 500;
const DEFAULT_MAX_EVENT_ROWS_PER_KIND = 5_000;

export class KyselyWeeklyReportRepository implements WeeklyReportRepository {
  private readonly reportIdFactory: () => string;
  private readonly versionIdFactory: () => string;
  private readonly itemIdFactory: () => string;
  private readonly requestIdFactory: () => string;
  private readonly eventIdFactory: () => string;
  private readonly outboxIdFactory: () => string;
  private readonly maxScopedEntities: number;
  private readonly maxEventRowsPerKind: number;

  constructor(
    private readonly database: Kysely<BattlefieldDatabase>,
    options: KyselyWeeklyReportRepositoryOptions = {},
  ) {
    this.reportIdFactory = options.reportIdFactory ?? randomUUID;
    this.versionIdFactory = options.versionIdFactory ?? randomUUID;
    this.itemIdFactory = options.itemIdFactory ?? randomUUID;
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.eventIdFactory = options.eventIdFactory ?? randomUUID;
    this.outboxIdFactory = options.outboxIdFactory ?? randomUUID;
    this.maxScopedEntities = positiveLimit(
      options.maxScopedEntities ?? DEFAULT_MAX_SCOPED_ENTITIES,
    );
    this.maxEventRowsPerKind = positiveLimit(
      options.maxEventRowsPerKind ?? DEFAULT_MAX_EVENT_ROWS_PER_KIND,
    );
  }

  async generate(input: {
    actor: { tenantId: string; userId: string };
    idempotencyKey: string;
    reportType: WeeklyReportType;
    periodStart: string;
    periodEnd: string;
    generatedAt: string;
    dataCutoffAt: string;
  }): Promise<WeeklyReportDetail> {
    const requestId = this.requestIdFactory();
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        const entities = await this.resolveScope(transaction, input);
        if (entities.length === 0) throw new WeeklyReportNotFoundError();
        if (entities.length > this.maxScopedEntities) {
          throw new WeeklyReportResultLimitExceededError();
        }
        const contributors = await this.resolveContributors(
          transaction,
          input,
          entities.map((entity) => entity.entity_id),
        );
        const scopeFingerprint = fingerprintScope(
          input,
          entities,
          contributors,
        );
        const requestHash = hashJson({
          actorTenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          dataCutoffAt: input.dataCutoffAt,
          periodEnd: input.periodEnd,
          periodStart: input.periodStart,
          reportType: input.reportType,
          scopeFingerprint,
        });
        const replay = await beginIdempotency(transaction, {
          operation: "weekly_report.generate",
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          startedAt: input.generatedAt,
        });
        if (replay) return replay;

        const projection = await projectWeeklyProgress(transaction, {
          tenantId: input.actor.tenantId,
          entities,
          actionOwnerUserIds: [
            ...new Set(contributors.map((contributor) => contributor.user_id)),
          ],
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          dataCutoffAt: input.dataCutoffAt,
          maxEventRowsPerKind: this.maxEventRowsPerKind,
          assertRowLimit: assertResultRowLimit,
        });
        const reportId = this.reportIdFactory();
        const versionId = this.versionIdFactory();
        const title =
          input.reportType === "personal" ? "个人周报" : "管理范围周报";
        const scopeLabel =
          input.reportType === "personal" ? "本人责任范围" : "当前管理关注范围";
        const contributorIds = new Set(
          contributors.map((contributor) => contributor.user_id),
        );
        const contributorMap = groupContributors(contributors);

        const insertedReport = await transaction
          .insertInto("app.weekly_reports")
          .values({
            tenant_id: input.actor.tenantId,
            id: reportId,
            report_type: input.reportType,
            owner_user_id: input.actor.userId,
            subject_user_id:
              input.reportType === "personal" ? input.actor.userId : null,
            period_start: input.periodStart,
            period_end: input.periodEnd,
            created_by: input.actor.userId,
            created_at: input.generatedAt,
          })
          .onConflict((conflict) =>
            conflict
              .columns([
                "tenant_id",
                "report_type",
                "owner_user_id",
                "period_start",
                "period_end",
              ])
              .doNothing(),
          )
          .returning("id")
          .executeTakeFirst();
        if (!insertedReport) {
          const existing = await transaction
            .selectFrom("app.weekly_reports as report")
            .innerJoin("app.weekly_report_versions as version", (join) =>
              join
                .onRef("version.tenant_id", "=", "report.tenant_id")
                .onRef("version.report_id", "=", "report.id"),
            )
            .select([
              "version.id as version_id",
              "version.data_cutoff_at",
              "version.scope_fingerprint",
            ])
            .where("report.tenant_id", "=", input.actor.tenantId)
            .where("report.report_type", "=", input.reportType)
            .where("report.owner_user_id", "=", input.actor.userId)
            .where("report.period_start", "=", new Date(input.periodStart))
            .where("report.period_end", "=", new Date(input.periodEnd))
            .orderBy("version.revision_no", "desc")
            .limit(1)
            .executeTakeFirstOrThrow();
          if (existing.scope_fingerprint !== scopeFingerprint) {
            throw new WeeklyReportScopeConflictError();
          }
          if (toIso(existing.data_cutoff_at) !== toIso(input.dataCutoffAt)) {
            throw new WeeklyReportVersionConflictError();
          }
          const existingResult = await readDetail(transaction, {
            actor: input.actor,
            versionId: existing.version_id,
          });
          await completeIdempotency(transaction, {
            operation: "weekly_report.generate",
            tenantId: input.actor.tenantId,
            idempotencyKey: input.idempotencyKey,
            completedAt: input.generatedAt,
            versionId: existing.version_id,
            result: existingResult,
          });
          return existingResult;
        }
        await transaction
          .insertInto("app.weekly_report_versions")
          .values({
            tenant_id: input.actor.tenantId,
            id: versionId,
            report_id: reportId,
            revision_no: 1,
            lock_version: 1,
            status: "in_review",
            data_cutoff_at: input.dataCutoffAt,
            title,
            note: "",
            scope_fingerprint: scopeFingerprint,
            scope_entity_count: entities.length,
            contributor_count: contributorIds.size,
            confirmed_followup_count: projection.metrics.confirmedFollowupCount,
            valid_fact_count: projection.metrics.validFactCount,
            stage_change_count: projection.metrics.stageChangeCount,
            completed_action_count: projection.metrics.completedActionCount,
            open_action_count: projection.metrics.openActionCount,
            overdue_action_count: projection.metrics.overdueActionCount,
            generator_kind: "deterministic",
            generator_version: "weekly-progress-v1",
            previous_version_id: null,
            created_by: input.actor.userId,
            created_at: input.generatedAt,
            published_by: null,
            published_at: null,
            updated_at: input.generatedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.weekly_report_scope_entities")
          .values(
            entities.map((entity, index) => ({
              tenant_id: input.actor.tenantId,
              report_version_id: versionId,
              entity_id: entity.entity_id,
              sort_order: index,
              created_at: input.generatedAt,
            })),
          )
          .execute();
        await transaction
          .insertInto("app.weekly_report_audiences")
          .values([
            {
              tenant_id: input.actor.tenantId,
              report_version_id: versionId,
              user_id: input.actor.userId,
              audience_role: "reviewer",
              created_at: input.generatedAt,
            },
            {
              tenant_id: input.actor.tenantId,
              report_version_id: versionId,
              user_id: input.actor.userId,
              audience_role: "recipient",
              created_at: input.generatedAt,
            },
          ])
          .execute();

        const sections = await this.persistProjectionItems(transaction, {
          tenantId: input.actor.tenantId,
          versionId,
          generatedAt: input.generatedAt,
          projection,
          contributorMap,
        });

        const result: WeeklyReportDetail = {
          reportId,
          versionId,
          reportType: input.reportType,
          revisionNo: 1,
          lockVersion: 1,
          status: "in_review",
          title,
          note: "",
          period: { start: input.periodStart, end: input.periodEnd },
          dataCutoffAt: input.dataCutoffAt,
          scope: {
            label: scopeLabel,
            entityCount: entities.length,
            contributorCount: contributorIds.size,
          },
          metrics: projection.metrics,
          generator: { kind: "deterministic", version: "weekly-progress-v1" },
          sections,
          previousVersionId: null,
          createdAt: input.generatedAt,
          publishedAt: null,
          capabilities: {
            canReview: true,
            canPublish: true,
            canRevise: false,
          },
        };
        await transaction
          .insertInto("app.audit_entries")
          .values({
            tenant_id: input.actor.tenantId,
            aggregate_type: "weekly_report",
            aggregate_id: reportId,
            action: "weekly_report.generated",
            actor_user_id: input.actor.userId,
            request_id: requestId,
            before_payload: null,
            after_payload: jsonObject({
              reportType: input.reportType,
              versionId,
              revisionNo: 1,
              periodStart: input.periodStart,
              periodEnd: input.periodEnd,
              dataCutoffAt: input.dataCutoffAt,
              entityCount: entities.length,
              contributorCount: contributorIds.size,
              metrics: result.metrics,
              itemCount: sections.reduce(
                (count, section) => count + section.items.length,
                0,
              ),
            }),
            reason: null,
            occurred_at: input.generatedAt,
          })
          .executeTakeFirstOrThrow();
        await completeIdempotency(transaction, {
          operation: "weekly_report.generate",
          tenantId: input.actor.tenantId,
          idempotencyKey: input.idempotencyKey,
          completedAt: input.generatedAt,
          versionId,
          result,
        });
        return result;
      },
    );
  }

  async list(input: {
    actor: { tenantId: string; userId: string };
    reportType?: WeeklyReportType;
    status?: WeeklyReportStatus;
    cursor?: string;
    limit: number;
  }) {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new TypeError(
        "Weekly report list limits must be between 1 and 100.",
      );
    }
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        let query = transaction
          .selectFrom("app.weekly_report_versions as version")
          .innerJoin("app.weekly_reports as report", (join) =>
            join
              .onRef("report.tenant_id", "=", "version.tenant_id")
              .onRef("report.id", "=", "version.report_id"),
          )
          .select([
            "report.id as report_id",
            "version.id as version_id",
            "report.report_type",
            "version.revision_no",
            "version.status",
            "version.title",
            "report.period_start",
            "report.period_end",
            "version.data_cutoff_at",
            "version.scope_entity_count",
            "version.created_at",
            "version.published_at",
          ])
          .where("version.tenant_id", "=", input.actor.tenantId)
          .where((expression) =>
            expression.exists(
              expression
                .selectFrom("app.weekly_report_audiences as audience")
                .select(sql`1`.as("one"))
                .whereRef("audience.tenant_id", "=", "version.tenant_id")
                .whereRef("audience.report_version_id", "=", "version.id")
                .where("audience.user_id", "=", input.actor.userId),
            ),
          );
        if (input.reportType) {
          query = query.where("report.report_type", "=", input.reportType);
        }
        if (input.status)
          query = query.where("version.status", "=", input.status);
        if (cursor) {
          query = query.where(
            sql<boolean>`(version.created_at, version.id) < (
              ${cursor.createdAt}::timestamptz,
              ${cursor.versionId}::uuid
            )`,
          );
        }
        const rows = await query
          .orderBy("version.created_at", "desc")
          .orderBy("version.id", "desc")
          .limit(input.limit + 1)
          .execute();
        const pageRows = rows.slice(0, input.limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map((row) => ({
            reportId: row.report_id,
            versionId: row.version_id,
            reportType: row.report_type,
            revisionNo: toNumber(row.revision_no),
            status: row.status,
            title: row.title,
            period: {
              start: toIso(row.period_start),
              end: toIso(row.period_end),
            },
            dataCutoffAt: toIso(row.data_cutoff_at),
            entityCount: row.scope_entity_count,
            createdAt: toIso(row.created_at),
            publishedAt: row.published_at ? toIso(row.published_at) : null,
          })),
          nextCursor:
            rows.length > input.limit && lastRow
              ? encodeCursor({
                  createdAt: toIso(lastRow.created_at),
                  versionId: lastRow.version_id,
                })
              : null,
        };
      },
    );
  }

  async get(input: {
    actor: { tenantId: string; userId: string };
    versionId: string;
  }): Promise<WeeklyReportDetail> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      (transaction) => readDetail(transaction, input),
    );
  }

  async review(input: {
    actor: { tenantId: string; userId: string };
    versionId: string;
    lockVersion: number;
    note: string;
    items: Array<{ itemId: string; included: boolean }>;
  }): Promise<WeeklyReportDetail> {
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId: this.requestIdFactory() },
      async (transaction) => {
        const version = await transaction
          .selectFrom("app.weekly_report_versions as version")
          .innerJoin("app.weekly_report_audiences as audience", (join) =>
            join
              .onRef("audience.tenant_id", "=", "version.tenant_id")
              .onRef("audience.report_version_id", "=", "version.id"),
          )
          .select(["version.status", "version.lock_version"])
          .where("version.tenant_id", "=", input.actor.tenantId)
          .where("version.id", "=", input.versionId)
          .where("audience.user_id", "=", input.actor.userId)
          .where("audience.audience_role", "=", "reviewer")
          .forUpdate()
          .executeTakeFirst();
        if (!version) throw new WeeklyReportNotFoundError();
        if (
          version.status !== "in_review" ||
          toNumber(version.lock_version) !== input.lockVersion
        ) {
          throw new WeeklyReportVersionConflictError();
        }
        for (const item of input.items) {
          const updated = await transaction
            .updateTable("app.weekly_report_items")
            .set({ included: item.included })
            .where("tenant_id", "=", input.actor.tenantId)
            .where("report_version_id", "=", input.versionId)
            .where("id", "=", item.itemId)
            .returning("id")
            .executeTakeFirst();
          if (!updated) throw new WeeklyReportNotFoundError();
        }
        const changedAt = await currentTimestamp(transaction);
        await transaction
          .updateTable("app.weekly_report_versions")
          .set({
            note: input.note,
            lock_version: input.lockVersion + 1,
            updated_at: changedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.versionId)
          .executeTakeFirstOrThrow();
        return readDetail(transaction, input);
      },
    );
  }

  async publish(input: {
    actor: { tenantId: string; userId: string };
    versionId: string;
    lockVersion: number;
    idempotencyKey: string;
  }): Promise<WeeklyReportDetail> {
    const requestId = this.requestIdFactory();
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        const version = await transaction
          .selectFrom("app.weekly_report_versions as version")
          .innerJoin("app.weekly_reports as report", (join) =>
            join
              .onRef("report.tenant_id", "=", "version.tenant_id")
              .onRef("report.id", "=", "version.report_id"),
          )
          .innerJoin("app.weekly_report_audiences as audience", (join) =>
            join
              .onRef("audience.tenant_id", "=", "version.tenant_id")
              .onRef("audience.report_version_id", "=", "version.id"),
          )
          .select([
            "version.report_id",
            "version.revision_no",
            "version.lock_version",
            "version.status",
            "version.scope_fingerprint",
            "report.report_type",
            "report.period_start",
            "report.period_end",
          ])
          .where("version.tenant_id", "=", input.actor.tenantId)
          .where("version.id", "=", input.versionId)
          .where("audience.user_id", "=", input.actor.userId)
          .where("audience.audience_role", "=", "reviewer")
          .forUpdate()
          .executeTakeFirst();
        if (!version) throw new WeeklyReportNotFoundError();
        const publishedAt = await currentTimestamp(transaction);
        const scopeInput = {
          actor: input.actor,
          reportType: version.report_type,
          generatedAt: publishedAt,
        };
        const entities = await this.resolveScope(transaction, scopeInput);
        if (entities.length === 0) throw new WeeklyReportNotFoundError();
        const contributors = await this.resolveContributors(
          transaction,
          scopeInput,
          entities.map((entity) => entity.entity_id),
        );
        const scopeFingerprint = fingerprintScope(
          scopeInput,
          entities,
          contributors,
        );
        if (scopeFingerprint !== version.scope_fingerprint) {
          throw new WeeklyReportScopeConflictError();
        }
        const requestHash = hashJson({
          actorTenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          lockVersion: input.lockVersion,
          scopeFingerprint,
          versionId: input.versionId,
        });
        const replay = await beginIdempotency(transaction, {
          operation: "weekly_report.publish",
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          startedAt: publishedAt,
        });
        if (replay) return replay;
        if (
          version.status !== "in_review" ||
          toNumber(version.lock_version) !== input.lockVersion
        ) {
          throw new WeeklyReportVersionConflictError();
        }
        await transaction
          .updateTable("app.weekly_report_versions")
          .set({
            status: "published",
            lock_version: input.lockVersion + 1,
            published_by: input.actor.userId,
            published_at: publishedAt,
            updated_at: publishedAt,
          })
          .where("tenant_id", "=", input.actor.tenantId)
          .where("id", "=", input.versionId)
          .executeTakeFirstOrThrow();
        const eventId = this.eventIdFactory();
        const eventPayload = {
          reportId: version.report_id,
          reportVersionId: input.versionId,
          recipientUserId: input.actor.userId,
          reportType: version.report_type,
        };
        await transaction
          .insertInto("app.domain_events")
          .values({
            tenant_id: input.actor.tenantId,
            id: eventId,
            aggregate_type: "weekly_report",
            aggregate_id: version.report_id,
            event_type: "weekly_report.published.v1",
            event_version: version.revision_no,
            payload: jsonObject(eventPayload),
            occurred_at: publishedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.outbox_messages")
          .values({
            tenant_id: input.actor.tenantId,
            id: this.outboxIdFactory(),
            event_id: eventId,
            topic: "weekly_report.published.v1",
            payload: jsonObject(eventPayload),
            dedupe_key: `weekly-report:${input.versionId}:published`,
            available_at: publishedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.audit_entries")
          .values({
            tenant_id: input.actor.tenantId,
            aggregate_type: "weekly_report",
            aggregate_id: version.report_id,
            action: "weekly_report.published",
            actor_user_id: input.actor.userId,
            request_id: requestId,
            before_payload: jsonObject({ status: "in_review" }),
            after_payload: jsonObject({
              status: "published",
              versionId: input.versionId,
              revisionNo: toNumber(version.revision_no),
            }),
            reason: null,
            occurred_at: publishedAt,
          })
          .executeTakeFirstOrThrow();
        const result = await readDetail(transaction, input);
        await completeIdempotency(transaction, {
          operation: "weekly_report.publish",
          tenantId: input.actor.tenantId,
          idempotencyKey: input.idempotencyKey,
          completedAt: publishedAt,
          versionId: input.versionId,
          result,
        });
        return result;
      },
    );
  }

  async revise(input: {
    actor: { tenantId: string; userId: string };
    versionId: string;
    lockVersion: number;
    idempotencyKey: string;
  }): Promise<WeeklyReportDetail> {
    const requestId = this.requestIdFactory();
    return withTenantTransaction(
      this.database,
      { ...input.actor, requestId },
      async (transaction) => {
        const version = await transaction
          .selectFrom("app.weekly_report_versions as version")
          .innerJoin("app.weekly_reports as report", (join) =>
            join
              .onRef("report.tenant_id", "=", "version.tenant_id")
              .onRef("report.id", "=", "version.report_id"),
          )
          .innerJoin("app.weekly_report_audiences as audience", (join) =>
            join
              .onRef("audience.tenant_id", "=", "version.tenant_id")
              .onRef("audience.report_version_id", "=", "version.id"),
          )
          .select([
            "version.report_id",
            "version.revision_no",
            "version.lock_version",
            "version.status",
            "version.title",
            "version.note",
            "report.report_type",
            "report.period_start",
            "report.period_end",
          ])
          .where("version.tenant_id", "=", input.actor.tenantId)
          .where("version.id", "=", input.versionId)
          .where("audience.user_id", "=", input.actor.userId)
          .where("audience.audience_role", "=", "reviewer")
          .forUpdate()
          .executeTakeFirst();
        if (!version) throw new WeeklyReportNotFoundError();
        if (
          version.status !== "published" ||
          toNumber(version.lock_version) !== input.lockVersion
        ) {
          throw new WeeklyReportVersionConflictError();
        }
        const generatedAt = await currentTimestamp(transaction);
        const periodStart = toIso(version.period_start);
        const periodEnd = toIso(version.period_end);
        const generatedTimestamp = Date.parse(generatedAt);
        if (generatedTimestamp < Date.parse(periodStart)) {
          throw new WeeklyReportVersionConflictError();
        }
        const dataCutoffAt = new Date(
          Math.min(Date.parse(periodEnd), generatedTimestamp),
        ).toISOString();
        const scopeInput = {
          actor: input.actor,
          reportType: version.report_type,
          generatedAt,
        };
        const entities = await this.resolveScope(transaction, scopeInput);
        if (entities.length === 0) throw new WeeklyReportNotFoundError();
        if (entities.length > this.maxScopedEntities) {
          throw new WeeklyReportResultLimitExceededError();
        }
        const contributors = await this.resolveContributors(
          transaction,
          scopeInput,
          entities.map((entity) => entity.entity_id),
        );
        const scopeFingerprint = fingerprintScope(
          scopeInput,
          entities,
          contributors,
        );
        const requestHash = hashJson({
          actorTenantId: input.actor.tenantId,
          actorUserId: input.actor.userId,
          lockVersion: input.lockVersion,
          scopeFingerprint,
          sourceVersionId: input.versionId,
        });
        const replay = await beginIdempotency(transaction, {
          operation: "weekly_report.revise",
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          startedAt: generatedAt,
        });
        if (replay) return replay;
        const laterVersion = await transaction
          .selectFrom("app.weekly_report_versions")
          .select("id")
          .where("tenant_id", "=", input.actor.tenantId)
          .where("report_id", "=", version.report_id)
          .where("revision_no", ">", version.revision_no)
          .executeTakeFirst();
        if (laterVersion) throw new WeeklyReportVersionConflictError();
        const projection = await projectWeeklyProgress(transaction, {
          tenantId: input.actor.tenantId,
          entities,
          actionOwnerUserIds: [
            ...new Set(contributors.map((contributor) => contributor.user_id)),
          ],
          periodStart,
          periodEnd,
          dataCutoffAt,
          maxEventRowsPerKind: this.maxEventRowsPerKind,
          assertRowLimit: assertResultRowLimit,
        });
        const revisionNo = toNumber(version.revision_no) + 1;
        const versionId = this.versionIdFactory();
        const contributorIds = new Set(
          contributors.map((contributor) => contributor.user_id),
        );
        await transaction
          .insertInto("app.weekly_report_versions")
          .values({
            tenant_id: input.actor.tenantId,
            id: versionId,
            report_id: version.report_id,
            revision_no: revisionNo,
            lock_version: 1,
            status: "in_review",
            data_cutoff_at: dataCutoffAt,
            title: version.title,
            note: version.note,
            scope_fingerprint: scopeFingerprint,
            scope_entity_count: entities.length,
            contributor_count: contributorIds.size,
            confirmed_followup_count: projection.metrics.confirmedFollowupCount,
            valid_fact_count: projection.metrics.validFactCount,
            stage_change_count: projection.metrics.stageChangeCount,
            completed_action_count: projection.metrics.completedActionCount,
            open_action_count: projection.metrics.openActionCount,
            overdue_action_count: projection.metrics.overdueActionCount,
            generator_kind: "deterministic",
            generator_version: "weekly-progress-v1",
            previous_version_id: input.versionId,
            created_by: input.actor.userId,
            created_at: generatedAt,
            published_by: null,
            published_at: null,
            updated_at: generatedAt,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("app.weekly_report_scope_entities")
          .values(
            entities.map((entity, index) => ({
              tenant_id: input.actor.tenantId,
              report_version_id: versionId,
              entity_id: entity.entity_id,
              sort_order: index,
              created_at: generatedAt,
            })),
          )
          .execute();
        await transaction
          .insertInto("app.weekly_report_audiences")
          .values([
            {
              tenant_id: input.actor.tenantId,
              report_version_id: versionId,
              user_id: input.actor.userId,
              audience_role: "reviewer",
              created_at: generatedAt,
            },
            {
              tenant_id: input.actor.tenantId,
              report_version_id: versionId,
              user_id: input.actor.userId,
              audience_role: "recipient",
              created_at: generatedAt,
            },
          ])
          .execute();
        const sections = await this.persistProjectionItems(transaction, {
          tenantId: input.actor.tenantId,
          versionId,
          generatedAt,
          projection,
          contributorMap: groupContributors(contributors),
        });
        const result: WeeklyReportDetail = {
          reportId: version.report_id,
          versionId,
          reportType: version.report_type,
          revisionNo,
          lockVersion: 1,
          status: "in_review",
          title: version.title,
          note: version.note,
          period: { start: periodStart, end: periodEnd },
          dataCutoffAt,
          scope: {
            label:
              version.report_type === "personal"
                ? "本人责任范围"
                : "当前管理关注范围",
            entityCount: entities.length,
            contributorCount: contributorIds.size,
          },
          metrics: projection.metrics,
          generator: { kind: "deterministic", version: "weekly-progress-v1" },
          sections,
          previousVersionId: input.versionId,
          createdAt: generatedAt,
          publishedAt: null,
          capabilities: {
            canReview: true,
            canPublish: true,
            canRevise: false,
          },
        };
        await transaction
          .insertInto("app.audit_entries")
          .values({
            tenant_id: input.actor.tenantId,
            aggregate_type: "weekly_report",
            aggregate_id: version.report_id,
            action: "weekly_report.revised",
            actor_user_id: input.actor.userId,
            request_id: requestId,
            before_payload: jsonObject({
              versionId: input.versionId,
              revisionNo: toNumber(version.revision_no),
            }),
            after_payload: jsonObject({ versionId, revisionNo }),
            reason: null,
            occurred_at: generatedAt,
          })
          .executeTakeFirstOrThrow();
        await completeIdempotency(transaction, {
          operation: "weekly_report.revise",
          tenantId: input.actor.tenantId,
          idempotencyKey: input.idempotencyKey,
          completedAt: generatedAt,
          versionId,
          result,
        });
        return result;
      },
    );
  }

  private async persistProjectionItems(
    transaction: DatabaseTransaction,
    input: {
      tenantId: string;
      versionId: string;
      generatedAt: string;
      projection: WeeklyProjection;
      contributorMap: Map<string, ContributorRow[]>;
    },
  ): Promise<WeeklyReportDetail["sections"]> {
    const sections: WeeklyReportDetail["sections"] = [
      { kind: "progress", items: [] },
      { kind: "risk", items: [] },
      { kind: "next_action", items: [] },
      { kind: "data_gap", items: [] },
    ];
    const sectionByKind = new Map(
      sections.map((section) => [section.kind, section]),
    );
    for (const [sortOrder, entity] of input.projection.entities.entries()) {
      const contributors = input.contributorMap.get(entity.entityId) ?? [];
      const progressCount =
        entity.confirmedFollowupCount +
        entity.validFactCount +
        entity.stageChangeCount +
        entity.completedActionCount;
      if (progressCount > 0) {
        await this.persistItem(transaction, {
          ...input,
          contributors,
          section: sectionByKind.get("progress"),
          item: {
            itemId: this.itemIdFactory(),
            sectionKind: "progress",
            entityId: entity.entityId,
            entityName: entity.entityName,
            title: "本周可核验进展",
            summary: progressSummary(entity),
            severity: "positive",
            occurredAt: latestEvidenceAt(entity.progressEvidence),
            included: true,
            sortOrder,
            contributors: contributorDtos(contributors),
            evidence: limitedEvidence(entity.progressEvidence),
          },
        });
      }
      if (
        entity.overdueActionCount > 0 ||
        entity.riskLevel === "high" ||
        entity.riskLevel === "critical"
      ) {
        const evidence = limitedEvidence([
          ...entity.overdueEvidence,
          ...(entity.battleStateEvidence ? [entity.battleStateEvidence] : []),
        ]);
        await this.persistItem(transaction, {
          ...input,
          contributors,
          section: sectionByKind.get("risk"),
          item: {
            itemId: this.itemIdFactory(),
            sectionKind: "risk",
            entityId: entity.entityId,
            entityName: entity.entityName,
            title: "需要关注的风险",
            summary: riskSummary(entity),
            severity:
              entity.riskLevel === "critical" || entity.overdueActionCount > 0
                ? "critical"
                : "warning",
            occurredAt: latestEvidenceAt(evidence),
            included: true,
            sortOrder,
            contributors: contributorDtos(contributors),
            evidence,
          },
        });
      }
      if (entity.openActionCount > 0) {
        const evidence = limitedEvidence(entity.openActionEvidence);
        await this.persistItem(transaction, {
          ...input,
          contributors,
          section: sectionByKind.get("next_action"),
          item: {
            itemId: this.itemIdFactory(),
            sectionKind: "next_action",
            entityId: entity.entityId,
            entityName: entity.entityName,
            title: "下一步经营动作",
            summary: `${entity.openActionCount} 项正式动作仍待推进。`,
            severity: "info",
            occurredAt: latestEvidenceAt(evidence),
            included: true,
            sortOrder,
            contributors: contributorDtos(contributors),
            evidence,
          },
        });
      }
      if (!entity.battleStateEvidence) {
        await this.persistItem(transaction, {
          ...input,
          contributors,
          section: sectionByKind.get("data_gap"),
          item: {
            itemId: this.itemIdFactory(),
            sectionKind: "data_gap",
            entityId: entity.entityId,
            entityName: entity.entityName,
            title: "缺少作战状态",
            summary: "当前没有可用于判断风险的作战状态版本。",
            severity: "warning",
            occurredAt: null,
            included: true,
            sortOrder,
            contributors: contributorDtos(contributors),
            evidence: [],
          },
        });
      }
    }
    return sections;
  }

  private async persistItem(
    transaction: DatabaseTransaction,
    input: {
      tenantId: string;
      versionId: string;
      generatedAt: string;
      contributors: ContributorRow[];
      section: WeeklyReportDetail["sections"][number] | undefined;
      item: WeeklyReportDetail["sections"][number]["items"][number];
    },
  ): Promise<void> {
    if (!input.section) throw new Error("Weekly report section is missing.");
    await transaction
      .insertInto("app.weekly_report_items")
      .values({
        tenant_id: input.tenantId,
        id: input.item.itemId,
        report_version_id: input.versionId,
        section_type: input.item.sectionKind,
        entity_id: input.item.entityId,
        title: input.item.title,
        summary: input.item.summary,
        severity: input.item.severity,
        occurred_at: input.item.occurredAt,
        included: input.item.included,
        sort_order: input.item.sortOrder,
        created_at: input.generatedAt,
      })
      .executeTakeFirstOrThrow();
    if (input.contributors.length > 0) {
      await transaction
        .insertInto("app.weekly_report_item_contributors")
        .values(
          input.contributors.map((contributor) => ({
            tenant_id: input.tenantId,
            report_item_id: input.item.itemId,
            user_id: contributor.user_id,
            display_name: contributor.display_name,
            created_at: input.generatedAt,
          })),
        )
        .execute();
    }
    if (input.item.evidence.length > 0) {
      await transaction
        .insertInto("app.report_evidence_links")
        .values(
          input.item.evidence.map((evidence) => ({
            tenant_id: input.tenantId,
            report_item_id: input.item.itemId,
            evidence_type: evidence.kind,
            evidence_id: evidence.evidenceId,
            occurred_at: evidence.occurredAt,
            label: evidence.label,
            deep_link: evidence.deepLink,
            created_at: input.generatedAt,
          })),
        )
        .execute();
    }
    input.section.items.push(input.item);
  }

  private async resolveScope(
    transaction: DatabaseTransaction,
    input: {
      actor: { tenantId: string; userId: string };
      reportType: WeeklyReportType;
      generatedAt: string;
    },
  ): Promise<ScopeEntityRow[]> {
    const role =
      input.reportType === "personal"
        ? sql`assignment.assignment_role in ('owner', 'collaborator')`
        : sql`assignment.assignment_role = 'management_observer'`;
    const result = await sql<ScopeEntityRow>`
      select distinct
        entity.id::text as entity_id,
        entity.name as entity_name
      from app.entity_assignments as assignment
      inner join app.business_entities as entity
        on entity.tenant_id = assignment.tenant_id
        and entity.id = assignment.entity_id
      inner join app.users as actor_user
        on actor_user.tenant_id = assignment.tenant_id
        and actor_user.id = assignment.user_id
      where assignment.tenant_id = ${input.actor.tenantId}::uuid
        and assignment.user_id = ${input.actor.userId}::uuid
        and ${role}
        and assignment.valid_from <= ${input.generatedAt}::timestamptz
        and (
          assignment.valid_to is null
          or assignment.valid_to > ${input.generatedAt}::timestamptz
        )
        and entity.status = 'active'
        and actor_user.status = 'active'
      order by entity_name, entity_id
      limit ${this.maxScopedEntities + 1}
    `.execute(transaction);
    return result.rows;
  }

  private async resolveContributors(
    transaction: DatabaseTransaction,
    input: {
      actor: { tenantId: string; userId: string };
      reportType: WeeklyReportType;
      generatedAt: string;
    },
    entityIds: string[],
  ): Promise<ContributorRow[]> {
    if (entityIds.length === 0) return [];
    const userFilter =
      input.reportType === "personal"
        ? sql`and assignment.user_id = ${input.actor.userId}::uuid`
        : sql``;
    const result = await sql<ContributorRow>`
      select distinct
        assignment.entity_id::text as entity_id,
        app_user.id::text as user_id,
        app_user.display_name
      from app.entity_assignments as assignment
      inner join app.users as app_user
        on app_user.tenant_id = assignment.tenant_id
        and app_user.id = assignment.user_id
      where assignment.tenant_id = ${input.actor.tenantId}::uuid
        and assignment.entity_id in (
          ${sql.join(entityIds.map((id) => sql`${id}::uuid`))}
        )
        and assignment.assignment_role in ('owner', 'collaborator')
        and assignment.valid_from <= ${input.generatedAt}::timestamptz
        and (
          assignment.valid_to is null
          or assignment.valid_to > ${input.generatedAt}::timestamptz
        )
        and app_user.status = 'active'
        ${userFilter}
      order by entity_id, display_name, user_id
    `.execute(transaction);
    return result.rows;
  }
}

async function readDetail(
  transaction: DatabaseTransaction,
  input: {
    actor: { tenantId: string; userId: string };
    versionId: string;
  },
): Promise<WeeklyReportDetail> {
  const row = await transaction
    .selectFrom("app.weekly_report_versions as version")
    .innerJoin("app.weekly_reports as report", (join) =>
      join
        .onRef("report.tenant_id", "=", "version.tenant_id")
        .onRef("report.id", "=", "version.report_id"),
    )
    .select([
      "report.id as report_id",
      "report.report_type",
      "report.period_start",
      "report.period_end",
      "version.id as version_id",
      "version.revision_no",
      "version.lock_version",
      "version.status",
      "version.title",
      "version.note",
      "version.data_cutoff_at",
      "version.scope_entity_count",
      "version.contributor_count",
      "version.confirmed_followup_count",
      "version.valid_fact_count",
      "version.stage_change_count",
      "version.completed_action_count",
      "version.open_action_count",
      "version.overdue_action_count",
      "version.generator_kind",
      "version.generator_version",
      "version.previous_version_id",
      "version.created_at",
      "version.published_at",
    ])
    .where("version.tenant_id", "=", input.actor.tenantId)
    .where("version.id", "=", input.versionId)
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("app.weekly_report_audiences as audience")
          .select(sql`1`.as("one"))
          .whereRef("audience.tenant_id", "=", "version.tenant_id")
          .whereRef("audience.report_version_id", "=", "version.id")
          .where("audience.user_id", "=", input.actor.userId),
      ),
    )
    .executeTakeFirst();
  if (!row) throw new WeeklyReportNotFoundError();
  const [itemRows, evidenceRows, contributorRows, reviewer] = await Promise.all(
    [
      transaction
        .selectFrom("app.weekly_report_items as item")
        .innerJoin("app.business_entities as entity", (join) =>
          join
            .onRef("entity.tenant_id", "=", "item.tenant_id")
            .onRef("entity.id", "=", "item.entity_id"),
        )
        .selectAll("item")
        .select("entity.name as entity_name")
        .where("item.tenant_id", "=", input.actor.tenantId)
        .where("item.report_version_id", "=", input.versionId)
        .orderBy("item.section_type")
        .orderBy("item.sort_order")
        .orderBy("item.id")
        .execute(),
      transaction
        .selectFrom("app.report_evidence_links as evidence")
        .innerJoin("app.weekly_report_items as item", (join) =>
          join
            .onRef("item.tenant_id", "=", "evidence.tenant_id")
            .onRef("item.id", "=", "evidence.report_item_id"),
        )
        .select([
          "evidence.report_item_id",
          "evidence.evidence_type",
          "evidence.evidence_id",
          "evidence.occurred_at",
          "evidence.label",
          "evidence.deep_link",
        ])
        .where("evidence.tenant_id", "=", input.actor.tenantId)
        .where("item.report_version_id", "=", input.versionId)
        .execute(),
      transaction
        .selectFrom("app.weekly_report_item_contributors as contributor")
        .innerJoin("app.weekly_report_items as item", (join) =>
          join
            .onRef("item.tenant_id", "=", "contributor.tenant_id")
            .onRef("item.id", "=", "contributor.report_item_id"),
        )
        .select([
          "contributor.report_item_id",
          "contributor.user_id",
          "contributor.display_name",
        ])
        .where("contributor.tenant_id", "=", input.actor.tenantId)
        .where("item.report_version_id", "=", input.versionId)
        .orderBy("contributor.display_name")
        .orderBy("contributor.user_id")
        .execute(),
      transaction
        .selectFrom("app.weekly_report_audiences")
        .select("user_id")
        .where("tenant_id", "=", input.actor.tenantId)
        .where("report_version_id", "=", input.versionId)
        .where("user_id", "=", input.actor.userId)
        .where("audience_role", "=", "reviewer")
        .executeTakeFirst(),
    ],
  );
  const evidenceByItem = new Map<string, ReportEvidence[]>();
  for (const evidence of evidenceRows) {
    const list = evidenceByItem.get(evidence.report_item_id) ?? [];
    list.push({
      kind: evidence.evidence_type,
      evidenceId: evidence.evidence_id,
      occurredAt: toIso(evidence.occurred_at),
      label: evidence.label,
      deepLink: evidence.deep_link,
    });
    evidenceByItem.set(evidence.report_item_id, list);
  }
  const contributorsByItem = new Map<
    string,
    Array<{ userId: string; displayName: string }>
  >();
  for (const contributor of contributorRows) {
    const list = contributorsByItem.get(contributor.report_item_id) ?? [];
    list.push({
      userId: contributor.user_id,
      displayName: contributor.display_name,
    });
    contributorsByItem.set(contributor.report_item_id, list);
  }
  const sections: WeeklyReportDetail["sections"] = [
    { kind: "progress", items: [] },
    { kind: "risk", items: [] },
    { kind: "next_action", items: [] },
    { kind: "data_gap", items: [] },
  ];
  const sectionByKind = new Map(
    sections.map((section) => [section.kind, section]),
  );
  for (const item of itemRows) {
    sectionByKind.get(item.section_type)?.items.push({
      itemId: item.id,
      sectionKind: item.section_type,
      entityId: item.entity_id,
      entityName: item.entity_name,
      title: item.title,
      summary: item.summary,
      severity: item.severity,
      occurredAt: item.occurred_at ? toIso(item.occurred_at) : null,
      included: item.included,
      sortOrder: item.sort_order,
      contributors: contributorsByItem.get(item.id) ?? [],
      evidence: limitedEvidence(evidenceByItem.get(item.id) ?? []),
    });
  }
  const canEdit = row.status === "in_review" && Boolean(reviewer);
  return {
    reportId: row.report_id,
    versionId: row.version_id,
    reportType: row.report_type,
    revisionNo: toNumber(row.revision_no),
    lockVersion: toNumber(row.lock_version),
    status: row.status,
    title: row.title,
    note: row.note,
    period: { start: toIso(row.period_start), end: toIso(row.period_end) },
    dataCutoffAt: toIso(row.data_cutoff_at),
    scope: {
      label:
        row.report_type === "personal" ? "本人责任范围" : "当前管理关注范围",
      entityCount: row.scope_entity_count,
      contributorCount: row.contributor_count,
    },
    metrics: {
      confirmedFollowupCount: row.confirmed_followup_count,
      validFactCount: row.valid_fact_count,
      stageChangeCount: row.stage_change_count,
      completedActionCount: row.completed_action_count,
      openActionCount: row.open_action_count,
      overdueActionCount: row.overdue_action_count,
    },
    generator: {
      kind: row.generator_kind,
      version: row.generator_version,
    },
    sections,
    previousVersionId: row.previous_version_id,
    createdAt: toIso(row.created_at),
    publishedAt: row.published_at ? toIso(row.published_at) : null,
    capabilities: {
      canReview: canEdit,
      canPublish: canEdit,
      canRevise: row.status === "published" && Boolean(reviewer),
    },
  };
}

async function currentTimestamp(
  transaction: DatabaseTransaction,
): Promise<string> {
  const row = await sql<{ now: Date | string }>`
    select current_timestamp as now
  `.execute(transaction);
  const value = row.rows[0]?.now;
  if (!value) throw new Error("Database clock is unavailable.");
  return toIso(value);
}

async function beginIdempotency(
  transaction: DatabaseTransaction,
  input: {
    operation:
      | "weekly_report.generate"
      | "weekly_report.publish"
      | "weekly_report.revise";
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    requestHash: string;
    startedAt: string;
  },
): Promise<WeeklyReportDetail | null> {
  const inserted = await transaction
    .insertInto("app.idempotency_records")
    .values({
      tenant_id: input.tenantId,
      operation: input.operation,
      idempotency_key: input.idempotencyKey,
      request_hash: input.requestHash,
      status: "in_progress",
      response_payload: null,
      resource_type: null,
      resource_id: null,
      created_by: input.userId,
      created_at: input.startedAt,
      completed_at: null,
      expires_at: null,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return null;
  const existing = (await transaction
    .selectFrom("app.idempotency_records")
    .select(["request_hash", "status", "response_payload"])
    .where("tenant_id", "=", input.tenantId)
    .where("operation", "=", input.operation)
    .where("idempotency_key", "=", input.idempotencyKey)
    .forUpdate()
    .executeTakeFirst()) as IdempotencyRow | undefined;
  if (
    !existing ||
    existing.request_hash !== input.requestHash ||
    existing.status !== "completed" ||
    !existing.response_payload
  ) {
    throw new WeeklyReportIdempotencyConflictError();
  }
  return existing.response_payload as unknown as WeeklyReportDetail;
}

async function completeIdempotency(
  transaction: DatabaseTransaction,
  input: {
    operation:
      | "weekly_report.generate"
      | "weekly_report.publish"
      | "weekly_report.revise";
    tenantId: string;
    idempotencyKey: string;
    completedAt: string;
    versionId: string;
    result: WeeklyReportDetail;
  },
): Promise<void> {
  await transaction
    .updateTable("app.idempotency_records")
    .set({
      status: "completed",
      response_payload: jsonObject(input.result),
      resource_type: "weekly_report_version",
      resource_id: input.versionId,
      completed_at: input.completedAt,
    })
    .where("tenant_id", "=", input.tenantId)
    .where("operation", "=", input.operation)
    .where("idempotency_key", "=", input.idempotencyKey)
    .executeTakeFirstOrThrow();
}

function groupContributors(rows: ContributorRow[]) {
  const grouped = new Map<string, ContributorRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.entity_id) ?? [];
    group.push(row);
    grouped.set(row.entity_id, group);
  }
  return grouped;
}

function fingerprintScope(
  input: { actor: { tenantId: string; userId: string }; reportType: string },
  entities: ScopeEntityRow[],
  contributors: ContributorRow[],
): string {
  return hashJson({
    actorTenantId: input.actor.tenantId,
    actorUserId: input.actor.userId,
    reportType: input.reportType,
    entityIds: entities.map((entity) => entity.entity_id).sort(),
    contributors: contributors
      .map((contributor) => ({
        entityId: contributor.entity_id,
        userId: contributor.user_id,
      }))
      .sort(
        (left, right) =>
          left.entityId.localeCompare(right.entityId) ||
          left.userId.localeCompare(right.userId),
      ),
  });
}

function limitedEvidence(evidence: ReportEvidence[]): ReportEvidence[] {
  return [...evidence]
    .sort(
      (left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) ||
        left.kind.localeCompare(right.kind) ||
        left.evidenceId.localeCompare(right.evidenceId),
    )
    .slice(0, 20);
}

function latestEvidenceAt(evidence: ReportEvidence[]): string | null {
  return limitedEvidence(evidence)[0]?.occurredAt ?? null;
}

function contributorDtos(contributors: ContributorRow[]) {
  return contributors.map((contributor) => ({
    userId: contributor.user_id,
    displayName: contributor.display_name,
  }));
}

function progressSummary(entity: EntityProjection): string {
  return [
    `${entity.confirmedFollowupCount} 次已确认跟进`,
    `${entity.validFactCount} 条有效事实`,
    `${entity.stageChangeCount} 次阶段变化`,
    `${entity.completedActionCount} 个已完成动作`,
  ].join("，");
}

function riskSummary(entity: EntityProjection): string {
  const parts: string[] = [];
  if (entity.overdueActionCount > 0) {
    parts.push(`${entity.overdueActionCount} 个正式动作已逾期`);
  }
  if (entity.riskLevel === "high" || entity.riskLevel === "critical") {
    parts.push(`作战风险为${entity.riskLevel === "critical" ? "严重" : "高"}`);
  }
  return `${parts.join("；")}。`;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Database timestamp is invalid.");
  }
  return date.toISOString();
}

function toNumber(value: string | number | bigint): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error("Database version number is invalid.");
  }
  return numeric;
}

function assertResultRowLimit(actual: number, maximum: number): void {
  if (actual > maximum) throw new WeeklyReportResultLimitExceededError();
}

function hashJson(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(cursor: WeeklyReportCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): WeeklyReportCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Cursor encoding is invalid.");
    }
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("Cursor encoding is not canonical.");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Cursor payload is invalid.");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(",") !== "createdAt,versionId" ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt)) ||
      typeof candidate.versionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.versionId,
      )
    ) {
      throw new Error("Cursor values are invalid.");
    }
    return candidate as unknown as WeeklyReportCursor;
  } catch (error) {
    throw new InvalidWeeklyReportCursorError({ cause: error });
  }
}

function jsonObject(value: object) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::jsonb`;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "Weekly report processing limits must be positive integers.",
    );
  }
  return value;
}
