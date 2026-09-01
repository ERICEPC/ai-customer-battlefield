# AI 客户作战系统设备迁移交接包

更新时间：2026-09-01（Asia/Shanghai）

公开仓库：<https://github.com/ERICEPC/ai-customer-battlefield>

工作分支：`main`

交接基线：`51fc19e492a97e6f5903d0c2e1d2b80247e57447`

## 1. 当前目标与产品边界

这不是通用 CRM，也不是只为演示搭建的一次性页面。目标是把飞书原型中的销售经营闭环复刻为可长期演进的独立 AI 客户作战系统：

1. 销售以自然语言录入跟进；
2. 可替换 Agent 调用模型拆解为待确认草稿；
3. 人工核对、修订并确认后才写入正式跟进、经营事实和证据；
4. Outbox/Worker 自动生成作战分析和地图版本；
5. 直属领导收到站内消息，可深链回正式记录；
6. 销售和领导分别查看其责任范围内的原始表格、作战地图、首页提醒和经营问询；
7. 管理台配置权限、Prompt/模型、作战规则，查询审计和 Worker 状态。

长期架构边界保持不变：

- Agent 底座和模型供应商通过 port/adapter 解耦；
- Agent 只能通过受控 Tool/应用接口读写系统；
- Web、小程序或其他入口复用稳定 API，不绑定具体前端；
- PostgreSQL 是事实源，保留 `tenant_id`、不可变历史、证据、幂等、Outbox 和迁移版本；
- 站内信独立闭环，飞书仅作为可选外部通知渠道；
- 当前只实现销售与直属领导两层关系，未来组织层级不写死在业务表中。

## 2. 已完成且可见的能力

### 身份与权限

- 真实账号密码登录、服务端会话、退出登录和右上角账号菜单；
- 销售看到所属部门和直属领导，领导看到部门销售；
- 当前演示账号：
  - 租户 `alpha`，销售 `sales1@demo.local`；
  - 租户 `alpha`，领导 `leader.a@demo.local`；
  - 两个账号的合成演示密码均为 `Demo@2026`；
- 对象级责任关系区分 `owner`、`collaborator`、`management_observer`；
- 草稿仅创建者可读写，正式记录按当前责任关系授权；
- 管理能力已拆成权限管理、AI 配置、审计读取、管理问询、Worker 运维和作战规则管理，不再只依赖角色名称；
- 权限变更带原因、幂等、防最后管理员锁死和审计。

### AI 录入与正式入库

- SenseAudio Chat/Responses 适配器已接入真实模型；
- 个人设置页可保存加密 API Key、查看配置状态和后四位、选择 19 个文本模型并测试连接；
- 正式录入采用“个人凭证/模型偏好 → 租户发布配置 → 系统兜底”的解析顺序；
- Prompt、模型默认值、超时和重试采用租户不可变版本、发布和回滚；
- AI 输出严格校验，失败不创建草稿，成功后展示摘要、时间、形式、商机和事实候选；
- 人工确认前不写正式事实；确认后同一事务写正式跟进、事实、证据、审计、领域事件和 Outbox。

### 可见经营闭环

- 经营对象原始表格视图，显示负责人、主商机、中文阶段、进度、最新正式跟进和更新时间；
- 正式跟进只读详情页；
- 跟进确认后 Worker 自动更新作战地图，无需手动“重新计算”；
- 自动处理回执展示“正式入库 → 地图更新 → 领导消息”三步状态；
- 可展开“查看处理凭证”，展示业务事件、Outbox、分析运行、地图版本和领导通知的真实 UUID；
- 右上角铃铛和右侧消息抽屉，消息可深链到正式记录；
- 作战地图按责任范围裁剪，销售看自己的对象，领导看管理观察范围；
- 领导可在 `/ask` 选择销售和周期，得到有证据、可深链的确定性周进展；
- `/reports` 已有个人/管理范围周报的生成、审阅、发布与通知流程；
- `/actions` 支持 AI 建议动作独立接受/拒绝、正式动作状态和提醒。

### 后端治理与可靠性

- PostgreSQL migrations 已推进到 `0017_worker_execution_lease.sql`；
- 作战规则已从代码硬编码迁移为租户级不可变版本、当前发布和回滚；API、Worker、管理台、经营对象阶段标签共用同一发布规则；
- 作战状态显示自动/手动触发、规则版本、分析器版本和运行 ID；
- Worker 使用租户/worker-key 单实例执行租约：第二实例启动失败，异常退出可过期接管，正常退出立即释放；
- PostgreSQL pool 已安装 idle-client error listener，API/Worker 不会因未监听 pool error 直接触发 Node 未捕获事件；
- 审计列表支持操作者、对象、动作、时间和游标筛选，并按当前对象责任范围裁剪；
- 审计统一写入口会自动继承事务 `app.request_id`；
- Worker 管理页提供心跳、队列统计、失败/死信和人工重放。

