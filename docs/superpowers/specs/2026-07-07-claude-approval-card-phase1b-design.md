# 设计：Phase 1b —— 飞书审批卡片 + auto 权限模式

- 日期：2026-07-07
- 状态：已批准（待写实现计划）
- 前置：Phase 1a（SDK 驱动适配器 + 审批机制，分支 `worktree-claude-sdk-driver-spec`，整分支评审 Ready-to-merge）
- 作用范围：`src/bot/channel.ts`、`src/card/`（新增审批卡片模块）、`src/commands/`（回传处理器）、`src/config/permissions.ts`、`src/config/profile-schema.ts`、`src/cli/commands/start.ts`、`src/agent/claude/sdk-adapter.ts`（新增一个事件）、`src/agent/claude/sdk-translate.ts`（permission_denied 注记）、相关测试

## 1. 目标

把 Phase 1a 造好但闲置的交互审批机制接到飞书侧，交付用户可见的能力：

1. **审批卡片**：Claude 请求执行危险操作时，飞书弹出独立卡片（放行/拒绝按钮），点按即回传；5 分钟无人处理由适配器自动拒绝。
2. **auto 权限模式为 full 访问的新默认**：模型分类器代替人做大多数批/拒判断，仅疑难操作升级弹卡。打扰量远低于纯手动审批，是异步聊天形态的最优解。
3. 收尾项：`claude` profile 配置字段、真机端到端验证（Phase 1a 从未对真实 `claude` 运行过）、Phase 2 入场门实验。

非目标：长驻会话与中途转向（Phase 2）；聊天命令开关审批（YAGNI，审批随权限模式自动生效）；多用户 token 隔离。

## 2. auto 权限模式

SDK `permissionMode: 'auto'`：模型分类器对每个权限请求三路决断——

| 分类器判断 | 走向 | 对接部件 |
|---|---|---|
| 明确安全 | 自动放行 | 无感 |
| 明确危险 | 自动拒绝 | SDK 发 `permission_denied` 消息 → 流式卡片一行注记 |
| 拿不准 | 升级询问 → `can_use_tool` 回调 | Phase 1a 的 `canUseTool` → 审批卡片 |

落地：

- `src/config/permissions.ts` 的 `ClaudePermissionMode` 加入 `'auto'`；access 钳制表中 `auto` 对应 `full` 访问级别（分类器可自主放行危险操作）。
- **默认映射变更**：`full → auto`（原 `full → bypassPermissions`）。`read-only → plan`、`workspace → acceptEdits` 不变。想回到全盲放：profile 里显式 `permissions.claude.permissionMode: 'bypassPermissions'`（现有覆盖机制，不越 access 上限校验保留）。
- 适配器无需改动：`auto ≠ bypassPermissions`，`canUseTool` 已按现有条件挂载；`approvalEnabled: true` 后升级询问自然走卡片。
- **入场核查（计划第一步）**：验证本机 `claude` 版本支持 `auto` 模式（`claude --help` / 实跑确认），不支持则本节降级为"仅作可选覆盖"并停止默认变更。

## 3. 契约补充：`permission_resolved` 事件

**问题**：审批出结果时卡片由谁改写。超时拒绝发生在适配器内部（`settle()` 漏斗）；卡片层若自设镜像计时器，会出现两个时间权威，边界点击产生"卡片显示超时、实际已放行"的矛盾。

**解法**：适配器在 `settle()` 处推事件，卡片纯被动跟随唯一权威：

```ts
| { type: 'permission_resolved'; id: string; decision: 'allow' | 'deny';
    reason: 'user' | 'timeout' | 'aborted' }
```

**已知边界**：run 终止时的强制收尾发生在 `done`/`error` 之后，而 `run-executor.observeRunEvents` 在终止事件即截断流，此时的 `permission_resolved` 不会到达消费方。因此 channel 侧在事件循环退出时**兜底清扫**：把仍待决的审批卡片改写为"运行已结束，自动拒绝"。中途超时/用户点击两条路径由事件正常驱动。

`respondPermission` 保持 `void` 返回；对已收尾请求的点击是 no-op，卡片状态以 `permission_resolved` 为准。

## 4. 审批卡片与回传（复用现有机制，零新基建）

- **发卡**：`processAgentStream`（`src/bot/channel.ts`）新增 `permission_request` 分支——与 `system`/`usage` 特判并列、`continue` 掉，**不进** `reduce`/流式卡片。经 `runAgentBatch` 传入的 `onPermissionRequest` 闭包（持有 `channel`/`chatId`/`callbackAuth`/`senderId`/`sendOpts`）调用 `sendManagedCard` 发独立卡片：
  - 标题：事件的 `title`（claude 生成的完整提示句，如"Claude wants to run …"）；缺省回退 `displayName`/`toolName`。
  - 正文：工具名 + 入参摘要（截断）+ `description`（若有）+ 静态提示"N 分钟内未处理将自动拒绝"（N 来自配置，默认 5）。
  - 按钮：复制流式卡片"⏹ 终止"按钮的签名模式（v2 schema `behaviors: [{type:'callback', value}]` + `bridge_token`），action `perm.allow` / `perm.deny`，permission `id` 放入 value（id 不在签名上下文元组中，必须随 value 携带）。
