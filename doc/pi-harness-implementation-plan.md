# pi harness 桥接实现规划

> 🔧 本规划由 workflow `wf_fe225e83-35d` 产出：5 个架构切面并行设计 → 逐切面对抗验证 → 缺口扫描（11 agent / 820k tokens / 316 tool calls）。
> 基础依据为 [`pi-harness-integration-report.md`](./pi-harness-integration-report.md)（审计，可信度 7.5/10）。
> **file:line 状态标记**：`✅` 本轮亲自核实 + 对抗验证通过 ｜ `✓` 对抗验证 agent 核实通过（准确率 95%+）｜ `⚠️` 对抗验证发现需纠正 ｜ `❓` 待定/待验证。

---

## 一、架构总览

```
飞书消息 → RunExecutor → PiAdapter.run()
                         ├─ spawn: pi -p "<prompt>" --mode json --append-system-prompt "<BRIDGE_PROMPT>"
                         │          [--session <id> | --no-session] [--model <m>] [--tools read,bash,...]
                         │          env: PI_CODING_AGENT_DIR=<隔离 dir>, PI_ANTHROPIC_KEY=<from keystore>
                         ├─ stdout (纯 NDJSON, takeOverStdout 把其余 stdout 重定向到 stderr)
                         │    └─ PiJsonTranslator.translate(line) → bridge AgentEvent
                         └─ stop(): SIGTERM→grace→SIGKILL（不依赖 pi flush，靠 exit-code 兜底）
```

**对称性**：PiAdapter 与 ClaudeAdapter 同构（stdin ignore / `-p` 单发 / stdout NDJSON / `--append-system-prompt`）。Codex 是异类（stdin pipe + prompt prefix），**不要照抄 codex 的 stdio/prompt 注入**。

**零分支约束**：`RunExecutor` 已 agent-agnostic（`run-executor.ts:55,126` 零 `agentKind` 分支 ✓）。adapter 选择是 `start.ts` 配置驱动派发，不在 AgentAdapter 层引入 `if(pi)`。

---

## 二、关键决策（必须先敲定，阻塞实现）

| # | 决策点 | 推荐 | 依据 |
|---|--------|------|------|
| **A** | pi session 字段 | **`sessionId`**（claude 风格，`--session` 恢复），非 `threadId` | `capability.ts:6` 新增 `'pi-session'`；catalog/run-flow 按 claude 语义 |
| **B** | `tool_execution_update`（bash 实时尾部） | **降级为 `text` delta + 前缀标记 `[tool:NAME] `** | 不扩 bridge AgentEvent 联合；UX 可据此样式化；v1 不做 `tool_progress` 新事件 |
| **C** | usage/token 计费 | **从 `message_end.message.usage` 合成 bridge `usage` 事件** | 与 claude(`stream-json.ts:74-82`)/codex(`jsonl.ts:144-155`) 对称；pi 无专用 usage 事件 |
| **D** | `PiConfig` 字段 | `{ binaryPath, gatewayBaseUrl?, gatewayApiKeyEnv?, piAgentDir?, inheritPiAgentDir? }` | 镜像 `CodexConfig`；gateway 字段供 auth（决策 F） |
| **E** | pi 权限模型 | **v1 bypass**：pi 忽略 `AgentRunOptions` 的 sandbox/permissionMode；`--tools` 透传 capability 工具集 | `run-policy.ts:112-116` 双重计算是 agent-agnostic、无害；第三字段延后 |
| **F** | 认证注入 | **models.json 自定义 provider + 隔离 `PI_CODING_AGENT_DIR`** | option (b)；`apiKey: '${PI_ANTHROPIC_KEY}'` env 模板，文件无明文密钥 |
| **G** | 传输模式 | **`--mode json`**（v1）；defer `--mode rpc` | 与 ClaudeAdapter 对齐；rpc 需 stdin pipe + JSON-RPC writer，改动大 |

> 决策 B/C 直接阻塞测试 fixture 定型（§六），须在 Phase 3/5 前定稿。

---

## 三、实施阶段（按依赖顺序）

### Phase 0 — 类型放宽（根，先做）

加 `'pi'` 到 6 个封闭联合。这是 tsc 的「放大镜」——放宽后编译器会逐一暴露所有下游 `=== 'codex'` 分叉，照单处理。

