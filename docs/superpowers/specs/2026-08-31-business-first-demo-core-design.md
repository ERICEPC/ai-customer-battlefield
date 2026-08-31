# 业务优先的演示核心闭环设计

## 1. 目标

第一阶段不再扩展周报调度、通用管理后台或更多外围模块，而是让用户从一条自然语言经营信息开始，真实看到：

```text
登录系统
  → 录入一条客户经营信息
  → Agent 读取受控业务上下文并智能拆解
  → 用户逐项核对、修改和选择
  → 分类型写入正式业务对象或待确认候选
  → 产生可追溯的分析、动作和站内消息
  → 从右上角铃铛回到具体记录和页面位置
```

演示成功不以页面数量或测试颜色为标准，而以这条业务链是否真实、连贯、可解释和可重复为标准。测试、迁移和审计只作为保证业务链不会被破坏的手段。

系统用两种同步视图呈现同一份正式数据：

- AI Native 作业视图负责自然语言录入、Agent 分析、人工核对、地图判断、消息推动和管理问询；
- 只读经营数据台账负责展示原始录入及其拆解后形成的业务记录，让销售和领导能够确认数据确实保存、关联并可追溯。

台账不是通用 CRM 或飞书 Base 克隆，不提供任意单元格编辑、公式、自动化编排或低代码建表。

## 2. 实施边界

本设计包含七个连续、逐轮可见验收的切片：

1. 销售/直属领导两层身份、登录、退出和部门数据范围；
2. 真实 AI 录入、Prompt/模型配置和运行状态；
3. 人工核对与确定性分类型入库；
4. 只读经营数据台账与来源追溯；
5. 基于已确认事实自动更新作战地图；
6. 销售与直属领导的站内消息推送；
7. 直属领导基于 Agent 问询部门内某位销售的进展。

V1 演示暂不实现外部 SMTP 邮件发送、自动周报调度、通用组织权限后台、小程序、任意 SQL Agent 或无人值守正式写入。完整通知中心页面继续保留，铃铛抽屉是它的高频入口。

## 3. Agent 底座选择

### 3.1 选择

产品核心采用本系统定义的 `AgentRuntime`、`BusinessTool` 和版本化配置，不把 OpenClaw 作为 NestJS 业务运行时的必需进程。

SenseAudio 官方提供兼容 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 的接口，并支持 Function Calling、JSON 输出及流式响应。首个 provider adapter 直接调用：

- Base URL：`https://api.senseaudio.cn/v1`；
- 首选接口：`POST /responses`，若结构化能力兼容性不足则由同一 adapter 内部回退到 `POST /chat/completions`；
- 首选模型：`senseaudio-s2`；
- 凭据：只从 `SENSEAUDIO_API_KEY` 环境变量或未来 Secret Provider 读取；
- API Key、请求原文和模型原始响应不得进入 Git、普通应用日志或审计正文。

OpenClaw保留为未来飞书聊天入口、独立对话助手或运维调试 adapter。它可以使用相同的 Business Tool API，但不能绕过本系统身份、授权、人工确认和审计。

### 3.2 深接口

```ts
interface AgentRuntime {
  run<TInput, TOutput>(input: {
    actor: ActorContext;
    capability: "analyze_business_intake";
    input: TInput;
    outputSchema: JsonSchema;
    tools: BusinessToolDefinition[];
    config: PublishedAgentConfiguration;
    traceId: string;
  }): Promise<AgentRunResult<TOutput>>;
}

interface BusinessTool<TInput, TOutput> {
  name: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  execute(actor: ActorContext, input: TInput): Promise<TOutput>;
}
```

Agent 不能获得数据库连接、表名、任意 SQL、跨租户查询能力或正式确认接口。Tool 调用必须经过与 Web 相同的 ActorContext、责任关系和 RLS。

首批只读 Tool：

- `search_business_entities`：按名称或别名匹配当前用户可见经营对象；
- `get_entity_context`：读取经营对象、联系人、开放商机、近期事实和开放动作摘要；
- `get_opportunity_context`：读取指定商机当前阶段、责任人和近期变化。

## 4. 一条信息的智能拆解

### 4.1 输入

用户可以先选择经营对象，也可以只输入自然语言让 Agent 给出对象匹配候选。V1 接受文本和发生时间；语音、图片和附件随后复用同一入口，在进入 Agent 前转换为带来源的文本证据。

### 4.2 输出审阅包

Agent 必须输出严格结构化的 `BusinessIntakeReviewBundle`：