- **鉴权**：`bridge_token` 签名上下文绑定 runId/scope/chatId/operatorOpenId——**仅发起本轮消息的人可点**；`CallbackNonceStore` 一次性 nonce 防重放（同一按钮二次点击失效）。与"个人自用"决策一致。
- **回传**：dispatcher 现有签名回调分支（`verifyBridgeToken` 要求活跃 run）路由到命令注册表，新增 `perm` 命令处理器：`activeRuns.get(scope).run.respondPermission(id, decision)`。处理器不改卡片。
- **卡片终态**（`updateManagedCard` 原地改写，由 `permission_resolved` 事件或兜底清扫驱动）：已放行（user/allow）、已拒绝（user/deny）、超时自动拒绝（timeout）、运行结束自动拒绝（aborted/清扫）。
- **并发**：每请求一卡，按 `id` 键控（`onPermissionRequest` 闭包内维护 `id → messageId` 映射，循环退出时据此清扫）。

## 5. 可见性：分类器拒绝注记

`sdk-translate.ts` 新增对 SDK `permission_denied` 消息的翻译，映射为流式卡片上的一行注记（如"⛔ 工具 Bash 被自动拒绝"）。否则 auto 模式下分类器的静默拒绝会让用户困惑 Claude 为何绕路。实现计划阶段以 SDK 出厂类型核对该消息的确切形状与 type 名。

## 6. 配置

- `profile-schema` 新增 `claude?: { env?: Record<string, string>; approvalTimeoutMinutes?: number }`（env 键值校验参照 codex 字段的既有 normalize 风格）。
- `createRuntimeAgent`（`start.ts:437`）改为：

```ts
return new ClaudeSdkAdapter({
  larkChannel,
  approvalEnabled: true,
  ...(profileConfig.claude?.env ? { env: profileConfig.claude.env } : {}),
  ...(profileConfig.claude?.approvalTimeoutMinutes
    ? { permissionTimeoutMs: profileConfig.claude.approvalTimeoutMinutes * 60_000 }
    : {}),
});
```

- 不新增聊天命令、不新增审批粒度配置（安全白名单已内建于适配器）。

## 7. 验证与测试

**真机冒烟（人工 checklist，收进实现计划）**：
1. full（→auto）模式跑一整轮：流式收尾/stall 兜底与 Phase 1a 前行为对等（spec §5.3 的兑现）；观察分类器放行/拒绝注记。
2. 审批全流程各一次：弹卡→放行、弹卡→拒绝、弹卡→超时自动拒绝（可临时把 `approvalTimeoutMinutes` 调小）。
3. 非发起人点击被拒（若有条件）；同按钮二次点击失效。

**自动化**：
- 适配器：`settle()` 三条 reason 路径均发出 `permission_resolved`（user/timeout/aborted）。
- 卡片构建器：待决 + 四种终态的结构断言。
- dispatcher：`perm.allow`/`perm.deny` 路由到 `respondPermission`（复用 fake-channel/fake-agent helpers）；token 校验失败路径。
- `permissions.ts`：`auto` 的映射与钳制；`full` 默认 → `auto`；显式覆盖回 bypass 仍可用。
- 契约测试补 `permission_resolved`；顺带补 `SAFE_READONLY_TOOLS` 直接断言（Phase 1a 遗留 Minor）。

## 8. Phase 2 入场门实验（随行任务，不进 src）

用最小脚本（scratchpad，不提交进 src）验证 SDK streaming input 模式的 mid-turn steering：任务执行中途注入新 user 消息，观察是被当轮吸收还是排队到下轮。结论写入 `docs/superpowers/specs/` 下的一页纪要，作为 Phase 2 设计的入场门证据。超时盒：半天；结论不阻塞本阶段任何任务。

## 9. 风险

- **默认行为变更**（full→auto）：分类器可能拒绝以前默认放行的操作。缓解：`permission_denied` 注记可见 + 一行 profile 覆盖回 bypass + 入场核查确认版本支持。
- 卡片发送失败：log 后放任适配器超时兜底，run 不会卡死。
- run 结束后的点击：`verifyBridgeToken` 要求活跃 run，天然拒绝。
- 分类器额外消耗订阅额度：auto 模式每个权限判断是一次模型调用；个人自用量级可忽略，若敏感可覆盖回 bypass。

## 10. 实现计划阶段须先做的事

以 SDK 出厂 TypeScript 类型核对：`'auto'` 在 `PermissionMode` 联合中的确切拼写、`permission_denied` 消息（`SDKPermissionDeniedMessage`）的字段形状、升级询问到 `canUseTool` 的行为是否如 §2 表格所述。Phase 1a 的教训：文档不可靠，类型为准。
