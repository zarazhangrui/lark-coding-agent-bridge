# Claude Agent SDK 驱动 · Phase 1a（agent 层）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 实现新的 `ClaudeSdkAdapter` 替换现有基于 `claude -p` 子进程的 `ClaudeAdapter`，先达到 `bypassPermissions` 行为对等，并把交互审批机制（`canUseTool` → `permission_request` 事件 → `respondPermission` 回传，含超时与中断强制收尾）内建进适配器；审批在生产中默认不触发（executor 暂不注入 `canUseTool`，留待 Phase 1b 接线飞书卡片）。

**Architecture:** 新增三个纯/核心单元——事件翻译（`SDKMessage → AgentEvent`）、审批策略（安全工具白名单）、SDK 适配器（驱动 + 审批 promise 桥接）。适配器通过依赖注入接收 `query` 工厂，测试时注入 fake `query`，无需真实 claude 二进制。`stop()` 改用 `AbortController`（不再走 SIGTERM/SIGKILL 信号）。契约层在 `AgentEvent` 增加 `permission_request`、在 `AgentRun` 增加可选 `respondPermission`/`steer`。

**Tech Stack:** TypeScript (ESM, strict)、Node ≥ 20.12.0、`@anthropic-ai/claude-agent-sdk` v0.3.x、vitest、pnpm。

## Global Constraints

- Node.js ≥ 20.12.0；纯 ESM（`"type": "module"`），相对 import 带 `.js` 扩展名（见现有 `tests/*.ts` 里 `from '../../src/agent/types.js'`）。
- TypeScript strict；不要引入未在本计划定义的类型/函数。
- 测试框架 vitest；进程/适配器测试放 `tests/process/`，纯函数测试放 `tests/unit/`。
- 认证不变：不设置 `ANTHROPIC_API_KEY`；沿用 `~/.claude` 与 `claude.env` profile 覆盖。
- SDK 驱动用户已装的 `claude`：`query` 的 `options.pathToClaudeCodeExecutable` 指向 `binary`（默认 `'claude'`）。
- `canUseTool` 返回 `null` 会永久阻塞工具——**永远不要返回 null**，必须 resolve 为 `{behavior:'allow'|'deny', ...}`。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

## File Structure

- Create `src/agent/claude/sdk-translate.ts` — 纯函数 `translateSdkMessage(msg): AgentEvent[]`，把 `SDKMessage` 映射为现有 `AgentEvent`。取代 `stream-json.ts` 的职责。
- Create `src/agent/claude/permission-policy.ts` — 安全只读工具白名单与 `classifyTool(toolName)` 决策。
- Create `src/agent/claude/sdk-adapter.ts` — `ClaudeSdkAdapter`（实现 `AgentAdapter`），含审批 promise 注册表。
- Modify `src/agent/types.ts` — `AgentEvent` 增 `permission_request`；`AgentRun` 增可选 `respondPermission`/`steer`。
- Modify `src/agent/index.ts` — 导出 `ClaudeSdkAdapter`（如该文件负责聚合导出）。
- Modify `src/cli/commands/start.ts:437` — `createRuntimeAgent` 改造 `ClaudeSdkAdapter`。
- Delete `src/agent/claude/adapter.ts`、`src/agent/claude/stream-json.ts`（在 SDK 适配器达到对等、测试通过后）。
- Create `tests/unit/agent/claude/sdk-translate.test.ts`。
- Create `tests/process/claude-sdk-adapter.test.ts`；Delete `tests/process/claude-adapter.test.ts`。
- Modify `package.json` — 增依赖 `@anthropic-ai/claude-agent-sdk`。

---

## Task 1: 扩展 agent 契约（types.ts）

**Files:**
- Modify: `src/agent/types.ts`
- Test: `tests/static/contracts.test.ts`

**Interfaces:**
- Produces:
  - `AgentEvent` 新成员 `{ type: 'permission_request'; id: string; toolName: string; input: unknown; title?: string; displayName?: string; description?: string }`
  - `AgentRun.respondPermission?(id: string, decision: 'allow' | 'deny', opts?: { updatedInput?: Record<string, unknown>; message?: string }): void`
  - `AgentRun.steer?(text: string): void`

- [ ] **Step 1: Write the failing test**