```ts
interface BusinessIntakeReviewBundle {
  entityMatch: {
    entityId: string | null;
    displayName: string;
    confidence: number;
    evidenceQuote: string;
  };
  followup: {
    summary: string;
    followupType: "meeting" | "call" | "message" | "email" | "other";
    occurredAt: string;
  };
  contactCandidates: Array<{
    existingContactId: string | null;
    name: string;
    title: string | null;
    organizationName: string | null;
    evidenceQuote: string;
    confidence: number;
  }>;
  opportunityCandidates: Array<{
    opportunityId: string | null;
    opportunityName: string;
    isPrimary: boolean;
    evidenceQuote: string;
    confidence: number;
  }>;
  facts: Array<{
    factType: string;
    factValue: string;
    opportunityId: string | null;
    evidenceQuote: string;
    confidence: number;
  }>;
  stageChangeProposals: Array<{
    opportunityId: string;
    fromStage: string;
    toStage: string;
    reason: string;
    evidenceQuote: string;
    confidence: number;
  }>;
  actionProposals: Array<{
    title: string;
    description: string;
    suggestedOwnerId: string | null;
    suggestedPriority: "low" | "medium" | "high" | "urgent";
    suggestedPlannedAt: string | null;
    evidenceQuote: string;
    confidence: number;
  }>;
  dataGaps: string[];
}
```

所有 `evidenceQuote` 必须是输入原文的真实子串；`entityId`、`contactId`、`opportunityId` 和 `ownerId` 必须来自 Tool 返回值，模型不能编造标识。低置信度结果仍可展示，但默认不勾选。

### 4.3 人工核对与正式写入

前端把审阅包按“跟进、联系人、商机、事实、阶段变化、下一步动作”分区展示。用户可以修改字段、取消勾选和补充遗漏项。

确认后仍保留领域边界：

- 跟进、参与人、商机关联、所选事实和证据在现有跟进确认事务中原子提交；
- 新联系人及任职关系通过联系人应用接口创建，不能由 Agent 直接插表；
- 商机阶段变化通过新增的受控阶段转换接口校验当前阶段、权限和乐观版本；
- 下一步动作先成为 `action_proposal`，仍需在动作中心单独确认负责人、时间和优先级后才成为正式动作；
- 某一区域提交冲突时保留用户审阅内容并明确标出，不用静默覆盖或重复执行其他已成功区域。

## 5. Prompt、模型与运行记录

新增版本化配置对象：

- `model_profile_versions`：provider、base URL、model、temperature、max tokens、timeout 和状态；
- `agent_prompt_versions`：capability、system prompt、output schema version、允许的 Tool、状态和发布时间；
- `agent_runs`：actor、capability、输入 hash、模型/Prompt/规则版本、状态、token、耗时、输出 hash和安全错误摘要；
- `agent_tool_calls`：run、Tool 名称、参数 hash、结果 hash、耗时和状态。

API Key 只使用 secret reference，不进入上述表。系统提供一个最小 AI 配置页，可查看当前发布版本、编辑草稿、执行合成样例校验、发布新版本和回滚到历史版本。没有已发布配置或密钥时，录入页明确显示“AI 服务未配置”，不能悄悄退回假 Agent 冒充智能分析。

默认 Prompt 必须明确：只提取输入中存在的事实；标识只能使用 Tool 返回值；不确定时输出数据缺口；不得做承诺、虚构阶段或自动批准正式动作。

## 6. 登录、退出与两层身份

### 6.1 会话

新增本地账号凭据和服务端会话 adapter：

- 用户使用租户标识、邮箱和密码登录；
- 密码只保存强哈希；
- 浏览器只保存 `HttpOnly`、`SameSite=Lax` 会话 cookie；
- 数据库存储会话 token 的 hash、到期时间、最后使用时间和撤销时间；
- `/auth/session` 返回当前用户、租户、可用工作视角和未读消息数；
- 退出登录立即撤销会话；
- Web API 不再依赖浏览器自行提交 `x-tenant-id` 和 `x-user-id`。

开发身份头只允许自动化测试或显式本地诊断，正常演示必须经过登录页。

### 6.2 两层组织关系与权限

V1 只实现“直属领导 → 部门销售”两层关系：

- 销售用户属于一个当前有效部门，并拥有 `sales` membership；
- 直属领导属于同一部门，并拥有 `department_leader` membership；
- 销售只能读取本人负责、协作或提交的经营记录；
- 直属领导可以读取本部门全部当前销售的经营记录、地图点位、动作和消息依据；
- 直属领导不能读取其他部门；
- 部门与角色关系保留有效期，人员调动不覆盖历史记录；
- V1 不实现上级的上级、跨部门矩阵汇报、区域层级或任意组织树继承。

右上角账户菜单显示姓名、邮箱、身份、所属部门、销售对应的直属领导和退出登录。演示环境提供“销售1”和“领导A”两个真实登录账号；身份切换通过退出后登录另一个账号完成，不伪装成前端角色开关。

### 6.3 领导问询边界

领导A可以在团队问询页选择本部门销售和时间范围，再用自然语言询问进展。Agent 只能调用授权的团队进展 Tool，回答必须来自正式跟进、事实、阶段历史、作战状态和动作，并附业务深链；没有足够数据时明确返回数据缺口。用户标识或自然语言不能绕过部门范围。

