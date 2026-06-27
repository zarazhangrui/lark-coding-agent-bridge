# Pi Harness 接入 lark-channel-bridge 详细报告

> 目标:把 `pi-mono`(`/home/yy/tools/pi-mono`)的 `pi` coding-agent 作为第三种 agent 接入 bridge。
> 评估日期:2026-06-27
>
> 🔧 **修订(2026-06-27)**:本文档已经过对 pi-mono 源码 + bridge 源码 + pi CLI 实跑(`pi --help` / `--mode json` 实测)的对抗性核验(6 维度 35 条断言 + 双向遗漏扫描,经独立 skeptic 复核)。主要修订:① §1 协议措辞从「完全一致」改为「传输形态一致、schema 不同」;② §1.2 补「5 类事件被丢弃」;③ 新增 §1.4「运行环境前提」;④ §3 补 registry/locks/run-policy/migrate 等遗漏卡点;⑤ §3.5 统计口径修正(51→33)。标注 🔧 处为修订/补充,完整清单见文末「修订日志」。

## 结论速览

**可行性:高。** Pi 的 CLI 已经原生支持 bridge 所需的全部能力(NDJSON 流式输出、system prompt 注入、session 续接、模型/工作目录指定),**Pi 侧零改动**。成本全部集中在 bridge 这边把「claude/codex 二元硬编码」打开成「可注册第三种 agent」。

| 维度 | 评估 |
|---|---|
| Pi CLI 接口完备性 | ✅ 完全满足,参数几乎与 Claude Code 同名 |
| bridge 适配器实现 | 小,仿照 `ClaudeAdapter` |
| bridge 类型/分支重构 | **大**,这是真正的工作量 |

---

## 一、Pi 侧能力核实(无需改动,仅消费)

Pi 的非交互流式模式在 `packages/coding-agent/src/modes/print-mode.ts:103-107`:

```ts
unsubscribe = session.subscribe((event) => {
    if (mode === "json") {
        writeRawStdout(`${JSON.stringify(event)}\n`);   // 每行一个 NDJSON 事件
    }
});
```

即 `pi --mode json -p "<prompt>"` 会在 stdout 逐行输出 NDJSON,**传输形态**(逐行 NDJSON over stdout)与 Claude Code 的 `--output-format stream-json` **一致**,bridge 现有的「逐行读 stdout → `JSON.parse` → translate」**框架**可复用。🔧 **修订**:但**事件 schema 完全不同**——Pi 用 `agent_start`/`message_update`(嵌套 `assistantMessageEvent`)/`tool_execution_*`,Claude 用 `system`/`assistant`/`result`;现有 `src/agent/claude/stream-json.ts` **一行都不能复用**,必须新写 `src/agent/pi/stream-json.ts`(见 §1.2 翻译表)。原文「协议形态完全一致 / 原样复用」的措辞已废弃。

### 1.1 Pi 事件类型

定义在 `packages/agent/src/types.ts:350`,核心字段:

```ts
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

流式 delta 由嵌套的 `assistantMessageEvent` 承载(`packages/ai/src/types.ts:261`):

```ts
export type AssistantMessageEvent =
  | { type: "text_delta"; contentIndex: number; delta: string; ... }
  | { type: "thinking_delta"; contentIndex: number; delta: string; ... }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; ... }
  | { type: "done" | "error"; ... };