## 3. 真实环境已验证的事实

- 服务器使用宝塔原生 PostgreSQL 16.15；权威数据目录为 `/www/server/pgsql/data`；
- 业务数据库为 `battlefield_dev`；旧 apt PostgreSQL 和旧数据目录已经删除，不再保留两套实例；
- 正式库已应用迁移 `0017_worker_execution_lease`；
- 真实个人模型连接测试成功；
- 一次真实 SenseAudio 草稿拆解在严格 Prompt 下成功并完成人工确认；
- 真实自动分析与手动分析都记录 `battle-rules-v1-r1 / deterministic-v1`；
- 一条系统验收跟进已完整得到 published Outbox、completed analysis、地图版本和 1 条领导通知；
- 正式库双 Worker 验收通过：第二实例被租约拒绝，正常退出后租约为 0 行；
- 正式跟进读取产生的 `followup.viewed` 审计已验证自动携带 UUID request ID。

以上均是开发库事实，不代表生产部署已经完成。

## 4. 设备迁移时必须单独安全转移的内容

以下内容故意不进入公开 GitHub：

- `.env.local`；
- `.env.migrate.local`；
- SSH 私钥；
- SenseAudio API Key 原文；
- 数据库管理员/应用账号口令；
- 任何客户真实数据或飞书内部链接内容。

特别注意：新设备的 `AI_CREDENTIAL_ENCRYPTION_KEY` 必须与旧设备一致，否则数据库中已经加密的个人 SenseAudio Key 无法解密。SSH 私钥在新设备上需设为 `0600`。

## 5. 新设备启动顺序

### 5.1 获取代码

```bash
git clone https://github.com/ERICEPC/ai-customer-battlefield.git
cd ai-customer-battlefield
git checkout main
git pull --ff-only origin main
git rev-parse HEAD
```

期望基线至少为 `51fc19e` 或其后续提交。

### 5.2 安装运行时

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
```

Node.js 需要 `>=24.15.0 <25`。

### 5.3 恢复私有环境

把旧设备的 `.env.local`、`.env.migrate.local` 和 SSH 私钥通过安全方式转移到新设备。不要从公开仓库寻找这些文件。

建立本地端口转发，实际主机和私钥路径从用户提供的私有信息填写：

```bash
chmod 600 <SSH_PRIVATE_KEY>
ssh -fN \
  -L 127.0.0.1:55432:127.0.0.1:5432 \
  -i <SSH_PRIVATE_KEY> \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=12 \
  -o TCPKeepAlive=yes \
  root@<DB_SERVER_HOST>
```

确认隧道：

```bash
lsof -nP -iTCP:55432 -sTCP:LISTEN
```

### 5.4 启动三个应用进程

API：

```bash
set -a
source .env.local
set +a
pnpm --filter @battlefield/api dev
```

Web：

```bash
pnpm --filter @battlefield/web exec next dev --hostname 127.0.0.1
```

Worker：

```bash
set -a
source .env.local
set +a
export WORKER_TENANT_ID=10000000-0000-4000-8000-000000000001
export WORKER_USER_ID=30000000-0000-4000-8000-000000000001
apps/worker/node_modules/.bin/tsx apps/worker/src/main.ts
```

开发验收时建议直接启动 `tsx` Worker；相较 `pnpm dev` 包装层，它能在 SIGINT/SIGTERM 下完成租约释放。正式部署应交给 systemd、Docker Compose 或其他 supervisor，不能依赖 Codex 终端和开发机 SSH 隧道长期运行。

### 5.5 健康检查

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:3001 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3001/api/v1/health/live
```

打开 <http://localhost:3000/login>。

## 6. 新设备第一轮人工验收

不要先跑全量测试。先验证真实可见主链：

1. 用销售账号登录，打开右上角账号菜单，确认“销售身份 / 商业化一部 / 直属领导A”；
2. 打开个人设置，确认 SenseAudio Key 显示已配置且模型可见；必要时测试模型连接；
3. 回到 `/`，选择“云岭新能源汽车股份有限公司”，输入一条新的合成跟进；
4. 观察真实 AI 拆解，核对并确认入库；
5. 确认页面展示正式记录、经营事实、三步自动处理状态和可展开处理凭证；
6. 打开 `/entities`，确认最新跟进和更新时间变化；
7. 打开 `/battle-map`，确认无需手动重算即可看到新地图版本；
8. 打开铃铛，确认消息抽屉及深链；
9. 退出并登录领导账号，确认能看到销售1的记录和管理范围地图；
10. 在 `/ask` 询问“销售1这周有什么进展”，确认回答引用刚才的正式记录并提供深链；
11. 领导打开 `/admin`，确认权限、AI 配置、作战规则、Worker 状态和审计均按能力独立加载。