## 7. 只读经营数据台账

统一 `/data` 工作台按业务页签展示：原始录入、正式跟进、联系人及任职、商机及阶段历史、经营事实及证据、作战状态及历史版本、动作建议与正式动作、站内消息。

- 支持基本搜索、筛选、排序、分页和行详情抽屉；
- 记录详情显示来源、销售、部门、关联对象、发生时间、确认时间和业务深链；
- 一次录入确认后的结果回执直接链接到本次新增或更新的台账记录；
- 销售看到本人范围，直属领导看到本部门范围，其他部门数据统一按不存在处理；
- 台账不提供任意单元格编辑，正式修改仍走受控业务表单、状态机、版本和审计。

## 8. 铃铛与右侧消息抽屉

在账户菜单左侧增加铃铛：

- 未读数为 1–99，超过显示 `99+`；
- 点击从右侧打开抽屉，不离开当前业务页面；
- 抽屉按未读优先、时间倒序展示消息类型、标题、摘要、时间和状态；
- 支持“全部标为已读”和单条已读；
- 点击消息先记录已读，再跳转到消息保存的精确业务深链；
- 动作提醒跳到 `/actions?actionId=...`；
- 周报发布跳到 `/reports?reportId=...&versionId=...`；
- 后续跟进、分析和阶段变化消息使用各自的精确对象和版本标识；
- 失权或记录不存在时显示受控提示，不能泄露对象是否仍存在。

销售确认跟进后，系统给销售本人生成结果消息；完成作战分析后，系统解析该销售当前部门的直属领导。发生阶段变化、象限变化、明显升降或高风险时，给直属领导生成站内消息，并保存事件发生时的收件人和部门依据用于审计。外部 SMTP 邮件不属于当前切片，“邮箱”在本阶段指站内消息中心。

完整 `/inbox` 页面继续用于筛选、分页和历史查询。文案按事件类型展示，不再把周报消息统一写成“查看相关动作”。

## 9. 失败和降级

- 模型超时、限流或非结构化输出：保存失败的 Agent run，不创建草稿，页面保留原始输入并允许使用同一请求重试；
- Tool 失权或对象变化：停止本次分析并提示重新选择，不使用旧上下文；
- 人工确认冲突：保留本地审阅包，加载最新服务端版本后逐项重新应用；
- 登录过期：保存尚未提交的录入文本到浏览器会话存储，重新登录后恢复；
- 消息抽屉不可用：不阻断当前业务操作，完整通知页和业务事实仍保持一致；
- 不配置外部邮件或飞书时，站内消息仍是完整可演示闭环。

## 10. 验收场景

演示验收必须真实走通以下路径：

1. 使用销售1账号登录，右上角显示销售身份、所属部门、直属领导A和退出；
2. 输入一段同时包含客户、联系人、商机、预算/时间事实、阶段变化和下一步动作的自然语言；
3. 系统真实调用 SenseAudio，并显示本次使用的模型与 Prompt 版本；
4. 审阅页按六个业务分区展示提取结果、证据原句、置信度和数据缺口；
5. 用户修改并取消至少一项后确认；
6. 正式跟进、事实和证据可读回，联系人/阶段按所选项提交，动作进入待确认建议而非直接成为正式动作；
7. `/data` 各业务页签能看到本次原始输入和结构化记录，并能相互追溯；
8. 确认事实后自动生成新的作战状态版本，地图展示点位变化、原因和证据；
9. 销售1的铃铛出现结果消息；关键变化时领导A也出现未读消息，点击能到准确记录或地图点位；
10. 退出销售1并登录领导A后，可以查看部门销售名单、销售1的记录和部门地图，但不能查看其他部门；
11. 领导A询问“销售1这周有什么进展”，回答只引用部门内正式数据并提供深链；
12. 退出后受保护页面不可访问；重新登录后数据、地图和消息仍存在；
13. Agent provider 替换为测试 adapter 时，业务用例、Tool、人工确认和数据库接口无需改动。

## 11. 分阶段可见交付

1. 真实登录和两层身份：销售1看到部门与领导A，领导A看到部门销售名单，双方可退出重登且权限不同；
2. 真实 Agent 录入：自然语言产生与输入对应的结构化审阅包，并显示模型、Prompt 和运行状态；
3. 人工核对入库：确认前不改变正式数据，确认后展示逐项入库回执；
4. 只读台账：本次原始输入和各类正式记录立即可见并可追溯；
5. 地图更新：自动展示作战状态前后、位置原因和证据；
6. 跨身份消息：销售收到结果，关键变化通知直属领导，消息精确深链；
7. 领导 Agent 问询：领导选择销售1并获得有证据的部门范围进展回答。

每阶段完成后直接推送 `main`，交付访问地址、演示账号、操作步骤、预期页面结果和已知边界。自动化测试只作为回归护栏，不作为用户可见功能完成的替代证明。