在 `tests/static/contracts.test.ts` 末尾追加（若文件用 `expectTypeOf` 风格则对齐；否则用运行时构造断言）：

```ts
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';

it('AgentEvent includes a permission_request variant', () => {
  const evt: AgentEvent = {
    type: 'permission_request',
    id: 'perm-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    title: 'Claude wants to run ls',
  };
  expect(evt.type).toBe('permission_request');
});

it('AgentRun exposes optional respondPermission and steer', () => {
  const run: Pick<AgentRun, 'respondPermission' | 'steer'> = {
    respondPermission: (_id, _decision) => {},
    steer: (_text) => {},
  };
  run.respondPermission?.('perm-1', 'deny', { message: 'no' });
  run.steer?.('go left');
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/static/contracts.test.ts`
Expected: 类型编译失败（`permission_request` 不在 `AgentEvent` 联合中 / `respondPermission` 不存在）。

- [ ] **Step 3: Implement the contract change**

在 `src/agent/types.ts` 的 `AgentEvent` 联合中，`error` 成员之后追加：

```ts
  | {
      type: 'permission_request';
      id: string;
      toolName: string;
      input: unknown;
      title?: string;
      displayName?: string;
      description?: string;
    }
```

在 `AgentRun` 接口的 `waitForExit(...)` 之后追加：

```ts
  /**
   * Resolve a pending interactive permission request emitted as a
   * `permission_request` event. No-op if the id is unknown or already
   * settled (e.g. timed out or force-denied on stop). Adapters that never
   * emit permission_request may omit this.
   */
  respondPermission?(
    id: string,
    decision: 'allow' | 'deny',
    opts?: { updatedInput?: Record<string, unknown>; message?: string },
  ): void;
  /**
   * Inject an additional user instruction into an in-flight run (Phase 2).
   * Adapters without a live streaming session may omit it.
   */
  steer?(text: string): void;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/static/contracts.test.ts && pnpm typecheck`
Expected: PASS，且 typecheck 无错。

- [ ] **Step 5: Commit**

```bash
git add src/agent/types.ts tests/static/contracts.test.ts
git commit -m "feat(agent): add permission_request event and run control methods

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 审批策略（安全工具白名单）

**Files:**
- Create: `src/agent/claude/permission-policy.ts`
- Test: `tests/unit/agent/claude/permission-policy.test.ts`

**Interfaces:**
- Produces:
  - `SAFE_READONLY_TOOLS: ReadonlySet<string>`
  - `classifyTool(toolName: string): 'auto-allow' | 'prompt'`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/claude/permission-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../../../src/agent/claude/permission-policy.js';

describe('classifyTool', () => {
  it('auto-allows known read-only tools', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'NotebookRead']) {
      expect(classifyTool(t)).toBe('auto-allow');
    }
  });

  it('prompts for write / external / unknown tools', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'mcp__x__y', 'SomethingNew']) {
      expect(classifyTool(t)).toBe('prompt');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/agent/claude/permission-policy.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/claude/permission-policy.ts`:

