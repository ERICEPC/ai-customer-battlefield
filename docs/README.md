# AI 客户作战系统文档

## 主文档

1. [V1 产品设计总纲](01-V1产品设计总纲.md)

   项目定位、经营对象、V1 范围、角色、业务流程、飞书复刻边界、架构护栏和验收底线。

2. [业务数据模型](02-业务数据模型.md)

   从专业销售管理表提炼出的业务表设计、对象关系、历史版本、证据、动作、周报、通知和迁移方案。

3. [UI 与交互设计](03-UI与交互设计.md)

   角色导航、页面路由、五条关键旅程、作战地图、状态矩阵、视觉 Token、响应式与无障碍验收。

4. [系统架构与详细设计](04-系统架构与详细设计.md)

   模块 seam、技术选型、REST、Agent/Tool、权限、事务、Outbox、通知、配置、部署、测试和非功能验收。

后续 UI、技术选型和详细接口完成评审后，继续在这一编号体系中补充，不再为每次讨论新建一份主文档。

## 工程计划

- [首个可运行骨架实施计划](superpowers/plans/2026-08-31-foundation-walking-skeleton.md)
- [V1-A 数据与身份基础实施计划](superpowers/plans/2026-08-31-v1a-data-identity-foundation.md)
- [V1-B 跟进确认实施计划](superpowers/plans/2026-08-31-v1b-followup-confirmation.md)
- [V1-C 作战分析与动作实施计划](superpowers/plans/2026-08-31-v1c-battle-analysis-actions.md)
- [V1-D 提醒与通知实施计划](superpowers/plans/2026-08-31-v1d-reminders-notifications.md)
- [V1-E 角色工作台实施计划](superpowers/plans/2026-08-31-v1e-role-scoped-workspace.md)
- [V1-F 受控管理进展问数实施计划](superpowers/plans/2026-08-31-v1f-management-progress-query.md)

## 当前工程状态

当前已交付从人工确认跟进到证据化管理问数的连续纵向闭环。已具备以下边界：

- Web 与 API 通过 `/api/v1` 版本化契约通信；
- AI 输出固定停留在 `pending_confirmation`，不会直接成为正式经营事实；
- 核心用例只依赖 Agent、时钟和 ID 端口，不依赖具体框架、模型或数据库；
- PostgreSQL SQL migration 是 schema 唯一事实源，PGlite 只作为本地/测试 adapter；
- 40 张租户、经营、跟进、分析、动作、提醒与通知表通过复合外键、部分唯一索引和强制 RLS 保护；
- 经营对象、跟进确认、作战地图、动作决策、站内通知、角色工作台和受控进展问数均贯通 Kysely repository、Nest API、共享契约与响应式 Web；
- 开发环境使用确定性 Agent，不需要外部模型账号；
- GitHub Actions 持续验证真实 PostgreSQL migration、公开边界、格式、类型、测试和生产构建。

V1-A 至 V1-F 工程增量已依次覆盖数据/身份、跟进确认、作战分析与动作、提醒通知、角色工作台和单销售周进展受控问数。完整产品 V1 仍未完成：个人/团队周报、提醒升级、更多受控问数与自然语言路由、配置管理、历史导入、生产 OIDC、真实模型/飞书租户验收和部署恢复仍按后续连续增量实施，并复用当前领域模型、权限谓词与架构 seam。

## 公开资料边界

公开仓库只保存通用产品与工程资料，不保存客户数据、生产导出、私有协作链接、原型录屏或内部研究证据。示例和测试统一使用合成数据。