| 文件:行 | 改法 | 状态 |
|---------|------|------|
| `src/config/profile-schema.ts:16` | `AgentKind = 'claude' \| 'codex' \| 'pi'` | ✅ |
| `src/cli/agent-detection.ts:5` | 同上（**第二个独立定义**，两处都要改） | ✅ |
| `src/agent/preflight.ts:3` | `LocalAgentId = 'claude' \| 'codex' \| 'pi'` | ✅ |
| `src/agent/capability.ts:5` | `AgentCapabilityId` 加 `\| 'pi'` | ✅ |
| `src/agent/capability.ts:6` | `AgentSessionKind` 加 `\| 'pi-session'` | ✅ |

> ⚠️ 放宽后触发 ~33 处 `=== 'codex'` 报告 §3.5 分叉，逐个评估是否需要 pi 臂（多数 codex-feature 专有，pi 透传无害）。两个 `AgentKind` 定义是潜在 footgun，建议合并为单一 re-export（openQuestion，非阻塞）。

### Phase 1 — capability + 接入点（registry/locks/preflight/catalog/dispatch）

**BLOCKER 集中区**。`✅` = 本轮核实。

#### 1.1 capability 构造（⚠️ design 漏掉，gap scan 补上的最大 blocker）

`✅` 4 个二选一 ternary 是 `capability.agentId === 'pi'` 的唯一来源——**不改它们，下游所有 pi 臂都是死代码**（agentId 永远是 'claude'）：

| 文件:行 | 现状 | 改法 |
|---------|------|------|
| `src/bot/channel.ts:696-697` ✅ | `agentKind==='codex' ? codexCapability : claudeCapability` | 改为 `resolveCapability(agentKind, profile)` |
| `src/bot/comments.ts:186-187` ✅ | 同上 | 同上 |
| `src/bot/session-catalog-identity.ts:26-27` ✅ | 同上 | 同上 |
| `src/commands/index.ts:1111-1112` ✅ | 同上（gap scan 指出 design 误归类为「codex-feature 无害」，实为 capability 派发点） | 同上 |

新增 `src/agent/capability.ts` 的 `piCapability()`（镜像 `codexCapability` :42）：`agentId:'pi'`, `sessionKind:'pi-session'`, `promptInjection:'append-system-prompt'`（同 claude，非 codex 的 `'stdin-prefix'`）, `supportsNativeHistory:true`, callback marker `'__bridge_cb'`。并提供 `resolveCapability(agentKind, profile)` 辅助函数替换上述 4 个 ternary。

#### 1.2 运行时白名单（BLOCKER）

| 文件:行 | 改法 | 状态 |
|---------|------|------|
| `src/runtime/registry.ts:67` ✅ | `isValidEntry`：`\|\| x.agentKind === 'pi'`（否则 pi 进程被 `bridge ps` 静默丢弃，kill/unregister 找不到） | ✅ 核实逐字匹配 |
| `src/runtime/locks.ts:181` ✅ | `isRuntimeLockMeta`：`\|\| meta.agentKind === 'pi'`（否则 lock 清理失常） | ✅ 核实逐字匹配 |
| `src/session/catalog.ts:217` ✓ | `normalizeEntry`：`raw.agentId !== 'pi'`（运行时 allowlist，否则 pi 条目加载即丢） | ✓ |

#### 1.3 catalog 校验反转（high，⚠️ design 漏）

`src/session/catalog.ts:250-255`：`isValidAgentEntry`/`assertAgentIdentity` 的 codex 分支（要求 `threadId`、禁 `sessionId`）会对所有非 claude agent 生效。pi 用 `sessionId`（决策 A），**必须加显式 pi 臂**（按 claude 语义：要求 sessionId、禁 threadId），否则 pi 条目被拒 / 抛 `'Codex catalog entries require threadId'`。

#### 1.4 preflight / schema / dispatch