```

### 1.2 Pi ↔ bridge 事件映射(适配器要写的核心翻译)

| Pi 事件 | → bridge `AgentEvent`(`src/agent/types.ts:6`) |
|---|---|
| `message_update` + `assistantMessageEvent.type === "text_delta"` | `{ type: "text", delta: .delta }` |
| `message_update` + `assistantMessageEvent.type === "thinking_delta"` | `{ type: "thinking", delta: .delta }` |
| `tool_execution_start` | `{ type: "tool_use", id: .toolCallId, name: .toolName, input: .args }` |
| `tool_execution_end` | `{ type: "tool_result", id: .toolCallId, output: .result, isError: .isError }` |
| `agent_end` / 进程退出 | `{ type: "done", terminationReason: "normal" }` |
| 非零退出 / stderr 错误 | `{ type: "error", message, terminationReason: "failed" }` |

> 🔧 **修订 — 上表只覆盖 10 个事件中的 5 个,其余会被静默丢弃**。Pi 的 `AgentEvent` 联合(`packages/agent/src/types.ts:350`)共 10 个成员,上表只映射了 `message_update`/`tool_execution_start`/`tool_execution_end`/`agent_end`(+退出),**遗漏** `agent_start`/`turn_start`/`turn_end`/`message_start`/`message_end`/`tool_execution_update`。bridge 的 `AgentEvent`(`src/agent/types.ts:6-26`)没有成员能承载它们,照搬上表会**静默丢弃**(参照 `src/agent/claude/stream-json.ts:30-85`「只 yield 不报错」的模式)。
>
> **其中 `tool_execution_update`(承载 `partialResult`)是高价值实时数据**:`packages/coding-agent/src/core/tools/bash.ts:330-344` 对长时 bash 命令持续 emit 滚动 tail,经 `packages/agent/src/agent-loop.ts:581-592` 转成 `tool_execution_update`。若不映射,pi 下长命令在 `tool_execution_end` 之前**看不到中间输出**(真实 UX 退化,非理论问题)。建议把 `tool_execution_update` 增量映射到 `tool_use` 的 partial 更新,或退而映射成 `text` delta。
>
> 此外 `AssistantMessageEvent`(`packages/ai/src/types.ts:261`)实有 **13 个成员**(原文 §1.1 只列 4 个 + 省略号),其中 `toolcall_delta`/`toolcall_start` 承载工具调用参数的流式增量,同样需要决定是否映射。

### 1.3 参数对照

| bridge 需要 | Claude Code | **Pi** |
|---|---|---|
| 非交互单次执行 | `-p <prompt>` | `-p <prompt>` / `--print` ✅ |
| 流式 JSON 输出 | `--output-format stream-json` | `--mode json` ✅ |
| 追加 system prompt | `--append-system-prompt <text>` | `--append-system-prompt <text>` ✅ |
| 指定模型 | `--model <m>` | `--model <m>` / `--provider <p>` ✅ |
| 会话续接 | `--resume <id>` | `--session <id\|path>` / `--continue` ✅ |
| 工作目录 | spawn `cwd` 选项 | spawn `cwd` 选项 ✅ |

> 注意:Pi 没有 `--cwd` flag,工作目录靠 `spawnProcess` 的 `cwd` 选项传入,与 `ClaudeAdapter` 一致。

### 1.4 🔧 运行环境前提(原文遗漏,实测补充)

> 以下三条决定「Pi CLI flag 层零改动」成立、但**真实部署必须处理**的运行环境前提。实测证据见文末修订日志。

1. **stdout 在非交互模式被劫持**。pi 启动时若 `appMode !== "interactive"`(即 `print`/`json`/`rpc`),`packages/coding-agent/src/main.ts:451-453` 调用 `takeOverStdout()`(`packages/coding-agent/src/core/output-guard.ts:9-34`),把 `process.stdout.write` **整体重定向到 stderr**。实测:`pi --help` → stdout 0 字节 / stderr 7878 字节,`pi --version` 同理。**只有显式 `writeRawStdout()`(NDJSON 通道)才走真 stdout**。→ 适配器必须**分离监听**:stdout 只读 NDJSON,help/version/诊断/SDK 日志全走 stderr。bridge spawn 时 stdin 非 TTY 会自动判为 print 模式(`main.ts:105`)。

2. **pi 的 anthropic provider 不兼容 Claude Code 的同名环境变量**。全 pi-mono `grep ANTHROPIC_BASE_URL | ANTHROPIC_AUTH_TOKEN` **零命中**;pi 只认 `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN`(`packages/ai/src/env-api-keys.ts:97-99`),endpoint 只能来自 model registry(`model.baseUrl`,默认写死 `api.anthropic.com`,可经 `models.json` provider override,见 `packages/ai/src/core/sdk.ts:812/834/855`)。→ `piCapability` 必须**显式下发 `provider`/`model`/`apiKey`/`baseUrl`**,不能继承 Claude Code 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`。推荐用 `models.json` 自定义 provider(实测可行)。

