# PostgreSQL、SQL migration 与 Kysely adapter

正式数据使用 PostgreSQL 17+，版本化 SQL migration 是结构事实源，Kysely 只作为 API 基础设施 adapter。相比把 schema 交给正在换代的 ORM 迁移体系，这一方案能够完整表达复合租户外键、部分唯一索引、RLS、Outbox 和原生事务约束；代价是需要维护显式 SQL 与数据库类型，但 Kysely 不进入业务核心，未来替换查询库不影响领域 interface。