| 文件:行 | 改法 | 状态 |
|---------|------|------|
| `src/agent/preflight.ts:282-285` ✓ | `isAgentPreflightDiagnostic`：`\|\| raw.agentId === 'pi'` | ✓ |
| `src/config/profile-schema.ts:161-167` ✓ | validator 接受 `'pi'`；加 `pi?: PiConfig`（镜像 :92 `codex?`）；`normalizePi()` 镜像 :272 | ✓ |
| `src/config/profile-store.ts:294-298` ✓ | `agentKindFromString`：`\|\| value === 'pi'`（`--agent pi` 闸门） | ✓ |
| `src/config/migrate-v2.ts:203` ✓ | V1→V2 allowlist：`\|\| entry.agentKind === 'pi'` | ✓ |
| `src/cli/commands/migrate.ts:46,53` ✓ | profile→agent 推断 + bootstrap 加 pi 臂；需新 `createBootstrapPiConfig` | ✓ |
| `src/cli/profile-bootstrap.ts:29,62` ✓ | `createBootstrapPiConfig`（mkdir 隔离 pi-agent dir） | ✓ |
| `src/cli/agent-detection.ts:48-51` ✓ | candidates 加 `{ kind:'pi', command: process.env.LARK_CHANNEL_PI_BIN ?? 'pi' }` | ✓ |
| `src/runtime/profile-runtime.ts:90,398,615` ✓ | `createRuntimeProfileConfig`/`resolveBootstrapAgent`/`displayAgentKind` 加 pi 臂 | ✓ |
| `src/agent/index.ts` | `export { PiAdapter } from './pi/adapter'` | — |
| `src/cli/commands/start.ts:421-437` ✓ | `createRuntimeAgent` dispatch：`if(agentKind==='pi') return new PiAdapter(...)`，**插在 claude fallback 之前** | ✓ |
| `src/cli/commands/start.ts:377-379` ✓ | `agentId: agent.id==='codex'?'codex':'claude'` ternary → switch/map（避免 pi 落到 claude） | ✓ |
| `src/bot/run-flow.ts:122-137,186-205` ✓ | resume/recordRunSessionEvent 加 pi 臂（sessionId 语义） | ✓ |
| `src/commands/index.ts:147` ✓ | `ResumeCandidate.agentId` 联合加 `\| 'pi'` | ✓ |
| `src/policy/run-policy.ts:112-116` ✓ | **不改**（双重计算 agent-agnostic，pi 忽略；决策 E） | ✓ |

### Phase 2 — PiAdapter（`src/agent/pi/adapter.ts`）

镜像 `ClaudeAdapter` 结构。`run()` 关键点：

```ts
const args = ['-p', opts.prompt, '--mode', 'json',
  '--append-system-prompt', buildBridgeSystemPrompt(this.botIdentity)];
if (opts.sessionId) args.push('--session', opts.sessionId);     // 非常驻用 --no-session
else args.push('--no-session');
if (opts.model) args.push('--model', opts.model);
args.push('--tools', /* capability 工具集 → */ 'read,bash,edit,write,grep,find,ls');
// stdio: ['ignore','pipe','pipe']（同 claude，非 codex 的 ['pipe',...]）
```

**关键约束（均 ✓ 对抗验证）**：
- `--session <id>` 用于恢复；**勿用 `--session-id`**（`main.ts:221-251` 与 `--session/--resume` 互斥）。
- `--api-key` 必须配 `--model`（`main.ts:692-697`），故认证走 env/models.json（决策 F），不走 `--api-key`。
- stdout = 纯 NDJSON（`takeOverStdout` 把其余 stdout 重定向到 stderr，`output-guard.ts:45-70`）；无需 mixed-stdout 处理，直接 `JSON.parse → translatePiEvent`。
- stderr 复用 `claude/adapter.ts:92-110` 行缓冲 + 日志循环。
- `stop()/waitForExit()` 复制 `claude/adapter.ts:129-166`。
- json-mode 首行是 session header（`print-mode.ts:112-117`），翻译器须显式处理（不在 AgentEvent 联合内）。

> ⚠️ **SIGTERM flush 纠正（对抗验证发现 design 误诊）**：design 称 SIGTERM 给 pi 机会 flush NDJSON，**错误**。实际 `print-mode.ts:54-58` 的 SIGTERM handler 调 `disposeRuntime()` 后 `process.exit(143)`，**不调** `flushRawStdout()`；`runPrintMode` 的 finally（`:156-157`，调 flush）被跳过。`writeRawStdout` 是异步 promise-tail 队列（`output-guard.ts:85-93`），stop() 后最后的 `agent_end` 可能丢失。
> **对策**：stop() 不依赖 pi flush；grace 5s 保留但仅作 SIGKILL 缓冲；**必须靠 exit-code 终止兜底**（`claude/adapter.ts:237-252` 模式）在流末无终止事件时合成 done/error。pi SIGTERM 退出码 143，`/stop` 触发时不应视为硬错误。

### Phase 3 — 翻译器（`src/agent/pi/stream-json.ts`）

`PiJsonTranslator` 类（镜像 `codex/jsonl.ts:11-178`，**非** claude 的无状态 generator），持 `terminal`/`drift`/`sessionId` 状态。`translate(raw): AgentEvent[]` + `finish(reason)`。

**事件映射表**（修复报告 §1.2「10 个里丢 5 个」）：