3. **pi 无 `login`/`auth` 子命令**。登录只在交互式 TUI 的 `/login`(`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2506`),不存在 `pi login`。bridge spawn 后凭据只能预注入:① 环境变量(~30 个 provider key);② `--api-key <key>`(**必须同时给** `--model`,否则报错 `--api-key requires a model to be specified`,`main.ts:576-582`);③ 预先写 `~/.pi/agent/auth.json`(`0o600`,`packages/coding-agent/src/core/auth-storage.ts`)。配置家目录可用 `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` 覆盖(非 configDir 选项);`auth.json` 无法单独重定向。

> 补充:`--tools, -t <names>` 是 allowlist(逗号分隔);默认内置工具仅 `read/bash/edit/write`,`grep/find/ls` **默认关闭**;`--no-builtin-tools/-nbt` 只关内置、保留扩展/自定义工具(与 `--no-tools/-nt` 区别)。退出码:正常 0,`stopReason=error/aborted`→1(`print-mode.ts:131-136`),SIGTERM→143(`:54-65`),无 model→1(`main.ts:670`)。session 存储默认 `~/.pi/agent/sessions/<encoded-cwd>/session.jsonl`。

---

## 二、bridge 侧改动清单

### 2.1 新增适配器(工作量:小)

新建 `src/agent/pi/adapter.ts` + `src/agent/pi/stream-json.ts`,直接照搬 `ClaudeAdapter` 的骨架。关键 spawn 调用:

```ts
const args = [
  '--mode', 'json',
  '-p', opts.prompt,
  '--append-system-prompt', buildBridgeSystemPrompt(this.botIdentity),
];
if (opts.sessionId) args.push('--session', opts.sessionId);
if (opts.model) args.push('--model', opts.model);
// cwd 通过 spawnProcess 的 cwd 选项传入,不下发 --cwd
```

其余(stderr 监听、`stop()` 的 SIGTERM→SIGKILL、`waitForExit`、`createEventStream`)几乎可以逐行复制 `ClaudeAdapter`。

> 🔧 **修订 — 务必分离 stdout/stderr 监听**:见 §1.4 前提 1。pi 在 `json`/`rpc` 模式下 `takeOverStdout()` 把所有非 `writeRawStdout` 的 stdout 写重定向到 stderr——适配器从 stdout 读到的**只有纯 NDJSON**,`console.log`/SDK 诊断/banner 全在 stderr。不能像对待普通进程那样混读。`--mode rpc`(stdin JSON-RPC ↔ stdout JSON 事件)是双向通信的备选通道,值得评估。

### 2.2 capability 注册(工作量:小)

`src/agent/capability.ts` 当前只导出 `claudeCapability()` / `codexCapability()`。新增:

```ts
export function piCapability(profile?: ...): AgentCapability { ... }
```

并扩展类型:

```ts
export type AgentCapabilityId = 'claude' | 'codex' | 'pi';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'pi-session';
```

### 2.3 binary 探测(工作量:小)

`src/cli/agent-detection.ts:48-51` 的 `detectInstalledAgents()` 写死了两个候选,加入第三个:

```ts
{ kind: 'pi', command: process.env.LARK_CHANNEL_PI_BIN ?? 'pi' },
```

---

## 三、真正的卡点:类型耦合与硬编码分支(工作量:大)