推荐使用包含明确日期、金额、阶段和下一步的合成文本，避免相对日期造成模型契约歧义。例如：

> 2026年9月1日与云岭汽车智能座舱项目负责人开会，客户确认一期预算380万元，当前进入方案验证，要求2026年9月8日前提交POC排期；下一步由销售1整理技术方案并预约评审。

## 7. 尚未完成或需要继续深化

按优先级继续：

1. **重新完成一轮新设备真实主链验收。** 当前代码和正式库已分别验证，但设备迁移后必须重新证明 Web/API/Worker/隧道共同工作；
2. **正式部署与进程守护。** API、Web、Worker 目前仍是开发进程；SSH 隧道曾多次远端超时，长期方案应部署到服务器内网直连 PostgreSQL；
3. **管理员完整业务链追踪。** 销售回执已有处理凭证，管理台仍缺少按 followup/event/outbox/analysis/notification 任一 ID 打开的统一链路详情；
4. **审计请求上下文标准化。** 新审计会自动继承事务 request ID，但部分旧 store 仍把资源 ID作为事务 request ID，历史 null 不回填；后续应在 API 边界建立统一请求上下文；
5. **权限体系深化。** 当前能力管理和对象责任范围已可用，但组织仍只有销售/直属领导两层；多级部门、老板全局视图、字段级权限和正式 OIDC 未完成；
6. **通知渠道完善。** 站内铃铛闭环完成，飞书 adapter 可选；真实邮件/飞书生产配置、失败告警和渠道管理 UI仍需验收；
7. **规则/Prompt 测试沙箱。** 版本、发布、回滚已实现，尚缺管理员在发布前用固定样例回放并对比结果；
8. **导入迁移。** 飞书数据批量导入、去重、预检和错误报告只保留架构豁口，尚未实现；
9. **文档漂移。** 根 README 的 “Still in progress” 段落落后于当前代码，仍把周报、Prompt/规则配置写成未实现，应在下一轮按代码与验收事实修正；
10. **最终生产安全。** 正式 OIDC、Secret Manager、字段级脱敏、备份恢复演练、监控告警和发布回滚仍未封板。

## 8. 验证策略

用户要求小步快跑：

- 单组件/单模块只跑聚焦测试、受影响 typecheck、Biome 和 `git diff --check`；
- 数据库、权限、跨模块或阶段封板再跑匹配集成测试；
- 不要每个小提交都跑全量 CI；
- 每个切片直接提交并推送 `main`；
- 每次说明“用户页面能看到什么、如何手动验收”，不要只报告测试绿色。

最近四个切片的聚焦证据：

- Worker 执行租约：database 1/1、worker 11/11、正式双进程互斥通过；
- 自动化处理凭证：contracts 14/14、worker 自动化 1/1、Web 10/10、正式库只读链路通过；
- 审计请求关联：database 2/2、正式库新 viewed 审计 request ID 通过；
- PostgreSQL pool error：database 2/2、database/API/worker typecheck 通过。

## 9. 工作区与停止状态

- `main` 与 `origin/main` 都停在 `51fc19e`；
- 本轮功能代码和交接包之外没有应提交的 Agent 改动；
- 旧设备 `apps/web/next-env.d.ts` 有 Next.js 自动生成的 dev 类型路径变化，始终未纳入提交；新设备不需要手工搬运，启动 Next.js 后会按环境再生成；
- 本轮启动的 Worker 已优雅停止；
- 本轮创建的 SSH 隧道已停止；
- 旧设备上原有 Web/API 开发进程未被停止；
- 持续目标未宣告完成，只因用户换设备而暂停。

## 10. 关键文档入口

- `docs/01-V1产品设计总纲.md`
- `docs/02-业务数据模型.md`
- `docs/03-UI与交互设计.md`
- `docs/04-系统架构与详细设计.md`
- `docs/superpowers/specs/2026-08-31-business-first-demo-core-design.md`
- `docs/superpowers/plans/2026-09-01-management-capabilities.md`
- `docs/superpowers/specs/2026-09-01-battle-rule-governance-design.md`
- `docs/superpowers/plans/2026-09-01-battle-rule-governance.md`
- `docs/acceptance/2026-08-31-stage-1-two-level-login.md`
- `docs/acceptance/2026-08-31-stage-2-agent-intake.md`

遇到文档与代码冲突时，以已推送代码、SQL migrations、最新验收事实和本交接包为准，再原地修正文档。