| pi 事件 | → bridge AgentEvent | 备注 |
|---------|---------------------|------|
| `session` header | `{system, sessionId, cwd}` | 在联合外，显式 case |
| `agent_start` | DROP | 生命周期标记 |
| `message_update` → `text_delta` | `{text, delta}` | |
| → `thinking_delta` | `{thinking, delta}` | |
| → `toolcall_end` | **DROP**（见下） | 与 tool_execution_start 冲突 |
| → `error` | 非终止/终止 error | 镜像 `jsonl.ts:172-177` |
| → 其余 `*_start/*_delta/text_end/...` | DROP | delta 已承载流式文本 |
| `tool_execution_start` | `{tool_use, id, name, input}` | **tool_use 唯一来源**（执行边界权威信号 `agent-loop.ts:637-655`），**不要**再用 toolcall_end |
| `tool_execution_update` | **降级 `{text, delta}` + 前缀 `[tool:NAME] `** | 决策 B；bash 实时尾部 |
| `tool_execution_end` | `{tool_result, id, output, isError}` | `result.content[].text` 拼接，fallback `JSON.stringify` |
| `agent_end` | terminal=true, `{done, sessionId, terminationReason:'normal'}` | |
| `turn_start/turn_end/message_start/message_end` | DROP | 数据已流式送达；usage 从 message_end 提取（决策 C） |

> ⚠️ **冲突点**：`toolcall_end` 与 `tool_execution_start` 都像 tool_use。**只用 tool_execution_start**，在代码里注释说明，防回归。
> ⚠️ **unknown event 走 drift 计数**（`drift.unknownEvents++` + warn），不静默丢。但注意 RunExecutor 当前不查 drift（codex 亦然），drift 暂为「计数但不 surfaced」——保留为对称、低成本。

### Phase 4 — 认证 + profile bootstrap

- `PiAdapter` 注入 `PI_CODING_AGENT_DIR=<profileStateDir>/pi-agent`（镜像 codex `CODEX_HOME`，`codex/adapter.ts:104-109`），并 `PI_ANTHROPIC_KEY=<from keystore>`。
- 写 `<agentDir>/models.json`：`{ providers: { anthropic: { baseUrl: <gateway>, apiKey: '${PI_ANTHROPIC_KEY}' } } }`。**必须放 agentDir 根**（`config.ts:528-531`），错位则静默只剩内置模型。apiKey 是 env 模板，文件无明文密钥。
- ⚠️ **stale auth.json 阴影（high）**：pi 优先级 `runtime override > auth.json api_key > auth.json oauth > env`（`auth-storage.ts:462-473`）。隔离 dir 若残留旧 `auth.json`，会盖过 env 注入。**bootstrap 必须确保隔离 dir 无 `auth.json`**（或已知空），否则 GLM gateway override 失效。
- 日志脱敏：复用现有规则（`logger.ts:196` 按 key 名 redact token/secret/authorization；`logger.ts:125-132` redact env），**无需新增规则**；spawn 日志只记 env-var 名，不记值。
- `--version` 走 stdout（`main.ts:506-509` 在 takeOverStdout 之前），preflight 版本提取容忍 stdout/stderr（`preflight.ts:174`）。

### Phase 5 — 测试

| 测试 | 类型 | 内容 |
|------|------|------|
| `tests/unit/agent/pi-stream-json.test.ts` | unit | 翻译器 fixture：`tests/fixtures/pi/{no-tool,tool-turn}.ndjson`（**redact 真实 GLM key**，勿提交 `/tmp/pi-ndjson-test/models.json`） |
| `tests/process/pi-adapter.test.ts` | process | fake `pi` 二进制（记录 argv、echo fixture 到 stdout、stderr 诊断）；断言 stdout/stderr 分离、exit-code 兜底 |
| `tests/integration/bot/pi-run-flow.test.ts` | integration | `FakeAgentAdapter(id:'pi')` 过 agent-agnostic RunExecutor；验证 sessionId resume |
| `tests/unit/cli/start-agent-factory.test.ts` | extend | `createRuntimeAgent(agentKind:'pi')`；`assertReconnectAgentKindUnchanged` 加 pi case |
| `tests/unit/agent/capability.test.ts` | extend | `piCapability` 形状 |
| `tests/static/contracts.test.ts:22` | extend | 加 `expect(read(file)).not.toMatch(/agent\/pi/)` 对称行（防共享代码泄漏） |
| `*.smoke.ts`（**非** `*.test.ts`） | smoke | 真 pi 跑，凭证门控；vitest 默认 glob `**/*.test.ts` 不匹配 → CI 安全。`tests-smoke/` 当前**不存在**（非「空」） |