这是接入第三个 agent 的结构性阻碍。根因是 `AgentKind` 被定义成**封闭的二元联合类型**,全项目对它做穷举式判断。

### 3.1 类型定义层

| 文件 | 关键定义 | 卡点 |
|---|---|---|
| `src/config/profile-schema.ts:16` | `export type AgentKind = 'claude' \| 'codex';` | 联合类型源头,扩展为三元 |
| `src/config/profile-schema.ts:161` | `if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex')` | 校验白名单,加入 `'pi'` |
| `src/agent/capability.ts:5-6` | `AgentCapabilityId` / `AgentSessionKind` 二元联合 | 见 2.2 |
| `src/cli/agent-detection.ts:5` | `export type AgentKind = 'claude' \| 'codex';` | 与 profile-schema 重复定义,需同步 |
| 🔧 `src/agent/preflight.ts:3` | `export type LocalAgentId = 'claude' \| 'codex';` | **第二处封闭联合**(修订补充),`AgentPreflightDiagnostic.agentId` 等都用它;`start.ts:377-379` 把非 codex 一律降级成 claude 诊断 |

### 3.2 适配器选择层(无注册表,纯 if/else)

| 文件:行 | 当前逻辑 | 卡点 |
|---|---|---|
| `src/cli/commands/start.ts:421-437` | `if (agentKind === 'codex') return new CodexAdapter(...); return new ClaudeAdapter(...)` | **核心分发点**。要么加 `else if (=== 'pi')`,要么改造成 `adapterRegistry.get(kind)` |
| `src/cli/commands/start.ts:377` | `agentId: agent.id === 'codex' ? 'codex' : 'claude'` | 二元断言 |
| `src/cli/commands/service.ts:471-473` | `agentKind === 'codex' ? {...} : {...}` | `ps` 显示名映射 |

### 3.3 配置/迁移层

| 文件 | 卡点 |
|---|---|
| `src/config/profile-store.ts:294` `agentKindFromString()` | 字符串→联合类型转换,白名单需加 `'pi'` |
| `src/config/migrate-v2.ts:122` | 迁移默认 `agentKind`,与新 agent 无直接冲突但需复核 |
| `src/cli/profile-bootstrap.ts:29` | codex 专属配置分支 |
| `src/runtime/profile-runtime.ts:90,285-302,398` | 多处 `=== 'codex'` 判断 codex 专属初始化 / 必填校验(`codex.binaryPath`)。Pi 需要等价的 `piConfig`?还是复用既有字段?**决策点** |
| 🔧 `src/runtime/profile-runtime.ts:394-399,571,615-617,111` | **(修订补充)** `resolveBootstrapAgent` profile 名 'pi' 解析不出 agent;`:571`/`:111` 错误文案写死 `claude\|codex`;`displayAgentKind:615-617` 把 pi 显示成 "Codex CLI"。(注:`binaryPath` 真正必填校验在 `profile-bootstrap.ts:62-79`,本层是默认值注入) |
| 🔧 `src/runtime/registry.ts:67` | **(修订补充,blocking)** `isValidEntry()` 校验 `(x.agentKind === 'claude' \|\| x.agentKind === 'codex')`。Pi 进程注册后被判非法 → `bridge ps` 看不到、kill/unregister 失效 |
| 🔧 `src/runtime/locks.ts:181` | **(修订补充,blocking)** `isRuntimeLockMeta()` 同样二元白名单。Pi 的运行时锁元数据判非法 → 锁清理异常 |
| 🔧 `src/config/migrate-v2.ts:203` | **(修订补充)** V1→V2 迁移 `if (entry.agentKind === 'claude' \|\| === 'codex')` 第二处白名单,历史 pi entry 静默丢失 |
| 🔧 `src/cli/commands/migrate.ts:46,53-54` | **(修订补充)** 与 `migrate-v2.ts` 是**两个不同文件**,原文未提;`:46` profile 名推断 agent、`:53-54` 仅 codex 生成 bootstrap |

