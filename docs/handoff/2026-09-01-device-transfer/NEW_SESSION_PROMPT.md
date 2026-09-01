# 发给新 Codex 会话的指令

复制下面整段作为新会话第一条消息；如果新设备已经克隆仓库，请同时把工作目录切到仓库根目录。

---

请接手并持续开发公开仓库：

`https://github.com/ERICEPC/ai-customer-battlefield`

这是一个独立 AI 客户作战系统，不是通用 CRM，也不是一次性 DEMO。长期目标是自然语言录入 → 可替换 Agent/模型智能拆解 → 人工核对 → 正式 PostgreSQL 入库 → Worker 自动更新作战地图 → 直属领导站内通知 → 领导基于正式数据问询，并继续完善权限、审计、配置治理和部署可靠性。

开始前必须：

1. 读取仓库根目录 `AGENTS.md`（若存在）和全局 memory bootstrap；
2. 完整读取 `docs/handoff/2026-09-01-device-transfer/README.md`；
3. 检查 `git status --short`、`git log -8 --oneline`、当前分支和 `origin/main`；
4. 确认 `main` 至少包含交接基线 `51fc19e492a97e6f5903d0c2e1d2b80247e57447`；
5. 不要把 `.env.local`、`.env.migrate.local`、SSH 私钥、SenseAudio Key、数据库口令或客户数据写入公开仓库或输出；这些由我通过私有方式提供/转移；
6. 所有更改直接提交并推送 `main`，不建功能分支；
7. 小步快跑，只跑受影响测试；数据库、权限、跨模块或封板时再扩大验证；
8. 每个切片必须告诉我页面能看到什么以及如何手动验收，不能只报告测试通过；
9. 保留 `tenant_id`、RLS、不可变历史、证据、幂等、Outbox、Agent/Tool/API adapter 解耦；
10. 不要退回演示库或假模型，正常开发连接现有真实 PostgreSQL 和真实 SenseAudio；AI 失败必须不入库。

当前停止点：

- `main/origin/main` 基线为 `51fc19e`；
- migrations 已到 `0017_worker_execution_lease`，正式 PostgreSQL 16 已应用；
- 已完成真实登录、销售/直属领导两层身份、个人模型设置与加密 Key、19 模型选择、真实 AI 草稿、人工确认、正式事实、原始表格、自动地图、铃铛/消息抽屉、领导通知、管理问询、周报、动作提醒、管理权限、AI 配置、作战规则、审计查询和 Worker 运维；
- 最近完成 Worker 单实例执行租约、作战分析运行回执、跟进自动化处理凭证、审计 request ID 自动继承和 PostgreSQL pool 断线监听；
- 本轮 Worker 和 SSH 隧道都已停止；新设备需先恢复私有环境与隧道，再启动 API/Web/Worker；
- 首要任务不是继续堆后端，而是按交接包第 6 节在新设备完整验收一条新的真实可见主链；
- 主链通过后，优先实现管理员按 followup/event/outbox/analysis/notification 任一 ID 打开的统一业务链追踪；之后再做正式部署/进程守护、API 请求上下文标准化、多级组织权限、通知渠道管理和导入工具；
- 根 README 有状态漂移，仍把部分已完成能力列为 in progress，后续需修正；
- 不要碰或提交环境自动生成的 `apps/web/next-env.d.ts` 差异，除非先确认它确实属于本次任务。

工作方式：先汇报你读取到的交接基线、当前进程/端口/隧道状态和第一步验收计划，再执行；遇到环境问题先定位根因，不要反复盲重试。持续开发直到我明确要求停止或完整验收结束。

---