> ⚠️ **argv 断言**：pi 参数无 `--output-format/--verbose/--permission-mode`，bridge prompt 值**不在固定 offset 8**（claude 才是）。断言 `argv[argv.length-1]` 或定位 `--append-system-prompt` 后的值。
> ⚠️ **退出码**：pi SIGTERM→143，error/aborted→1（`print-mode.ts:135-137` 仅 text 模式）。non-zero→error 测试须容忍 stop 触发的 143。
> ⚠️ **FakeAgentAdapter 绕过 RunPolicy**：integration 测不到 `run-policy.ts:112-116` 双重计算；若选 pi `--tools` 映射（决策 E 之外）需补 policy unit 测。
> 完成关卡：`pnpm ci:local`（`git diff --check && pnpm test && pnpm typecheck && pnpm build`）。PiAdapter 不引入新依赖（复用 spawnProcess/readline）；翻译器自定义最小 pi 事件接口（如 `claude/stream-json.ts:3-28`），**勿 import** pi-mono 源码。

---

## 四、Blocker 清单（实现前必清）

| 级别 | 项 | 归属 | 对策 |
|------|----|------|------|
| 🔴 blocker | 4 个 capability ternary 死代码 | Phase 1.1 | `resolveCapability()` 替换 `channel/comments/session-catalog-identity/commands` 四处 ✅ |
| 🔴 blocker | SIGTERM 不 flush NDJSON | Phase 2 | exit-code 兜底合成终止事件 ⚠️ |
| 🔴 blocker | `registry.ts:67` + `locks.ts:181` 白名单 | Phase 1.2 | 加 `\|\| === 'pi'` ✅ |
| 🟠 high | stale auth.json 阴影 env 注入 | Phase 4 | bootstrap 确保隔离 dir 无 auth.json ⚠️ |
| 🟠 high | `tool_execution_update`→text 破坏不变式 | 决策 B | 定型 `[tool:NAME] ` 前缀标记 |
| 🟠 high | usage 计费未决 | 决策 C | 合成 bridge usage 事件 |
| 🟠 high | `catalog.ts:250-255` 校验反转 | Phase 1.3 | 加 pi 臂（sessionId 语义）⚠️ |
| 🟡 medium | `PiConfig` 字段 / pi 权限 | 决策 D/E | v1 minimal + bypass |
| 🟡 medium | argv[8] 断言错 | Phase 5 | 用 `argv[last]` ⚠️ |
| 🟡 medium | real-pi smoke / vitest glob / npm bin | Phase 5 | `*.smoke.ts` 命名 + doc 记 LARK_CHANNEL_PI_BIN 分发 |
| 🟢 low | `contracts.test.ts` pi 对称行 | Phase 5 | 加 `agent/pi` 断言 |

---

## 五、风险与未决

1. **pi 仍 pre-1.0**：NDJSON shape 可能漂移，fixture 会静默腐烂——fixture 注释标注捕获日期与 pi commit。
2. **两个 `AgentKind` 定义**（`profile-schema.ts:16` + `agent-detection.ts:5`）：建议合并为单一 re-export，否则需 lockstep 维护。
3. **GLM gateway 依赖**：models.json provider-override 是唯一免登录跑法；key 轮换/网关变更只在 smoke 暴露（CI 用 fixture）。
4. **drift 计数暂为 dead weight**：RunExecutor 不查 drift（codex 亦然）；要真正「无静默丢」需后续接 consumer。
5. **`--mode rpc` 延后**（决策 G）：若未来切 rpc，stdio 须改 stdin pipe + JSON-RPC writer，translator 契约亦变。
6. **OAuth 路径**（openQuestion）：subscription 类 pi 用法需预填 auth.json OAuth，env/models.json 无法覆盖——v1 不支持，留待部署需求明确。

---

## 六、依赖图与落地顺序

```
Phase 0 (类型放宽) ──┬─→ Phase 1 (capability+接入点) ──┬─→ Phase 2 (PiAdapter)
                     │                                  ├─→ Phase 4 (auth/bootstrap)
                     └─→ Phase 3 (translator, 独立) ────┴─→ Phase 5 (测试)
```

- Phase 0 是根，先做（tsc 放大镜）。
- Phase 1 的 capability ternary（1.1）+ catalog（1.3）是「pi 能否被选中并跑通」的真正闸门，优先于 adapter 细节。
- Phase 2/3 可并行。
- 决策 B/C 须在 Phase 3/5 前定稿（阻塞 fixture）。
- 每阶段以 `pnpm ci:local` 为关卡。