### 3.4 session 模型层

Pi 的 session 是「完整对话树」(支持 fork / navigateTree / `--session <id|path>`),比 claude/codex 的线性模型更丰富。

| 文件:行 | 卡点 |
|---|---|
| `src/session/catalog.ts:8` | `CatalogAgentId = AgentCapabilityId`,扩展后自动覆盖 |
| `src/session/catalog.ts:18-23` | `SessionCatalogEntry` 的 `sessionId` / `threadId` 是两个字段。Pi 用哪个?**决策点**——建议复用 `sessionId` |
| `src/commands/index.ts:629-631` | `if (identity.agentId === 'claude') { sessions.set(...) }` | resume 逻辑,需为 pi 加分支 |
| `src/commands/index.ts:679-683` | `(agentId === 'claude' && !sessionId) \|\| (agentId === 'codex' && !threadId)` | 会话有效性判断,需加 pi 分支 |
| `src/bot/channel.ts:695` | `agentKind === 'codex'` | channel 启动路径 |
| `src/bot/comments.ts:185,245` | `agentKind === 'codex'` / `capability.agentId === 'codex'` | 文档评论场景 |
| `src/bot/session-catalog-identity.ts:25` | `agentKind === 'codex'` | 会话身份解析 |
| `src/bot/run-flow.ts:201` | `agentId: 'codex'` | 运行流 |
| 🔧 `src/bot/run-flow.ts:122-137,147-152,186-205` | **(修订补充)** resume 路径(`:122-137` claude 取 sessionId / codex 取 threadId)、image 投递(`:147-152` 仅 codex 透传)、`recordRunSessionEvent`(`:186-205`)——Pi 这些分支都不命中,resumeFrom 为空、session 不记录 |
| 🔧 `src/policy/run-policy.ts:112-116` + `src/policy/fingerprint.ts:38` | **(修订补充,important)** 无条件双算 `sandbox = accessToCodexSandbox(...)` + `permissionMode = accessToClaudePermissionMode(...)`,`RunPolicyAllow:66-67` 同时返回两者;下游 `run-executor.ts:104-105,144-145` 塞进 `AgentRunOptions`。Pi 拿到无关值,需加第三套权限语义或 bypass |

### 3.5 需要清理的全部硬编码

全项目 `=== 'codex'` 判断 🔧 **修订:实测 33 处 / 16 文件**(算上 `!== 'codex'` 共 35 处)。原文写的「51 处 / 20 个文件」实际是 `'codex'` **字面量出现总数**,含 16 个类型联合/默认值/字段赋值(如 `agentId: 'codex'`、`?? 'codex'`、`export type AgentKind = 'claude' \| 'codex'`)等非比较用法。这些不会全部阻塞——大部分是 codex 专属能力(如 `codexHome`、`sandbox`、`ignoreRules`),Pi 不需要;但所有「二选一兜底为 claude」的地方都必须显式处理 Pi,否则 Pi 会错误地走 claude 分支。

### 3.6 架构定性:接口层已归一,策略层未抽象(卡点的真正本质)

> 回答关键疑问:claude 和 codex 是「合并成一个大类」还是「元方法做了兼容封装」?
> 答案:**两者都有,但分工不同**。

bridge 采用的是「**接口归一 + 调用点判断**」的混合模式,封装只覆盖了一部分维度。准确划分为两层:

#### (A) 元方法层 —— 已封装归一,白嫖即可

`ClaudeAdapter` 与 `CodexAdapter` **没有共同基类**,各自 `implements AgentAdapter`(见 `src/agent/claude/adapter.ts:25`、`src/agent/codex/adapter.ts:35`)。但接口契约 `AgentAdapter` 把 agent 差异吸收掉了:

- 输入统一 `AgentRunOptions`,`run()` 返回统一 `AgentRun`,事件流统一 `AsyncIterable<AgentEvent>`。
- 各自的输出协议(Claude stream-json / Codex jsonl)在**各自的 translator**(`claude/stream-json.ts`、`codex/jsonl.ts`)里翻译成同一套 `AgentEvent`,上层完全不感知底层是谁。

`RunExecutor`(`src/runtime/run-executor.ts`)是这个封装的受益者:它只持有 `agent: AgentAdapter`,`submit()` 内只调 `this.agent.run(runOptions)`,**零 `if (codex)` 分支**。Pi 接入时这一层**直接白嫖**——只要实现 `AgentAdapter`,就能挂进 `RunExecutor`。

#### (B) 策略 / 配置 / session 层 —— 调用点 `if/else`,无抽象(真正的卡点)

封装止步于「怎么 spawn + 读流」。**配置字段、权限语义、session 形态**这三类差异没有抽象,而是靠「把多套字段塞进同一个 struct + 调用点 `if/else` 区分」:

| 差异维度 | 现状 | 证据 |
|---|---|---|
| **运行选项** | `AgentRunOptions` 是大杂烩,塞了两套互斥字段 | `src/agent/types.ts:38-39`:`sandbox?: CodexSandboxMode`(codex)与 `permissionMode?: ClaudePermissionMode`(claude)并存;`sessionId`(claude)与 `threadId`(codex)并存 |
| **权限模型** | 两套并行,靠转换函数互转,收敛到 `AccessMode` 公分母 | `src/config/permissions.ts`:`CodexSandboxMode` / `ClaudePermissionMode` 双类型,`accessToCodexSandbox()` / `accessToClaudePermissionMode()` 互转 |
| **命令 / session** | 纯 `if (agentKind === 'codex')` 分支 | `src/commands/index.ts:540,629,636,683,795` 等 |

Pi 每多一个维度差异,就多一处 if 要补。典型例子:
- **权限**:Pi 没有 sandbox,改用 `--tools` 白名单——这是**第三套语义**,要么加第三套 `accessToPiTools()` 转换,要么直接 bypass。
- **session 形态**:Pi 是对话树(fork / navigateTree),比 claude/codex 线性模型丰富,catalog 字段选择需要决策(见决策点 2)。

#### (C) 小结:为何「先开类型口子跑 tsc」

| 层 | 模式 | 接 Pi 成本 |
|---|---|---|
| spawn + 事件流(`AgentAdapter` / `RunExecutor`) | **元方法已封装归一** | 白嫖,实现接口即可 |
| 权限 / 配置字段 / session 形态 | **一个 struct 塞多套字段 + 满地 `if` 判断 `agentKind`** | 需加第三套字段 + 第三套分支 |

卡点的本质不是「合没合并成大类」,而是:**接口层归一做得到位,但策略/配置层是「一个 struct 塞多套字段 + 满地 if 判断 agentKind」的多形态混居**。这层没有抽象,所以无法用「注册一个新插件」干净地接入;每多一个 agent,就多一组字段 + 一组 if 分支。这正是第五节建议「**第一步先开 `AgentKind` 类型口子跑 `tsc`**」的原因——让编译器把所有需要补 `else if (pi)` 的判断点一次性列全,比人工 grep 更可靠。

---

## 四、决策点(实现前需明确)

1. **Pi 的 profile 配置字段**。Codex 在 `ProfileConfig` 里有专属的 `codex?: CodexConfig`(`binaryPath`/`codexHome`/`ignoreRules`...)。Pi 是否需要等价的 `piConfig?`?还是复用 `permissionMode` + 通用 `binary` 探测?——建议至少加一个 `pi?: { binaryPath }` 字段,与 codex 对称。

2. **Pi 的 sessionKind 用哪个字段**。`SessionCatalogEntry` 现有 `sessionId` / `threadId`。Pi 的 `--session <id|path>` 语义接近 claude 的 `--resume`,建议复用 `sessionId`,定义 `sessionKind: 'pi-session'`。