```ts
/**
 * Interactive-approval policy. We use a *whitelist* of known read-only tools
 * that auto-allow, and prompt for everything else (writes, external access,
 * unknown/MCP tools). Whitelist-not-blacklist means a newly introduced tool
 * defaults to prompting rather than silently auto-running.
 */
export const SAFE_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'TodoWrite',
]);

export function classifyTool(toolName: string): 'auto-allow' | 'prompt' {
  return SAFE_READONLY_TOOLS.has(toolName) ? 'auto-allow' : 'prompt';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/agent/claude/permission-policy.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/permission-policy.ts tests/unit/agent/claude/permission-policy.test.ts
git commit -m "feat(claude): add interactive-approval tool policy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: SDK 事件翻译

**Files:**
- Create: `src/agent/claude/sdk-translate.ts`
- Test: `tests/unit/agent/claude/sdk-translate.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`（Task 1）。
- Produces: `translateSdkMessage(msg: unknown): AgentEvent[]`

SDK 消息形状（已从 `@anthropic-ai/claude-agent-sdk/sdk.d.ts` v0.3.x 确认）：
- `system`/`init`：`{ type:'system', subtype:'init', session_id, cwd, model }`
- `assistant`：`{ type:'assistant', message: { content: Array<{type:'text',text} | {type:'thinking',thinking} | {type:'tool_use',id,name,input}> }, session_id }`
- `user`（工具结果）：`{ type:'user', message: { content: Array<{type:'tool_result', tool_use_id, content, is_error?}> } }`
- `result` 成功：`{ type:'result', subtype:'success', usage:{input_tokens,output_tokens,cache_read_input_tokens}, total_cost_usd, session_id }`
- `result` 失败：`{ type:'result', subtype:'error_during_execution'|'error_max_turns'|..., session_id }`
- `assistant` 带 `error` 字段（`'billing_error'|'rate_limit'|'authentication_failed'|...`）视为错误。

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/claude/sdk-translate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { translateSdkMessage } from '../../../../src/agent/claude/sdk-translate.js';

describe('translateSdkMessage', () => {
  it('maps system/init to a system event', () => {
    expect(
      translateSdkMessage({ type: 'system', subtype: 'init', session_id: 's1', cwd: '/w', model: 'claude-x' }),
    ).toEqual([{ type: 'system', sessionId: 's1', cwd: '/w', model: 'claude-x' }]);
  });

  it('maps assistant content blocks to text/thinking/tool_use', () => {
    expect(
      translateSdkMessage({
        type: 'assistant',
        session_id: 's1',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ).toEqual([
      { type: 'text', delta: 'hi' },
      { type: 'thinking', delta: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('maps user tool_result blocks', () => {
    expect(
      translateSdkMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
      }),
    ).toEqual([{ type: 'tool_result', id: 't1', output: 'ok', isError: false }]);
  });

  it('maps a successful result to usage + done', () => {
    expect(
      translateSdkMessage({
        type: 'result',
        subtype: 'success',
        session_id: 's1',
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      }),
    ).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 20, cachedInputTokens: 5, costUsd: 0.02 },
      { type: 'done', sessionId: 's1', terminationReason: 'normal' },
    ]);
  });

  it('maps an error result to an error event', () => {
    const out = translateSdkMessage({ type: 'result', subtype: 'error_during_execution', session_id: 's1' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });

  it('maps an assistant error field to an error event', () => {
    const out = translateSdkMessage({ type: 'assistant', error: 'billing_error', session_id: 's1', message: { content: [] } });
    expect(out[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((out[0] as { message: string }).message).toContain('billing_error');
  });

  it('ignores unrelated message types', () => {
    expect(translateSdkMessage({ type: 'stream_event' })).toEqual([]);
    expect(translateSdkMessage(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/agent/claude/sdk-translate.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/claude/sdk-translate.ts`:

```ts
import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface SdkRawMessage {
  type?: string;
  subtype?: string;
  error?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { content?: ContentBlock[] };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/**
 * Translate one SDKMessage into zero or more AgentEvents. Mirrors the field
 * access of the previous stream-json translator — SDK assistant/user messages
 * carry the same Anthropic content-block schema and usage token names.
 */
export function translateSdkMessage(raw: unknown): AgentEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const msg = raw as SdkRawMessage;
  const out: AgentEvent[] = [];

  if (msg.type === 'system' && msg.subtype === 'init') {
    out.push({ type: 'system', sessionId: msg.session_id, cwd: msg.cwd, model: msg.model });
    return out;
  }

  if (msg.type === 'assistant') {
    // A refusal / auth / billing error surfaces on the assistant frame.
    if (typeof msg.error === 'string' && msg.error) {
      out.push({ type: 'error', message: `claude error: ${msg.error}`, terminationReason: 'failed' });
      return out;
    }
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        out.push({ type: 'text', delta: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        out.push({ type: 'thinking', delta: block.thinking });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return out;
  }

  if (msg.type === 'user') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        out.push({
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        });
      }
    }
    return out;
  }

  if (msg.type === 'result') {
    if (msg.subtype && msg.subtype !== 'success') {
      out.push({
        type: 'error',
        message: `claude run failed: ${msg.subtype}`,
        terminationReason: 'failed',
      });
      return out;
    }
    if (msg.usage) {
      out.push({
        type: 'usage',
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cachedInputTokens: msg.usage.cache_read_input_tokens,
        costUsd: msg.total_cost_usd,
      });
    }
    out.push({ type: 'done', sessionId: msg.session_id, terminationReason: 'normal' });
    return out;
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/agent/claude/sdk-translate.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/sdk-translate.ts tests/unit/agent/claude/sdk-translate.test.ts
git commit -m "feat(claude): translate SDK messages to AgentEvent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: SDK 适配器 — 驱动对等（bypassPermissions，无审批）

**Files:**
- Modify: `package.json`（增依赖）
- Create: `src/agent/claude/sdk-adapter.ts`
- Test: `tests/process/claude-sdk-adapter.test.ts`

**Interfaces:**
- Consumes: `translateSdkMessage`（Task 3）、`classifyTool`（Task 2，Task 5 用）、`AgentAdapter`/`AgentRun`/`AgentRunOptions`（types）、`buildBridgeSystemPrompt`、`buildLarkChannelEnv`。
- Produces:
  - `type QueryFn = (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => AsyncIterable<unknown> & { interrupt?(): Promise<void> }`
  - `class ClaudeSdkAdapter implements AgentAdapter`，构造项 `{ binary?, larkChannel?, env?, queryFn?, permissionTimeoutMs? }`（`queryFn` 用于测试注入，默认真实 SDK `query`）。

设计要点：
- 每次 `run()` 新建 `AbortController`；`options.abortController` 传入；`stop()` = `controller.abort()`。
- `options.pathToClaudeCodeExecutable = this.binary`（默认 `'claude'`）。
- `options.systemPrompt = { type:'preset', preset:'claude_code', append: buildBridgeSystemPrompt(this.botIdentity) }`（等价旧 `--append-system-prompt`）。
- `options.permissionMode = opts.permissionMode ?? 'bypassPermissions'`；当为 `'bypassPermissions'` 时同时置 `allowDangerouslySkipPermissions: true`（SDK 要求）。
- `options.resume = opts.sessionId`（若有）；`options.model = opts.model`（若有）；`options.cwd = opts.cwd`；`options.env`；`options.includePartialMessages = false`。
- `events` 为 async generator：`for await (const m of query(...)) yield* translateSdkMessage(m)`；被 abort 时若无终止事件，补发 `error`/`done`。
- `waitForExit(timeoutMs)`：等待内部“迭代结束”promise 或超时。

- [ ] **Step 1: 加依赖**

Run:
```bash
pnpm add @anthropic-ai/claude-agent-sdk
```
Expected: `package.json` 出现 `@anthropic-ai/claude-agent-sdk` 于 `dependencies`。

- [ ] **Step 2: Write the failing test**

Create `tests/process/claude-sdk-adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from '../../src/agent/claude/sdk-adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// A fake query() returning a fixed SDKMessage sequence.
function fakeQuery(messages: unknown[]) {
  return (params: { options?: Record<string, unknown> }) => {
    const iterable = (async function* () {
      for (const m of messages) yield m;
    })();
    return Object.assign(iterable, {
      _params: params,
      interrupt: async () => {},
    });
  };
}

describe('ClaudeSdkAdapter driver parity', () => {
  it('passes cwd, resume, model, bypass mode, and preset system prompt to query', async () => {
    let captured: Record<string, unknown> | undefined;
    const queryFn = ((params: { options?: Record<string, unknown> }) => {
      captured = params.options;
      return fakeQuery([{ type: 'result', subtype: 'success', session_id: 'sess-1' }])(params);
    }) as never;

    const adapter = new ClaudeSdkAdapter({ binary: '/usr/bin/claude', queryFn });
    const run = adapter.run({
      runId: 'r1',
      prompt: 'hello',
      cwd: '/work',
      sessionId: 'prev',
      model: 'claude-opus-4-8',
    });

    const events = await collect(run.events);
    expect(events).toEqual([{ type: 'done', sessionId: 'sess-1', terminationReason: 'normal' }]);
    expect(captured).toMatchObject({
      cwd: '/work',
      resume: 'prev',
      model: 'claude-opus-4-8',
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(captured?.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
  });

  it('translates a full message sequence', async () => {
    const adapter = new ClaudeSdkAdapter({
      queryFn: fakeQuery([
        { type: 'system', subtype: 'init', session_id: 's', cwd: '/w', model: 'm' },
        { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 1, output_tokens: 2 } },
      ]) as never,
    });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w' });
    const events = await collect(run.events);
    expect(events.map((e) => e.type)).toEqual(['system', 'text', 'usage', 'done']);
  });

  it('aborts on stop() and yields a terminal event when the stream ends early', async () => {
    const adapter = new ClaudeSdkAdapter({
      queryFn: ((params: { options?: { abortController?: AbortController } }) => {
        const iterable = (async function* () {
          // Never emits a result; ends only when aborted.
          await new Promise<void>((resolve) => {
            params.options?.abortController?.signal.addEventListener('abort', () => resolve());
          });
        })();
        return Object.assign(iterable, { interrupt: async () => {} });
      }) as never,
    });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w' });
    const iterator = run.events[Symbol.asyncIterator]();
    const firstPromise = iterator.next();
    await run.stop();
    const first = await firstPromise;
    expect(first.done ? undefined : first.value.type).toBe('error');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/process/claude-sdk-adapter.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: Write minimal implementation**

Create `src/agent/claude/sdk-adapter.ts`:

```ts
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../core/logger';
import { mergeProcessEnv } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { translateSdkMessage } from './sdk-translate';

/**
 * Minimal structural type for the SDK's query(). We keep it loose so tests can
 * inject a fake without importing the SDK's large type surface.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown> & { interrupt?(): Promise<void> };

export interface ClaudeSdkAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  env?: NodeJS.ProcessEnv;
  queryFn?: QueryFn;
  /** Grace before a parked permission request auto-denies. */
  permissionTimeoutMs?: number;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

export class ClaudeSdkAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly queryFn: QueryFn;
  private readonly permissionTimeoutMs: number;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeSdkAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
    this.env = opts.env ?? {};
    this.queryFn = opts.queryFn ?? (sdkQuery as unknown as QueryFn);
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for ClaudeSdkAdapter.run');

    const controller = new AbortController();
    const permissionMode = opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE;

    // Seed process.env first: the SDK REPLACES (does not merge) the subprocess
    // environment with options.env, so PATH/HOME/~/.claude discovery would be
    // lost otherwise. Precedence: process.env < lark-channel env < profile env.
    const env = mergeProcessEnv(
      mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      this.env,
    );
    const options: Record<string, unknown> = {
      cwd: opts.cwd,
      abortController: controller,
      pathToClaudeCodeExecutable: this.binary,
      includePartialMessages: false,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildBridgeSystemPrompt(this.botIdentity),
      },
      permissionMode,
      env,
    };
    if (permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    if (opts.sessionId) options.resume = opts.sessionId;
    if (opts.model) options.model = opts.model;

    log.info('agent', 'sdk-run', {
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      permissionMode,
    });

    const q = this.queryFn({ prompt: opts.prompt, options });
    let finished = false;
    const exitWaiters = new Set<() => void>();
    const markFinished = (): void => {
      finished = true;
      for (const w of [...exitWaiters]) w();
    };

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      let sawTerminal = false;
      try {
        for await (const msg of q) {
          for (const evt of translateSdkMessage(msg)) {
            if (evt.type === 'done' || evt.type === 'error') sawTerminal = true;
            yield evt;
          }
        }
      } catch (err) {
        if (!sawTerminal) {
          sawTerminal = true;
          yield {
            type: 'error',
            message: `claude sdk error: ${err instanceof Error ? err.message : String(err)}`,
            terminationReason: controller.signal.aborted ? 'interrupted' : 'failed',
          };
        }
      } finally {
        markFinished();
      }
      if (!sawTerminal) {
        yield controller.signal.aborted
          ? { type: 'error', message: 'claude run interrupted', terminationReason: 'interrupted' }
          : { type: 'done', terminationReason: 'normal' };
      }
    })();

    return {
      runId: opts.runId,
      events,
      async stop() {
        if (finished) return;
        controller.abort();
        if (typeof q.interrupt === 'function') await q.interrupt().catch(() => {});
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (finished) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            exitWaiters.delete(done);
            resolve(true);
          };
          const timer = setTimeout(() => {
            exitWaiters.delete(done);
            resolve(false);
          }, timeoutMs);
          exitWaiters.add(done);
        });
      },
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/process/claude-sdk-adapter.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/agent/claude/sdk-adapter.ts tests/process/claude-sdk-adapter.test.ts
git commit -m "feat(claude): SDK-driven adapter at bypassPermissions parity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 审批 promise 桥接（canUseTool → permission_request → respondPermission）

**Files:**
- Modify: `src/agent/claude/sdk-adapter.ts`
- Test: `tests/process/claude-sdk-adapter.test.ts`

**Interfaces:**
- Consumes: `classifyTool`（Task 2）。
- Produces: `run()` 返回的 `AgentRun` 实现 `respondPermission(id, decision, opts?)`；当工具需审批时 `events` 产出 `permission_request`。

设计要点（**Phase 1a 的真正难点**）：
- `options.permissionMode` 改为默认 `'default'`（这样 `canUseTool` 会被 SDK 调用）；仅当调用方显式传 `bypassPermissions` 时不装 `canUseTool`。
- `canUseTool(toolName, input, { signal, title, displayName, description, toolUseID })`：
  - `classifyTool(toolName) === 'auto-allow'` → 立即 `return { behavior: 'allow' }`。
  - 否则：以 `toolUseID`（缺则自增）为 `id`，把 `permission_request` 事件推入一个内部队列（供 events 生成器产出），并**返回一个挂起 promise**，登记到 `pending: Map<string, { resolve }>`。
  - 起超时定时器（`permissionTimeoutMs`）→ 到期 resolve `deny`。
  - 监听 `signal` 的 `abort` → resolve `deny`（**停止/中断时强制收尾，否则 SDK 永久挂起**）。
- `respondPermission(id, decision, opts)`：取 `pending`，清定时器/监听，resolve 对应 `PermissionResult`。allow → `{behavior:'allow', updatedInput: opts?.updatedInput}`；deny → `{behavior:'deny', message: opts?.message ?? 'denied by user'}`。
- events 生成器需要把“SDK 消息流”与“canUseTool 推入的 permission_request”合并产出。实现用一个简单的异步队列（push + waiter），SDK 消费循环与 canUseTool 都往同一队列写，生成器从队列读。

- [ ] **Step 1: Write the failing test**

追加到 `tests/process/claude-sdk-adapter.test.ts`：

```ts
describe('ClaudeSdkAdapter interactive approval', () => {
  // fake query that drives canUseTool from options, then finishes.
  function approvalQuery() {
    return ((params: { options?: Record<string, unknown> }) => {
      const canUseTool = params.options?.canUseTool as
        | ((n: string, i: unknown, o: { signal: AbortSignal; toolUseID: string }) => Promise<unknown>)
        | undefined;
      const iterable = (async function* () {
        const controller = params.options?.abortController as AbortController;
        const decision = await canUseTool!('Bash', { command: 'rm -rf x' }, {
          signal: controller.signal,
          toolUseID: 'tu-1',
        });
        yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: JSON.stringify(decision) }] } };
        yield { type: 'result', subtype: 'success', session_id: 's' };
      })();
      return Object.assign(iterable, { interrupt: async () => {} });
    }) as never;
  }

  it('emits permission_request and honors an allow response', async () => {
    const adapter = new ClaudeSdkAdapter({ queryFn: approvalQuery() });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const it = run.events[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toMatchObject({ type: 'permission_request', id: 'tu-1', toolName: 'Bash' });
    run.respondPermission!('tu-1', 'allow');
    const second = await it.next();
    expect(second.value).toMatchObject({ type: 'text' });
    expect((second.value as { delta: string }).delta).toContain('"behavior":"allow"');
  });

  it('auto-denies a parked permission when the run is stopped', async () => {
    const adapter = new ClaudeSdkAdapter({ queryFn: approvalQuery() });
    const run = adapter.run({ runId: 'r', prompt: 'p', cwd: '/w', permissionMode: 'default' });
    const it = run.events[Symbol.asyncIterator]();
    await it.next(); // permission_request
    await run.stop();
    const rest: string[] = [];
    for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value.type);
    // The parked promise resolved to deny (not hung); stream terminates.
    expect(rest.some((t) => t === 'text' || t === 'error' || t === 'done')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/process/claude-sdk-adapter.test.ts -t "interactive approval"`
Expected: FAIL（`respondPermission` 未实现 / 无 `permission_request` 产出）。

- [ ] **Step 3: Implement the permission bridge**

在 `sdk-adapter.ts` 顶部 import 增加：

```ts
import { classifyTool } from './permission-policy';
```

将 `run()` 内的事件产出改为“队列合并”模型。用如下补丁替换 Task 4 里 `const q = this.queryFn(...)` 到 `events` 定义之间的部分：

```ts
    // Merge two producers into one AgentEvent stream: the SDK message loop and
    // the canUseTool permission prompts. A tiny push/waiter queue serializes them.
    const queue: AgentEvent[] = [];
    const waiters = new Set<() => void>();
    let closed = false;
    const pushEvent = (evt: AgentEvent): void => {
      queue.push(evt);
      for (const w of [...waiters]) w();
    };
    const closeQueue = (): void => {
      closed = true;
      for (const w of [...waiters]) w();
    };

    interface Pending {
      resolve: (r: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
      onAbort: () => void;
    }
    const pending = new Map<string, Pending>();
    const settle = (
      id: string,
      result: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string },
    ): void => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      controller.signal.removeEventListener('abort', p.onAbort);
      p.resolve(result);
    };

    const canUseTool =
      permissionMode === 'bypassPermissions'
        ? undefined
        : async (
            toolName: string,
            input: Record<string, unknown>,
            ctx: { signal: AbortSignal; title?: string; displayName?: string; description?: string; toolUseID?: string },
          ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }> => {
            if (classifyTool(toolName) === 'auto-allow') return { behavior: 'allow' };
            const id = ctx.toolUseID ?? `perm-${pending.size + 1}`;
            pushEvent({
              type: 'permission_request',
              id,
              toolName,
              input,
              title: ctx.title,
              displayName: ctx.displayName,
              description: ctx.description,
            });
            return new Promise((resolve) => {
              const onAbort = (): void => settle(id, { behavior: 'deny', message: 'run stopped' });
              const timer = setTimeout(
                () => settle(id, { behavior: 'deny', message: 'approval timed out' }),
                this.permissionTimeoutMs,
              );
              controller.signal.addEventListener('abort', onAbort);
              pending.set(id, { resolve, timer, onAbort });
            });
          };
    if (canUseTool) options.canUseTool = canUseTool;

    const q = this.queryFn({ prompt: opts.prompt, options });
    let finished = false;
    const exitWaiters = new Set<() => void>();
    const markFinished = (): void => {
      finished = true;
      for (const w of [...exitWaiters]) w();
    };

    // Drain the SDK stream into the shared queue.
    void (async () => {
      let sawTerminal = false;
      try {
        for await (const msg of q) {
          for (const evt of translateSdkMessage(msg)) {
            if (evt.type === 'done' || evt.type === 'error') sawTerminal = true;
            pushEvent(evt);
          }
        }
      } catch (err) {
        if (!sawTerminal) {
          sawTerminal = true;
          pushEvent({
            type: 'error',
            message: `claude sdk error: ${err instanceof Error ? err.message : String(err)}`,
            terminationReason: controller.signal.aborted ? 'interrupted' : 'failed',
          });
        }
      } finally {
        if (!sawTerminal) {
          pushEvent(
            controller.signal.aborted
              ? { type: 'error', message: 'claude run interrupted', terminationReason: 'interrupted' }
              : { type: 'done', terminationReason: 'normal' },
          );
        }
        // Force-resolve any parked permission so canUseTool callers unblock.
        for (const id of [...pending.keys()]) settle(id, { behavior: 'deny', message: 'run ended' });
        markFinished();
        closeQueue();
      }
    })();

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      let i = 0;
      for (;;) {
        if (i < queue.length) {
          yield queue[i++]!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
        });
      }
    })();
```

在返回对象里，`stop()` 之后追加 `respondPermission`（stop 内的 `controller.abort()` 已触发 `onAbort` 强制收尾）：

```ts
      respondPermission(id, decision, respOpts) {
        settle(
          id,
          decision === 'allow'
            ? { behavior: 'allow', updatedInput: respOpts?.updatedInput }
            : { behavior: 'deny', message: respOpts?.message ?? 'denied by user' },
        );
      },
```

> 注：`settle`/`pending`/`controller` 在 `run()` 作用域内，返回对象的方法通过闭包访问它们。确保 `respondPermission` 与 `stop`/`waitForExit` 定义在同一 `return { ... }` 内。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/process/claude-sdk-adapter.test.ts && pnpm typecheck`
Expected: PASS（含 Task 4 既有用例——注意其断言 `permissionMode: 'bypassPermissions'` 的用例仍显式传该模式）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/sdk-adapter.ts tests/process/claude-sdk-adapter.test.ts
git commit -m "feat(claude): interactive approval bridge with timeout and abort force-resolve

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 接线并删除旧 CLI 适配器

**Files:**
- Modify: `src/cli/commands/start.ts:437`
- Modify: `src/agent/index.ts`（如聚合导出）
- Delete: `src/agent/claude/adapter.ts`、`src/agent/claude/stream-json.ts`
- Delete: `tests/process/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `ClaudeSdkAdapter`（Task 4/5）。

> **达到对等后再删**：仅当 Task 4/5 全绿后执行本任务。`createRuntimeAgent` **暂不注入** `canUseTool` 路径——即不传 `permissionMode: 'default'` 的审批消费方；ClaudeSdkAdapter 默认按调用方传入的 `permissionMode` 走，run-policy 现有默认仍是 `bypassPermissions`，故生产行为与今日一致，审批留待 Phase 1b 打开。

- [ ] **Step 1: 切换 createRuntimeAgent**

`src/cli/commands/start.ts` 顶部 import 把 `ClaudeAdapter` 换为 `ClaudeSdkAdapter`（来源 `../../agent/claude/sdk-adapter` 或聚合 `../../agent`）。将第 437 行：

```ts
  return new ClaudeAdapter({ larkChannel });
```
改为：
```ts
  return new ClaudeSdkAdapter({
    larkChannel,
    ...(profileConfig.claude?.env ? { env: profileConfig.claude.env } : {}),
  });
```

- [ ] **Step 2: 删旧文件与旧测试**

Run:
```bash
git rm src/agent/claude/adapter.ts src/agent/claude/stream-json.ts tests/process/claude-adapter.test.ts
```
若 `src/agent/index.ts` 或他处 import 了 `ClaudeAdapter`/`translateEvent`，改为 `ClaudeSdkAdapter`/`translateSdkMessage` 或移除。

- [ ] **Step 3: 全量校验**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿；无对已删除模块的悬空 import。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(claude): replace CLI adapter with SDK-driven adapter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage（对 spec §3/§4/§5）：**
- §3 驱动与认证 → Task 4（`pathToClaudeCodeExecutable`、`systemPrompt` preset、env、resume/model）。
- §3.1 无回退 + 删除次序 → Task 6（对等后再删）。
- §4 契约扩展（permission_request / respondPermission / steer）→ Task 1；`steer` 声明但实现留 Phase 2（可选方法，符合 spec）。
- §4.1 stop() abort 语义 → Task 4（AbortController）。
- §5.1 白名单审批策略 → Task 2 + Task 5（canUseTool 分流）。
- §5.2 promise 桥接（注册表 / 超时归属适配器 / 中断强制收尾）→ Task 5。
- §5.3 流式收尾对等：本计划为 agent 层，收尾对等属**卡片层**验证，标记为 Phase 1b 退出标准（下一个计划），此处不覆盖。
- **未覆盖（有意）**：飞书审批卡片与 channel 接线 = Phase 1b 单独计划；长驻会话/真转向 = Phase 2 计划。

**Placeholder scan：** 无 TBD/TODO；每个代码步骤给出完整代码。

**Type consistency：** `translateSdkMessage`（Task 3/4/5 一致）、`classifyTool`（Task 2/5 一致）、`respondPermission(id, decision, opts?)` 签名（Task 1 契约与 Task 5 实现一致）、`permission_request` 字段（Task 1 与 Task 3/5 一致：id/toolName/input/title/displayName/description）。

**已知待办（移交 Phase 1b 计划确认）：** `canUseTool` 在 `permissionMode: 'default'` 下对只读工具是否仍会回调（若 SDK 在 default 模式已自动放行只读工具，则 Task 2 白名单为防御性冗余，不影响正确性）；接线时以 SDK 实测为准。