3. **Pi 的权限模型**。Codex 用 `sandbox` / `permissionMode`。Pi 通过 `--tools read,grep,...` / `--no-builtin-tools` 控制能力。bridge 的 `policy/run-policy.ts` 需要为 pi 定义等价的 `permissionMode`→Pi 工具白名单映射,**或**简化为直接 `bypass`(Pi 的 `--print` 模式下风险较低)。🔧 **修订核实**:`--tools, -t <names>` 确为 allowlist(逗号分隔),默认内置仅 `read/bash/edit/write`,`grep/find/ls` 默认**关**;`--no-builtin-tools/-nbt` 只关内置、保留扩展/自定义工具(与 `--no-tools/-nt` 不同)。注意 `run-policy.ts:112-116` 是**无条件双算** sandbox+permissionMode(见 §3.4),pi 必须在此显式 bypass 或加第三字段。

4. 🔧 **(修订新增)Pi 的认证与配置注入**。pi 无 `login` 子命令(见 §1.4 前提 3)。决策:bridge 的 `piCapability` 如何注入凭据?三选一:① env 变量(但 pi 不认 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`,只认 `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN`);② `--api-key` + `--model` + `--provider`;③ 预写 `~/.pi/agent/auth.json` 并用 `PI_CODING_AGENT_DIR` 隔离配置目录。**推荐 ③ + `models.json` provider override**(endpoint/token 都可控,实测可行)。

5. 🔧 **(修订新增)stdout/stderr 分离**。适配器必须只从 stdout 读 NDJSON(`writeRawStdout` 通道),诊断/help/version 走 stderr(见 §1.4 前提 1)。是否改用 `--mode rpc`(stdin JSON-RPC ↔ stdout JSON 事件)作为更结构化的双向通道,值得评估。

---

## 五、建议的实施顺序

1. **先开类型口子**:`AgentKind` 加 `'pi'`,跑一次 `tsc`,让编译器列出所有需要补充分支的位置(这是发现第三节硬编码最可靠的方式,比人工 grep 更全)。
2. **写适配器**:`src/agent/pi/adapter.ts`,以 `ClaudeAdapter` 为模板。
3. **打通最小链路**:`capability.ts` + `start.ts` 分发 + `agent-detection.ts` 探测,先让 `pi` 能被选中并跑起来。
4. **补 session 链路**:catalog、resume、comments 里的 pi 分支。
5. **补 profile 配置**:`piConfig` 字段 + 迁移 + `profile use pi` 命令。

---

## 附录:涉及的关键源文件索引

### lark-channel-bridge(`/home/yy/tools/lark-coding-agent-bridge`)

- `src/agent/types.ts` — `AgentAdapter` 接口、`AgentEvent` 联合类型(适配器契约)
- `src/agent/capability.ts` — `AgentCapabilityId` / `AgentSessionKind`、`claudeCapability()` / `codexCapability()`
- `src/agent/claude/adapter.ts` — `ClaudeAdapter`(适配器实现模板)
- `src/agent/claude/stream-json.ts` — Claude stream-json 翻译器(翻译层模板)
- `src/agent/codex/adapter.ts` — `CodexAdapter`(对照参考)
- `src/cli/commands/start.ts:421-437` — 适配器分发(核心卡点)
- `src/cli/agent-detection.ts` — `AgentKind`、`detectInstalledAgents()`
- `src/config/profile-schema.ts:16,161` — `AgentKind` 联合类型 + 校验
- `src/config/profile-store.ts:294` — `agentKindFromString()`
- `src/session/catalog.ts` — `SessionCatalogEntry`、`CatalogAgentId`
- `src/commands/index.ts:540,629-631,636,679-683,745,795,1110` — 命令处理里的 agentKind 分支
- `src/runtime/run-executor.ts` — `RunExecutor`(`AgentAdapter` 的调用方)

### pi-mono(`/home/yy/tools/pi-mono`)

- `packages/coding-agent/src/cli/args.ts` — `Mode = "text" | "json" | "rpc"`、参数定义
- `packages/coding-agent/src/modes/print-mode.ts:103-107` — NDJSON 输出实现
- `packages/agent/src/types.ts:350` — `AgentEvent` 联合类型
- `packages/ai/src/types.ts:261` — `AssistantMessageEvent`(text_delta / thinking_delta / toolcall_end)

---

## 🔧 修订日志(2026-06-27)

本文档经过对 pi-mono 源码 + bridge 源码 + pi CLI 实跑的对抗性核验(6 维度 35 条断言 + bridge/pi-mono 双向遗漏扫描,每条「非 correct」断言经独立 skeptic 复核)。核验总计 14 agents / 628k tokens / 309 tool calls。修订要点:

| # | 位置 | 修订内容 |
|---|------|----------|
| 1 | §一 协议措辞 | 「协议形态完全一致 / 原样复用」→「传输形态一致、事件 schema 不同、需新写翻译器」(B4) |
| 2 | §1.2 | 补「10 个事件中 5 个未映射会被静默丢弃」,点名 `tool_execution_update` 承载 bash 实时输出(A3b) |
| 3 | §1.4(新增) | 三条运行环境前提:stdout 劫持、anthropic env 不兼容、无 login 子命令 |
| 4 | §2.1 | 强调 stdout/stderr 必须分离监听 |
| 5 | §3.1 | 补 `preflight.ts:3 LocalAgentId` 第二处封闭联合 |
| 6 | §3.3 | 补 `registry.ts:67`、`locks.ts:181`(blocking)、`migrate-v2.ts:203`、`cli/commands/migrate.ts`、`profile-runtime` 多处 |
| 7 | §3.4 | 补 `run-flow.ts:122-137/147-152/186-205`、`run-policy.ts:112-116`(无条件双算) |
| 8 | §3.5 | 统计口径修正:`=== 'codex'` 判断真实 33 处/16 文件(原文 51/20 是字面量总数)(F1) |
| 9 | §四 | 新增决策点 4(认证注入)、5(stdout/stderr 分离);核实决策点 3 的 `--tools` 语义 |

**可信度结论**:bridge 侧 14 个 `file:line` 引用(D/E 维度)**全部精确命中**,pi 侧事件/CLI 定义准确,架构定性(F2-F5)正确——文档骨架可信。本次修订修正了 1 处统计错误、2 处措辞偏差,并补齐原文遗漏的 blocking 级接入卡点。

**实测验证记录**:在隔离目录 `/tmp/pi-ndjson-test` 配 `models.json`(GLM anthropic 网关 provider override,baseUrl=`https://open.bigmodel.cn/api/anthropic`)后,`pi --mode json -p` 成功产出真实 NDJSON——无工具回合 15 行 / 工具回合 38 行(含 `tool_execution_start/update/end`),逐行 `JSON.parse` 全过,事件 type 与 §1.1 一致。`pi --help`/`--version` 实测走 stderr(stdout 被 `takeOverStdout` 劫持,stdout 0 字节)。注:`models.json` 须放在 agentDir 根(`PI_CODING_AGENT_DIR/models.json`),非 `.pi/models.json`。

**tmux 联动说明**:用户要求联动 tmux 中的 pi-agent 实例(`2:4 pi-agent`)。实测时该实例正在执行用户的 875-提交 ff 分析任务(非 idle),故改用本地 `npm ci` + `tsx`/`dist` 自跑 pi 验证,未占用该实例,符合最小干扰原则。

**仍待人工决策**:`piConfig` 字段设计(决策点 1)、session 字段选择(决策点 2)、权限模型(决策点 3)、认证注入方式(决策点 4)。
