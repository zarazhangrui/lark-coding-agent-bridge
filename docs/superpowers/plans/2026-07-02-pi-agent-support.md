# Pi Agent Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pi` (`@earendil-works/pi-coding-agent`, binary `pi`) as a third supported `agentKind` in `lark-channel-bridge`, alongside the existing `claude` and `codex`.

**Architecture:** A new spawn-per-turn adapter (`src/agent/pi/{argv,jsonl,adapter}.ts`) mirroring `src/agent/codex/`'s structure: each turn runs `pi --mode json [--session <id>] [--tools read,grep,find,ls] [@image ...]` as a one-shot subprocess, with the bridge system prompt + user prompt delivered entirely via stdin (no positional argv message, sidestepping the Windows argv-escaping issue). Session continuity uses pi's native `--session <id>` resume (like Claude, unlike Codex's thread model) — so pi is treated as "Claude-shaped" (uses `sessionId`, no `threadId`) everywhere the bridge branches on that distinction. Permission mapping threads the bridge's own `AccessMode` straight through rather than inventing a pi-specific sandbox enum. See `docs/superpowers/specs/2026-07-02-pi-agent-support-design.md` for full rationale — read it before starting.

**Tech Stack:** TypeScript, Node.js child_process (via existing `src/platform/spawn.ts` wrapper), Vitest.

---

## Before you start

Read `docs/superpowers/specs/2026-07-02-pi-agent-support-design.md` in full. This plan implements that spec; where this plan's code differs in a small detail (e.g. `buildPiArgs` does not take a `cwd` parameter, unlike the spec's placeholder signature, because pi has no `-C`-equivalent flag — cwd is set purely via the child process's `cwd` spawn option), the plan is authoritative since it was written after reading pi's actual argument-parsing source.

Every task below assumes you're working directly in `/Users/fanfei/monorepo/lark-coding-agent-bridge` (or a worktree of it) with `pnpm install` already run. Run `pnpm test`, `pnpm typecheck` frequently — don't wait until the end to discover a break.

**Key facts this plan relies on (verified against `/Users/fanfei/monorepo/pi-mono/packages/coding-agent` source, not just docs):**
- `pi --mode json` is single-shot: one prompt in, JSON event lines out, process exits (`src/modes/print-mode.ts`).
- Piped stdin becomes the entire initial message when no positional message argument is given (`src/cli/initial-message.ts`: `buildInitialMessage` pushes `stdinContent` first, then `parsed.messages[0]` only if present — so stdin alone is sufficient).
- The first stdout line is normally `{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"..."}`.
- Assistant message usage fields are `usage.input` / `usage.output` / `usage.cacheRead` / `usage.cacheWrite` / `usage.cost.total` (NOT `input_tokens` like Codex — different field-naming convention, confirmed via `packages/coding-agent/docs/rpc.md`'s `AssistantMessage` example, which documents the same message shape JSON mode emits).
- Error/abort surfaces via `message.stopReason === 'error' | 'aborted'` plus `message.errorMessage`, confirmed directly from `src/modes/print-mode.ts`'s own error handling: `if (assistantMsg.stopReason === 'error' || assistantMsg.stopReason === 'aborted') { console.error(assistantMsg.errorMessage || ...) }`. Note: despite `json.md`'s docs table listing an `"error"` variant of `assistantMessageEvent` (inside `message_update`), that variant cannot actually appear in pi's real event stream (verified against `packages/agent/src/agent-loop.ts`'s `streamAssistantResponse`) — `message_end.message.stopReason`/`errorMessage` is the only real error-detection path. Task 3's translator below still lists `'error'` in `IGNORED_ASSISTANT_MESSAGE_EVENT_TYPES` for forward-compatibility/doc-parity, but don't rely on it ever firing.
- `--tools read,grep,find,ls` is pi's documented read-only invocation (drops `bash`/`edit`/`write`).
- pi has no `-C`/`--cwd` flag; cwd is inherited from the process's working directory only.
- pi's real `AgentSessionEvent`/`AgentEvent` unions include a few more event types than `json.md`'s docs table emphasizes: `tool_execution_update` (streams partial tool output — fires frequently on long-running bash commands), `session_info_changed`, and `thinking_level_changed`. Task 3's translator explicitly ignores all three rather than counting them as protocol drift.

---

## Phase 1 — Type foundation

### Task 1: Widen `AgentKind`/`AgentCapabilityId`/`LocalAgentId` unions and add `PiConfig`

**Files:**
- Modify: `src/config/profile-schema.ts:16` (`AgentKind`), `:34-45` region (add `PiConfig` after `CodexConfig`), `:92` (`ProfileConfig.pi?`), `:118` (`CreateDefaultProfileConfigInput.pi?`), `:135-345` (`normalizeProfileConfig` validation + `normalizePi`)
- Modify: `src/agent/preflight.ts:3` (`LocalAgentId`), `:279-286` (`isAgentPreflightDiagnostic`)
- Modify: `src/cli/agent-detection.ts:5` (`AgentKind`), `:48-51` (`detectInstalledAgents` candidates)
- Test: `tests/unit/config/profile-schema.test.ts`

- [ ] **Step 1: Read the existing profile-schema tests to match style**

Run: `cat tests/unit/config/profile-schema.test.ts | head -60` to see how `normalizeProfileConfig`/`createDefaultProfileConfig` are tested for `codex` today (there should be a "codex profile requires codex configuration" throw test and a round-trip test). You'll mirror these for `pi`.

- [ ] **Step 2: Write failing tests for `pi` profile validation**

Add to `tests/unit/config/profile-schema.test.ts` (near the existing codex validation tests):

```ts
it('rejects an unknown agentKind', () => {
  expect(() =>
    normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'bogus',
      accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    }),
  ).toThrow(/agentKind must be claude, codex, or pi/);
});

it('requires pi configuration for a pi profile', () => {
  expect(() =>
    normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'pi',
      accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    }),
  ).toThrow(/pi profile requires pi configuration/);
});

it('round-trips a pi profile config, defaulting inheritPiHome to false', () => {
  const profile = createDefaultProfileConfig({
    agentKind: 'pi',
    accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    pi: { binaryPath: '/usr/local/bin/pi' },
  });
  expect(profile.agentKind).toBe('pi');
  expect(profile.pi).toEqual({
    binaryPath: '/usr/local/bin/pi',
    inheritPiHome: false,
  });
});

it('honors an explicit inheritPiHome: true', () => {
  const profile = createDefaultProfileConfig({
    agentKind: 'pi',
    accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    pi: { binaryPath: '/usr/local/bin/pi', inheritPiHome: true },
  });
  expect(profile.pi?.inheritPiHome).toBe(true);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/config/profile-schema.test.ts`
Expected: FAIL — `agentKind must be claude or codex` thrown instead of the new message; `pi` field undefined.

- [ ] **Step 4: Add `PiConfig` and widen `AgentKind`**

In `src/config/profile-schema.ts`, after the existing `CodexConfig` interface (line 45), add:

```ts
export interface PiConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  piHome?: string;
  inheritPiHome?: boolean;
}
```

Change line 16 from:
```ts
export type AgentKind = 'claude' | 'codex';
```
to:
```ts
export type AgentKind = 'claude' | 'codex' | 'pi';
```

Add `pi?: PiConfig;` next to `codex?: CodexConfig;` in `ProfileConfig` (line 92) and in `CreateDefaultProfileConfigInput` (line 118).

- [ ] **Step 5: Update `normalizeProfileConfig` validation and add `normalizePi`**

In the `raw` type annotation inside `normalizeProfileConfig` (around line 152), add a sibling to the `codex` field:
```ts
codex?: CodexConfig & { flags?: unknown };
pi?: PiConfig;
```

Change the validation block (lines 161-167) from:
```ts
if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex') {
  throw new Error('agentKind must be claude or codex');
}
const accounts = normalizeAccounts(raw.accounts);
if (raw.agentKind === 'codex' && !raw.codex) {
  throw new Error('codex profile requires codex configuration');
}
```
to:
```ts
if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex' && raw.agentKind !== 'pi') {
  throw new Error('agentKind must be claude, codex, or pi');
}
const accounts = normalizeAccounts(raw.accounts);
if (raw.agentKind === 'codex' && !raw.codex) {
  throw new Error('codex profile requires codex configuration');
}
if (raw.agentKind === 'pi' && !raw.pi) {
  throw new Error('pi profile requires pi configuration');
}
```

Add `...(raw.pi ? { pi: normalizePi(raw.pi) } : {}),` right after the existing `...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),` line (line 194) in the returned object.

Add a `normalizePi` function right after `normalizeCodex` (after line 286):
```ts
function normalizePi(input: PiConfig): PiConfig {
  const pi: PiConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.piHome === 'string' ? { piHome: input.piHome } : {}),
    inheritPiHome: input.inheritPiHome === true,
  };
  return pi;
}
```
Note the default direction is intentionally opposite Codex's `inheritCodexHome: input.inheritCodexHome !== false` (Codex defaults to inheriting the user's global `~/.codex`; pi defaults to a **profile-scoped** home per this feature's design decision, so `inheritPiHome` defaults to `false` unless explicitly set `true`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/config/profile-schema.test.ts`
Expected: PASS

- [ ] **Step 7: Widen `LocalAgentId` and `AgentKind` in the other two files**

In `src/agent/preflight.ts:3`, change:
```ts
export type LocalAgentId = 'claude' | 'codex';
```
to:
```ts
export type LocalAgentId = 'claude' | 'codex' | 'pi';
```
In `isAgentPreflightDiagnostic` (around line 282), change:
```ts
(raw.agentId === 'claude' || raw.agentId === 'codex') &&
```
to:
```ts
(raw.agentId === 'claude' || raw.agentId === 'codex' || raw.agentId === 'pi') &&
```

In `src/cli/agent-detection.ts:5`, change:
```ts
export type AgentKind = 'claude' | 'codex';
```
to:
```ts
export type AgentKind = 'claude' | 'codex' | 'pi';
```
In `detectInstalledAgents()` (around line 48-51), add a third candidate:
```ts
const candidates: Array<{ kind: AgentKind; command: string }> = [
  { kind: 'claude', command: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude' },
  { kind: 'codex', command: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex' },
  { kind: 'pi', command: process.env.LARK_CHANNEL_PI_BIN ?? 'pi' },
];
```

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (fix any fallout — there may be other places importing `AgentKind` from `agent-detection.ts` vs `profile-schema.ts`; both are now three-way unions so this should be silent, but check).

- [ ] **Step 9: Commit**

```bash
git add src/config/profile-schema.ts src/agent/preflight.ts src/cli/agent-detection.ts tests/unit/config/profile-schema.test.ts
git commit -m "feat: add pi to AgentKind/LocalAgentId unions and PiConfig schema"
```

---

## Phase 2 — Pure functions (TDD)

### Task 2: `buildPiArgs`

**Files:**
- Create: `src/agent/pi/argv.ts`
- Test: `tests/unit/agent/pi-argv.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/agent/pi-argv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPiArgs } from '../../../src/agent/pi/argv.js';

describe('Pi argv contract', () => {
  it('builds the fresh-run argv with no session, no tools restriction', () => {
    expect(buildPiArgs({ accessMode: 'full' })).toEqual(['--mode', 'json']);
  });

  it('adds --session when resuming', () => {
    expect(buildPiArgs({ accessMode: 'full', sessionId: 'sess-123' })).toEqual([
      '--mode',
      'json',
      '--session',
      'sess-123',
    ]);
  });

  it('restricts tools for read-only access', () => {
    expect(buildPiArgs({ accessMode: 'read-only' })).toEqual([
      '--mode',
      'json',
      '--tools',
      'read,grep,find,ls',
    ]);
  });

  it('does not restrict tools for workspace access (no native workspace sandbox in pi)', () => {
    expect(buildPiArgs({ accessMode: 'workspace' })).toEqual(['--mode', 'json']);
  });

  it('appends image attachments as @path argv tokens', () => {
    expect(
      buildPiArgs({ accessMode: 'full', images: ['/tmp/one.png', '/tmp/two.jpg'] }),
    ).toEqual(['--mode', 'json', '@/tmp/one.png', '@/tmp/two.jpg']);
  });

  it('combines session, read-only tools, and images in a stable order', () => {
    expect(
      buildPiArgs({
        accessMode: 'read-only',
        sessionId: 'sess-abc',
        images: ['/tmp/pic.png'],
      }),
    ).toEqual([
      '--mode',
      'json',
      '--session',
      'sess-abc',
      '--tools',
      'read,grep,find,ls',
      '@/tmp/pic.png',
    ]);
  });

  it('throws on an unrecognized access mode', () => {
    // @ts-expect-error deliberately invalid input
    expect(() => buildPiArgs({ accessMode: 'nonsense' })).toThrow(/unsafe access mode/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/agent/pi-argv.test.ts`
Expected: FAIL — `Cannot find module '../../../src/agent/pi/argv.js'`

- [ ] **Step 3: Implement `buildPiArgs`**

Create `src/agent/pi/argv.ts`:

```ts
import type { AccessMode } from '../../config/permissions';

export interface BuildPiArgsInput {
  accessMode: AccessMode;
  sessionId?: string;
  images?: readonly string[];
}

export function buildPiArgs(input: BuildPiArgsInput): string[] {
  if (
    input.accessMode !== 'read-only' &&
    input.accessMode !== 'workspace' &&
    input.accessMode !== 'full'
  ) {
    throw new Error(`unsafe access mode: ${input.accessMode}`);
  }

  const args = ['--mode', 'json'];

  if (input.sessionId) {
    args.push('--session', input.sessionId);
  }

  if (input.accessMode === 'read-only') {
    args.push('--tools', 'read,grep,find,ls');
  }

  for (const image of input.images ?? []) {
    args.push(`@${image}`);
  }

  return args;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/agent/pi-argv.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/pi/argv.ts tests/unit/agent/pi-argv.test.ts
git commit -m "feat: add buildPiArgs for pi CLI invocation"
```

---

### Task 3: `PiJsonlTranslator`

**Files:**
- Create: `src/agent/pi/jsonl.ts`
- Test: `tests/unit/agent/pi-jsonl.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/agent/pi-jsonl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PiJsonlTranslator } from '../../../src/agent/pi/jsonl.js';

describe('Pi JSONL translator', () => {
  it('translates the session header into a system event', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'session', version: 3, id: 'sess-1', cwd: '/repo' })).toEqual([
      { type: 'system', sessionId: 'sess-1' },
    ]);
  });

  it('ignores structural lifecycle events with no bridge-visible payload', () => {
    const t = new PiJsonlTranslator();
    for (const type of [
      'agent_start',
      'turn_start',
      'turn_end',
      'message_start',
      'queue_update',
      'compaction_start',
      'compaction_end',
      'auto_retry_start',
      'auto_retry_end',
      'tool_execution_update',
      'session_info_changed',
      'thinking_level_changed',
    ]) {
      expect(t.translate({ type })).toEqual([]);
    }
  });

  it('translates text and thinking deltas', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      }),
    ).toEqual([{ type: 'text', delta: 'Hello' }]);
    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' },
      }),
    ).toEqual([{ type: 'thinking', delta: 'pondering' }]);
    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_start' },
      }),
    ).toEqual([]);
  });

  it('translates tool execution start/end', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
      }),
    ).toEqual([{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'ls' } }]);
    expect(
      t.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'total 0\n' }] },
        isError: false,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-1', output: 'total 0\n', isError: false }]);
  });

  it('joins multiple text content blocks in a tool result', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-2',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        isError: true,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-2', output: 'ab', isError: true }]);
  });

  it('emits usage on a completed assistant message_end', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: { total: 0.002 } },
        },
      }),
    ).toEqual([
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 10,
        reasoningOutputTokens: undefined,
        costUsd: 0.002,
      },
    ]);
  });

  it('ignores message_end for non-assistant roles', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'message_end', message: { role: 'user' } })).toEqual([]);
    expect(t.translate({ type: 'message_end', message: { role: 'toolResult' } })).toEqual([]);
  });

  it('translates agent_end into a normal done event, carrying the captured session id', () => {
    const t = new PiJsonlTranslator();
    t.translate({ type: 'session', id: 'sess-done' });
    expect(t.translate({ type: 'agent_end', messages: [] })).toEqual([
      { type: 'done', sessionId: 'sess-done', terminationReason: 'normal' },
    ]);
  });

  it('translates an errored/aborted assistant message_end into a terminal error and suppresses the following agent_end', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'model overloaded' },
      }),
    ).toEqual([{ type: 'error', message: 'model overloaded', terminationReason: 'failed' }]);
    expect(t.terminalEmitted()).toBe(true);
    expect(t.translate({ type: 'agent_end', messages: [] })).toEqual([]);
  });

  it('falls back to a generic message when an errored message_end has no errorMessage', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } }),
    ).toEqual([{ type: 'error', message: 'pi request aborted', terminationReason: 'failed' }]);
  });

  it('tracks protocol drift for unrecognized event types', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'some_future_event' })).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 0 });
  });

  it('does not count real-but-ignored pi event types as protocol drift', () => {
    const t = new PiJsonlTranslator();
    t.translate({ type: 'tool_execution_update', toolCallId: 'x', toolName: 'bash', args: {}, partialResult: {} });
    t.translate({ type: 'session_info_changed' });
    t.translate({ type: 'thinking_level_changed', level: 'high' });
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });

  it('logs and ignores extension_error without ending the stream', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({ type: 'extension_error', extensionPath: '/x.ts', error: 'boom' }),
    ).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
  });

  it('emits a failed terminal event on EOF without a terminal event', () => {
    const t = new PiJsonlTranslator();
    t.translate({ type: 'session', id: 'sess-eof' });
    expect(t.finish()).toEqual([
      {
        type: 'error',
        message: 'pi stream ended before a terminal event',
        terminationReason: 'failed',
      },
    ]);
    expect(t.finish()).toEqual([]);
  });

  it('lets stop and timeout override EOF terminal reason', () => {
    const stopped = new PiJsonlTranslator();
    stopped.translate({ type: 'session', id: 'sess-stop' });
    expect(stopped.finish('interrupted')).toEqual([
      { type: 'done', sessionId: 'sess-stop', terminationReason: 'interrupted' },
    ]);

    const timedOut = new PiJsonlTranslator();
    timedOut.translate({ type: 'session', id: 'sess-timeout' });
    expect(timedOut.finish('timeout')).toEqual([
      { type: 'done', sessionId: 'sess-timeout', terminationReason: 'timeout' },
    ]);
  });

  it('returns nothing once terminal, even for further translate calls', () => {
    const t = new PiJsonlTranslator();
    t.translate({ type: 'agent_end', messages: [] });
    expect(t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/agent/pi-jsonl.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `PiJsonlTranslator`**

Create `src/agent/pi/jsonl.ts`, mirroring `src/agent/codex/jsonl.ts`'s structure and helper functions exactly (reuse the same `isRecord`/`recordValue`/`stringValue`/`numberValue`/`truncate` shape, redefined locally since this is a sibling module, not exported from Codex's file):

```ts
import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type PiFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

const IGNORED_EVENT_TYPES = new Set([
  'agent_start',
  'turn_start',
  'turn_end',
  'message_start',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  // Real pi event types not emphasized by json.md's docs table but present in
  // pi's actual AgentSessionEvent/AgentEvent unions (packages/agent/src/types.ts):
  // tool_execution_update streams on every partial tool-output chunk (e.g. a
  // long-running bash command) and would otherwise spam unknown_event drift.
  'tool_execution_update',
  'session_info_changed',
  'thinking_level_changed',
]);

const IGNORED_ASSISTANT_MESSAGE_EVENT_TYPES = new Set([
  'start',
  'text_start',
  'text_end',
  'thinking_start',
  'thinking_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
  'done',
  'error',
]);

export class PiJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.type) {
      case 'session':
        return this.translateSession(raw);
      case 'message_update':
        return this.translateMessageUpdate(raw);
      case 'tool_execution_start':
        return this.translateToolExecutionStart(raw);
      case 'tool_execution_end':
        return this.translateToolExecutionEnd(raw);
      case 'message_end':
        return this.translateMessageEnd(raw);
      case 'agent_end':
        return this.translateAgentEnd();
      case 'extension_error':
        log.warn('jsonl', 'extension_error', {
          extensionPath: stringValue(raw.extensionPath),
          message: truncate(stringValue(raw.error) ?? '', 500),
        });
        return [];
      default:
        if (IGNORED_EVENT_TYPES.has(raw.type)) return [];
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: PiFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return [
        {
          type: 'error',
          message: 'pi stream ended before a terminal event',
          terminationReason: 'failed',
        },
      ];
    }
    return [{ type: 'done', sessionId: this.sessionId, terminationReason: reason }];
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateSession(raw: Record<string, unknown>): AgentEvent[] {
    const sessionId = stringValue(raw.id);
    if (!sessionId) {
      this.drift.anomalies++;
      return [];
    }
    this.sessionId = sessionId;
    return [{ type: 'system', sessionId }];
  }

  private translateMessageUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const event = recordValue(raw.assistantMessageEvent);
    if (!event || typeof event.type !== 'string') return [];
    if (event.type === 'text_delta') {
      const delta = stringValue(event.delta);
      return delta ? [{ type: 'text', delta }] : [];
    }
    if (event.type === 'thinking_delta') {
      const delta = stringValue(event.delta);
      return delta ? [{ type: 'thinking', delta }] : [];
    }
    if (!IGNORED_ASSISTANT_MESSAGE_EVENT_TYPES.has(event.type)) {
      this.drift.unknownEvents++;
    }
    return [];
  }

  private translateToolExecutionStart(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    const name = stringValue(raw.toolName);
    if (!id || !name) {
      this.drift.anomalies++;
      return [];
    }
    return [{ type: 'tool_use', id, name, input: raw.args }];
  }

  private translateToolExecutionEnd(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    const result = recordValue(raw.result);
    return [
      {
        type: 'tool_result',
        id,
        output: extractToolOutputText(result),
        isError: raw.isError === true,
      },
    ];
  }

  private translateMessageEnd(raw: Record<string, unknown>): AgentEvent[] {
    const message = recordValue(raw.message);
    if (!message || message.role !== 'assistant') return [];

    const stopReason = stringValue(message.stopReason);
    if (stopReason === 'error' || stopReason === 'aborted') {
      this.terminal = true;
      const detail = stringValue(message.errorMessage);
      return [
        {
          type: 'error',
          message: detail ?? `pi request ${stopReason}`,
          terminationReason: 'failed',
        },
      ];
    }

    const usage = recordValue(message.usage);
    if (!usage) return [];
    const cost = recordValue(usage.cost);
    return [
      {
        type: 'usage',
        inputTokens: numberValue(usage.input),
        outputTokens: numberValue(usage.output),
        cachedInputTokens: numberValue(usage.cacheRead),
        reasoningOutputTokens: undefined,
        costUsd: numberValue(cost?.total),
      },
    ];
  }

  private translateAgentEnd(): AgentEvent[] {
    this.terminal = true;
    return [{ type: 'done', sessionId: this.sessionId, terminationReason: 'normal' }];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function extractToolOutputText(result: Record<string, unknown> | undefined): string {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
```

Note: `AgentEvent`'s `'usage'` variant (in `src/agent/types.ts`) already has an optional `costUsd?: number` field — confirm this while implementing; if it's missing, add it there (check first, Codex's translator never populates it so it may be present but unused, or entirely absent — grep `costUsd` in `src/agent/types.ts` before writing this file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/agent/pi-jsonl.test.ts`
Expected: PASS. If `costUsd` doesn't exist on the `usage` event type, add it to `AgentEvent`'s `usage` variant in `src/agent/types.ts` first, then re-run.

- [ ] **Step 5: Commit**

```bash
git add src/agent/pi/jsonl.ts tests/unit/agent/pi-jsonl.test.ts src/agent/types.ts
git commit -m "feat: add PiJsonlTranslator for pi --mode json event stream"
```

---

## Phase 3 — Adapter

### Task 4: `accessMode` passthrough in `AgentRunOptions` and `run-executor.ts`

**Files:**
- Modify: `src/agent/types.ts` (add `accessMode?: AccessMode` to `AgentRunOptions`)
- Modify: `src/runtime/run-executor.ts:96-107` (the single `runOptions` object built for `agent.run()`)

- [ ] **Step 1: Add the field**

In `src/agent/types.ts`, import `AccessMode` from `'../config/permissions'` (it's already re-exported as a type from `profile-schema.ts`; check which module `AgentRunOptions` should import it from — likely `'../config/permissions'` directly, matching how `ClaudePermissionMode`/`CodexSandboxMode` are imported there today) and add to `AgentRunOptions`:
```ts
accessMode?: AccessMode;
```
right next to the existing `sandbox?: CodexSandboxMode;` / `permissionMode?: ClaudePermissionMode;` fields.

- [ ] **Step 2: Forward it in `run-executor.ts`**

`src/runtime/run-executor.ts` builds exactly one `runOptions` object passed to `agent.run()`, at lines 96-107:
```ts
const runOptions = {
  runId,
  prompt: input.policy.prompt,
  cwd: input.policy.cwdRealpath,
  sessionId: input.sessionId,
  threadId: input.threadId,
  model: input.model,
  images: input.images,
  sandbox: input.policy.sandbox,
  permissionMode: input.policy.permissionMode,
  stopGraceMs: input.stopGraceMs,
};
```
Add `accessMode: input.policy.accessMode,` alongside `sandbox`/`permissionMode` there. (`input.policy.accessMode` already exists and is already read once elsewhere in this same file, in a `log.info` call around line 143 — that's an unrelated logging line, not a second `runOptions` site; don't touch it, it already works.)

- [ ] **Step 3: Typecheck and run the full unit suite**

Run: `pnpm typecheck && pnpm vitest run tests/unit`
Expected: PASS (this is purely additive — no existing behavior changes since no adapter reads `accessMode` yet).

- [ ] **Step 4: Commit**

```bash
git add src/agent/types.ts src/runtime/run-executor.ts
git commit -m "feat: forward accessMode into AgentRunOptions"
```

---

### Task 5: `PiAdapter`

**Files:**
- Create: `src/agent/pi/adapter.ts`
- Modify: `src/agent/index.ts` (export `PiAdapter`)
- Test: `tests/unit/agent/pi-prepare-run.test.ts`, `tests/process/pi-adapter.test.ts`

- [ ] **Step 1: Read the two files this mirrors**

Re-read `src/agent/codex/adapter.ts` in full (you should already have this from the design/spec phase) — `PiAdapter` follows the identical shape: spawn, stdin write via `prefixBridgeSystemPrompt`, stdout line-by-line JSONL translation, stderr capture, SIGTERM→grace→SIGKILL `stop()`, `waitForExit()`. The only structural differences: no `sandbox` field (use `accessMode` with default `'full'`), no `ignoreUserConfig`/`ignoreRules`, `piHome`/`inheritPiHome` instead of `codexHome`/`inheritCodexHome`, env var `PI_CODING_AGENT_DIR` instead of `CODEX_HOME`, and `buildPiArgs`/`PiJsonlTranslator` instead of the Codex equivalents.

- [ ] **Step 2: Write the failing prepare-run test**

Create `tests/unit/agent/pi-prepare-run.test.ts` (mirror `tests/unit/agent/codex-prepare-run.test.ts` exactly, swapping identifiers):

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../../src/agent/pi/adapter.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';

const cleanups: Array<() => Promise<void>> = [];

describe('PiAdapter prepareRun', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('allows a run when the configured pi binary returns a version', async () => {
    const binary = await writePiBinary('pi 0.79.1');
    const adapter = new PiAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'pi-profile'),
    });

    await expect(adapter.prepareRun()).resolves.toBeUndefined();
  });

  it('reports a preflight diagnostic when the configured pi binary is missing', async () => {
    const adapter = new PiAdapter({
      binary: join(tmpdir(), 'missing-pi'),
      profileStateDir: join(tmpdir(), 'pi-profile'),
    });

    await expect(adapter.prepareRun()).rejects.toMatchObject({
      code: 'agent-binary-not-found',
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'pi',
        agentName: 'Pi',
      },
    });
  });
});

async function writePiBinary(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-prepare-run-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return writeVersionExecutable(dir, 'pi', version);
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run tests/unit/agent/pi-prepare-run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `PiAdapter`**

Create `src/agent/pi/adapter.ts`:

```ts
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { AccessMode } from '../../config/permissions';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildPiArgs } from './argv';
import { PiJsonlTranslator, type PiFinishReason } from './jsonl';

export interface PiAdapterOptions {
  binary: string;
  profileStateDir: string;
  piHome?: string;
  inheritPiHome?: boolean;
  accessMode?: AccessMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly piHome: string | undefined;
  private readonly inheritPiHome: boolean;
  private readonly accessMode: AccessMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: PiAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.piHome = opts.piHome;
    this.inheritPiHome = opts.inheritPiHome === true;
    this.accessMode = opts.accessMode ?? 'full';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'pi',
      agentName: 'Pi',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'pi binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for PiAdapter.run');
    }

    const args = buildPiArgs({
      accessMode: opts.accessMode ?? this.accessMode,
      sessionId: opts.sessionId,
      images: opts.images,
    });
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.piHome) {
      envOverrides.PI_CODING_AGENT_DIR = this.piHome;
    } else if (!this.inheritPiHome) {
      envOverrides.PI_CODING_AGENT_DIR = join(this.profileStateDir, 'pi-home');
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn pi: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: PiFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: PiChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => PiFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new PiJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn pi: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield terminalError(`pi runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield terminalError(`pi exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield terminalError(`pi runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

function terminalError(message: string): AgentEvent {
  return {
    type: 'error',
    message,
    terminationReason: 'failed',
  };
}

async function waitForExitCode(child: PiChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
```

- [ ] **Step 5: Run to verify the prepare-run test passes**

Run: `pnpm vitest run tests/unit/agent/pi-prepare-run.test.ts`
Expected: PASS

- [ ] **Step 6: Export `PiAdapter` from `src/agent/index.ts`**

Add:
```ts
export { PiAdapter } from './pi/adapter';
```

- [ ] **Step 7: Write the process-level test**

Create `tests/process/pi-adapter.test.ts`, mirroring `tests/process/codex-adapter.test.ts`'s `createFakeCodex`/`collect`/`readRecord` helpers (rename to `createFakePi`) but with pi's event shapes and env var:

```ts
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter.js';
import { buildPiArgs } from '../../src/agent/pi/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('PiAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldPiHome = process.env.PI_CODING_AGENT_DIR;

  afterEach(async () => {
    if (oldPiHome === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldPiHome;
    }
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh JSON run with prompt on stdin and uses a profile-scoped pi home by default', async () => {
    const fake = await createFakePi({
      lines: [
        { type: 'session', id: 'sess-fresh' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'hello user' },
        },
        { type: 'agent_end', messages: [] },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-fresh' },
      { type: 'text', delta: 'hello user' },
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildPiArgs({ accessMode: 'full' }));
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('hello from lark');
    expect(record.stdin).not.toBe('hello from lark');
    expect(record.env.PI_CODING_AGENT_DIR).toBe(join(fake.dir, 'pi-home'));
  });

  it('passes image paths and a resumed session id through the argv contract', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
    }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      sessionId: 'sess-old',
      images: [image],
    });

    expect(await collect(run.events)).toEqual([{ type: 'done', terminationReason: 'normal' }]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildPiArgs({ accessMode: 'full', sessionId: 'sess-old', images: [image] }),
    );
  });

  it('restricts tools for read-only access', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      accessMode: 'full',
    }).run({
      runId: 'run-readonly',
      prompt: 'look only',
      cwd,
      accessMode: 'read-only',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildPiArgs({ accessMode: 'read-only' }));
  });

  it('uses an explicit piHome verbatim, and honors inheritPiHome', async () => {
    const fake = await createFakePi({ lines: [{ type: 'agent_end', messages: [] }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const piHome = join(fake.dir, 'custom-pi-home');

    const explicit = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir, piHome }).run({
      runId: 'run-home',
      prompt: 'home',
      cwd,
    });
    await collect(explicit.events);
    expect((await readRecord(fake.recordPath)).env.PI_CODING_AGENT_DIR).toBe(piHome);

    const inherited = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritPiHome: true,
    }).run({ runId: 'run-inherit', prompt: 'home', cwd });
    await collect(inherited.events);
    expect((await readRecord(fake.recordPath)).env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakePi({
      lines: [
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before failure' } },
      ],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new PiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      { type: 'error', message: 'pi exited with code 42: boom', terminationReason: 'failed' },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    const missing = join(tmpdir(), `missing-pi-${Date.now()}`);
    const run = new PiAdapter({ binary: missing, profileStateDir: tmpdir() }).run({
      runId: 'run-missing',
      prompt: 'hi',
      cwd: tmpdir(),
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn pi|spawn returned no pid|pi exited with code/,
    );
  });

  it('reports interrupted termination when stopped before an agent_end event', async () => {
    const fake = await createFakePi({
      lines: [{ type: 'session', id: 'sess-stop' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = new PiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 20,
    }).run({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', sessionId: 'sess-stop' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new PiAdapter({ binary: 'unused', profileStateDir: tmpdir() }).run({
        runId: 'run-no-cwd',
        prompt: 'hi',
      }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakePi(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'));
  const path = join(dir, 'fake-pi.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(
  path: string,
): Promise<{ argv: string[]; cwd: string; stdin: string; env: { PI_CODING_AGENT_DIR?: string } }> {
  return JSON.parse(await readFile(path, 'utf8'));
}
```

- [ ] **Step 8: Run to verify the process test passes**

Run: `pnpm vitest run tests/process/pi-adapter.test.ts`
Expected: PASS. Debug any stdio-timing flakiness against `codex-adapter.test.ts`'s equivalent case, which this is modeled on line-for-line.

- [ ] **Step 9: Full unit+process suite and typecheck**

Run: `pnpm vitest run tests/unit tests/process && pnpm typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/agent/pi/adapter.ts src/agent/index.ts tests/unit/agent/pi-prepare-run.test.ts tests/process/pi-adapter.test.ts
git commit -m "feat: add PiAdapter"
```

---

## Phase 4 — Capability + shared helper

### Task 6: `piCapability` and a shared `capabilityForAgentKind` helper

The exploration turned up the exact same 3-line ternary (`agentKind === 'codex' ? codexCapability(profileConfig) : claudeCapability(profileConfig)`) copy-pasted in **five** places: `src/bot/channel.ts`, `src/bot/comments.ts`, `src/bot/session-catalog-identity.ts`, `src/commands/index.ts`, and the test harness in `tests/integration/commands/resume-command.test.ts`. Factor this into one helper now so adding pi means touching it once, not patching five sites (and risking a sixth, undiscovered copy) independently.

**Files:**
- Modify: `src/agent/capability.ts` (add `piCapability`, add `capabilityForAgentKind`, widen `AgentCapabilityId`/`AgentSessionKind`)
- Modify: `src/bot/channel.ts`, `src/bot/comments.ts`, `src/bot/session-catalog-identity.ts`, `src/commands/index.ts` (replace each ternary with a call to `capabilityForAgentKind`)
- Modify: `tests/integration/commands/resume-command.test.ts` (replace its own copy of the ternary too, so it can be parameterized with `'pi'`)
- Test: `tests/unit/agent/capability.test.ts` (create if it doesn't already exist — check first)

- [ ] **Step 1: Check for an existing capability test file**

Run: `find tests -iname "*capability*"`. If one exists, read it and extend it; if not, create `tests/unit/agent/capability.test.ts`.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { capabilityForAgentKind } from '../../../src/agent/capability.js';
import type { ProfileConfig } from '../../../src/config/profile-schema.js';

const basePermissions: ProfileConfig['permissions'] = {
  defaultAccess: 'full',
  maxAccess: 'full',
};

describe('capabilityForAgentKind', () => {
  it('returns the pi capability with native history and stdin-prefix injection', () => {
    const capability = capabilityForAgentKind('pi', { permissions: basePermissions });
    expect(capability.agentId).toBe('pi');
    expect(capability.sessionKind).toBe('pi-session');
    expect(capability.promptInjection).toBe('stdin-prefix');
    expect(capability.supportsNativeHistory).toBe(true);
  });

  it('still returns codex and claude capabilities unchanged', () => {
    expect(capabilityForAgentKind('codex', { permissions: basePermissions }).agentId).toBe('codex');
    expect(capabilityForAgentKind('claude', { permissions: basePermissions }).agentId).toBe('claude');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run tests/unit/agent/capability.test.ts`
Expected: FAIL — `capabilityForAgentKind` doesn't exist yet.

- [ ] **Step 4: Implement in `src/agent/capability.ts`**

Widen the unions:
```ts
export type AgentCapabilityId = 'claude' | 'codex' | 'pi';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'pi-session';
```

Add `piCapability` after `codexCapability`:
```ts
export function piCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'pi',
    sessionKind: 'pi-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}
```

Add a shared dispatcher at the bottom of the file:
```ts
import type { AgentKind } from '../config/profile-schema';

export function capabilityForAgentKind(
  agentKind: AgentKind,
  profile: Pick<ProfileConfig, 'permissions'>,
): AgentCapability {
  switch (agentKind) {
    case 'codex':
      return codexCapability(profile);
    case 'pi':
      return piCapability(profile);
    case 'claude':
      return claudeCapability(profile);
  }
}
```
(Add the `AgentKind` import at the top of the file alongside the existing `ProfileConfig` import — check it isn't already imported under a different name first.)

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run tests/unit/agent/capability.test.ts`
Expected: PASS

- [ ] **Step 6: Replace the four production call sites**

In each of `src/bot/channel.ts` (~line 804-806), `src/bot/comments.ts` (~line 184-187), `src/bot/session-catalog-identity.ts` (~line 24-27), `src/commands/index.ts` (~line 1119-1122):

Before (shape, exact variable names differ slightly per file — check each one):
```ts
const capability =
  someProfileConfig.agentKind === 'codex'
    ? codexCapability(someProfileConfig)
    : claudeCapability(someProfileConfig);
```
After:
```ts
const capability = capabilityForAgentKind(someProfileConfig.agentKind, someProfileConfig);
```
Update each file's imports: remove `claudeCapability, codexCapability` (if no longer used elsewhere in the same file — check first, `channel.ts` might use `claudeCapability` directly somewhere else too) and add `capabilityForAgentKind`.

- [ ] **Step 7: Replace the test-harness copy**

In `tests/integration/commands/resume-command.test.ts` around line 385, same transformation:
```ts
const capability = capabilityForAgentKind(agentKind, profileConfig);
```
Import `capabilityForAgentKind` from `'../../../src/agent/capability.js'`.

- [ ] **Step 8: Run the full unit + integration suite**

Run: `pnpm vitest run tests/unit tests/integration`
Expected: PASS — this step is a pure refactor, so every existing claude/codex-focused test must still pass unchanged. If anything fails, you missed an import or a subtly different local variable name at one of the four/five call sites — re-check each one individually rather than guessing.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/agent/capability.ts src/bot/channel.ts src/bot/comments.ts src/bot/session-catalog-identity.ts src/commands/index.ts tests/unit/agent/capability.test.ts tests/integration/commands/resume-command.test.ts
git commit -m "refactor: factor capabilityForAgentKind out of five duplicated ternaries, add piCapability"
```

---

## Phase 5 — Session catalog correctness (do this before wiring run-flow/comments, since both depend on it)

### Task 7: Fix `src/session/catalog.ts`'s binary claude-vs-everything-else invariant

This is the fix flagged by spec review as correctness-critical: `isValidAgentEntry`, `assertAgentIdentity`, and (found during plan research, **not** in the original spec) `normalizeEntry`'s disk-load filter all currently treat "not claude" as synonymous with "codex, therefore needs threadId." Once `pi` entries exist, this throws on every write and silently drops pi entries loaded from disk.

**Files:**
- Modify: `src/session/catalog.ts:217` (`normalizeEntry`), `:250` (`isValidAgentEntry`), `:255` (`assertAgentIdentity`)
- Test: find the existing test file for this module first (likely `tests/unit/session/catalog.test.ts` or similar — search for it)

- [ ] **Step 1: Find and read the existing catalog test file**

Run: `find tests -iname "*catalog*"`. Read whichever file(s) test `src/session/catalog.ts` to match existing style/fixture helpers.

- [ ] **Step 2: Write failing tests**

Add to that file (create `tests/unit/session/catalog.test.ts` if none covers this module yet — check first):

```ts
it('accepts a pi entry with sessionId and no threadId, same shape as claude', () => {
  const catalog = new SessionCatalog(/* construct per existing test conventions in this file */);
  expect(() =>
    catalog.upsertActive({
      scopeId: 'scope-1',
      agentId: 'pi',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
      sessionId: 'pi-sess-1',
    }),
  ).not.toThrow();
});

it('rejects a pi entry that supplies threadId instead of sessionId', () => {
  const catalog = new SessionCatalog(/* ... */);
  expect(() =>
    catalog.upsertActive({
      scopeId: 'scope-1',
      agentId: 'pi',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
      threadId: 'not-valid-for-pi',
    }),
  ).toThrow(/sessionId/);
});
```
(Adapt constructor/setup calls to match whatever pattern the existing test file in this module already uses — read it first, don't guess a `SessionCatalog` constructor signature.)

Also add a persistence round-trip test if the existing file has one for claude/codex (load a raw JSON blob with `agentId: 'pi'` through whatever `load()`/`normalizeEntry`-exercising path the existing tests use, and assert the entry survives rather than being silently dropped).

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run tests/unit/session/catalog.test.ts` (or wherever the file lives)
Expected: FAIL — pi entries currently throw `'Codex catalog entries require threadId and must not include sessionId'`.

- [ ] **Step 4: Fix the three sites**

In `src/session/catalog.ts`:

Line ~217 (`normalizeEntry`), change:
```ts
(raw.agentId !== 'claude' && raw.agentId !== 'codex') &&
```
to:
```ts
(raw.agentId !== 'claude' && raw.agentId !== 'codex' && raw.agentId !== 'pi') &&
```
(adjust exact surrounding boolean structure to match what's actually there — the grep showed this line as part of a larger `||`/`&&` condition; read the surrounding 5 lines before editing to get parens right.)

Line ~250 (`isValidAgentEntry`), change:
```ts
function isValidAgentEntry(entry: SessionCatalogEntry): boolean {
  if (entry.agentId === 'claude') return Boolean(entry.sessionId) && !entry.threadId;
  return Boolean(entry.threadId) && !entry.sessionId;
}
```
to:
```ts
function isValidAgentEntry(entry: SessionCatalogEntry): boolean {
  if (entry.agentId === 'claude' || entry.agentId === 'pi') {
    return Boolean(entry.sessionId) && !entry.threadId;
  }
  return Boolean(entry.threadId) && !entry.sessionId;
}
```

Line ~255 (`assertAgentIdentity`), change:
```ts
function assertAgentIdentity(input: UpsertSessionCatalogInput): void {
  if (input.agentId === 'claude') {
    if (!input.sessionId || input.threadId) {
      throw new Error('Claude catalog entries require sessionId and must not include threadId');
    }
    return;
  }
  if (!input.threadId || input.sessionId) {
    throw new Error('Codex catalog entries require threadId and must not include sessionId');
  }
}
```
to:
```ts
function assertAgentIdentity(input: UpsertSessionCatalogInput): void {
  if (input.agentId === 'claude' || input.agentId === 'pi') {
    if (!input.sessionId || input.threadId) {
      throw new Error(
        `${input.agentId === 'pi' ? 'Pi' : 'Claude'} catalog entries require sessionId and must not include threadId`,
      );
    }
    return;
  }
  if (!input.threadId || input.sessionId) {
    throw new Error('Codex catalog entries require threadId and must not include sessionId');
  }
}
```

- [ ] **Step 5: Run to verify tests pass**

Run: `pnpm vitest run tests/unit/session/catalog.test.ts` (adjust path)
Expected: PASS. Also re-run the full existing test file for this module to confirm the claude/codex cases still pass unchanged.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/session/catalog.ts tests/unit/session/catalog.test.ts
git commit -m "fix: treat pi session-catalog entries like claude (sessionId, no threadId)"
```

---

## Phase 6 — Wire pi into the bot run flows

### Task 8: `src/bot/run-flow.ts` — images, resume-read, and the write-side `recordRunSessionEvent` bug

**Files:**
- Modify: `src/bot/run-flow.ts:151-157` (images), `:116-138` (resume read), `:189-212` (`recordRunSessionEvent` write)
- Test: find the existing run-flow test file (search `tests/` for `run-flow`)

- [ ] **Step 1: Find and read the existing run-flow test(s)**

Run: `find tests -iname "*run-flow*"`. Read to understand the harness/mocking pattern for `submitAgentRun`/`recordRunSessionEvent` before writing new cases.

- [ ] **Step 2: Write failing tests for the write-side bug specifically**

This is the most important gap: today, `recordRunSessionEvent` hardcodes `agentId: 'claude'` literally (not `input.capability.agentId`) inside the claude-only branch — harmless while only claude uses that branch, but a live bug once pi shares it. Add (matching whatever harness the existing file uses to construct `RecordRunSessionEventInput`/a fake `sessionCatalog`):

```ts
it('records a pi session event in the catalog tagged as pi, not claude', () => {
  const catalog = /* fake/spy sessionCatalog matching existing test conventions */;
  recordRunSessionEvent({
    capability: piCapability(testProfileConfig), // import from '../../../src/agent/capability.js'
    event: { type: 'system', sessionId: 'pi-sess-9', cwd: '/repo' },
    policy: { cwdRealpath: '/repo', policyFingerprint: 'fp' } as any, // match existing fixture shape
    scopeId: 'scope-9',
    sessions: fakeSessionStore, // matching existing conventions
    sessionCatalog: catalog,
  });
  expect(catalog.upsertActive).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: 'pi', sessionId: 'pi-sess-9' }),
  );
});
```
(Adapt to the file's actual test-double style — this may use a real `SessionCatalog` instance rather than a spy; read the existing claude test case for `recordRunSessionEvent` in this file first and copy its exact construction pattern, just swapping `claudeCapability` for `piCapability` and asserting `agentId: 'pi'` instead of `'claude'`.)

Also add an images-condition test:
```ts
it('includes accepted image attachments for a pi capability, same as codex', async () => {
  // exercise submitAgentRun (or whatever the exported entry point is) with
  // capability: piCapability(...), an accepted image attachment in policy.attachments,
  // and assert executor.submit was called with images: [thatPath].
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run <the run-flow test file>`
Expected: FAIL on the new `recordRunSessionEvent` test (pi falls through both `if` branches today and writes nothing) and the images test (pi isn't in the images condition).

- [ ] **Step 4: Fix `run-flow.ts`**

Images condition (line ~151-157), change:
```ts
images:
  input.capability.agentId === 'codex'
    ? policy.attachments
        .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
        .map((attachment) => attachment.path)
        .filter((path): path is string => Boolean(path))
    : undefined,
```
to:
```ts
images:
  input.capability.agentId === 'codex' || input.capability.agentId === 'pi'
    ? policy.attachments
        .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
        .map((attachment) => attachment.path)
        .filter((path): path is string => Boolean(path))
    : undefined,
```

Resume-read branch (line ~123-138), change:
```ts
if (catalogEntry?.agentId === 'claude') {
  sessionId = catalogEntry.sessionId;
  resumeFrom = sessionId;
} else if (catalogEntry?.agentId === 'codex') {
  threadId = catalogEntry.threadId;
  resumeFrom = threadId;
}
```
```ts
if (!resumeFrom && input.capability.agentId === 'claude') {
```
to:
```ts
if (catalogEntry?.agentId === 'claude' || catalogEntry?.agentId === 'pi') {
  sessionId = catalogEntry.sessionId;
  resumeFrom = sessionId;
} else if (catalogEntry?.agentId === 'codex') {
  threadId = catalogEntry.threadId;
  resumeFrom = threadId;
}
```
```ts
if (!resumeFrom && (input.capability.agentId === 'claude' || input.capability.agentId === 'pi')) {
```

`recordRunSessionEvent` write side (line ~189-202), change:
```ts
if (input.capability.agentId === 'claude' && input.event.sessionId) {
  const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
  input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
  input.sessionCatalog?.upsertActive({
    scopeId: input.scopeId,
    agentId: 'claude',
    cwdRealpath,
    policyFingerprint: input.policy.policyFingerprint,
    sessionId: input.event.sessionId,
  });
  return;
}
```
to:
```ts
if (
  (input.capability.agentId === 'claude' || input.capability.agentId === 'pi') &&
  input.event.sessionId
) {
  const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
  input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
  input.sessionCatalog?.upsertActive({
    scopeId: input.scopeId,
    agentId: input.capability.agentId,
    cwdRealpath,
    policyFingerprint: input.policy.policyFingerprint,
    sessionId: input.event.sessionId,
  });
  return;
}
```
(Note: `agentId: input.capability.agentId` replaces the hardcoded literal `'claude'` — this is the actual bug fix; `input.capability.agentId` is statically known to be `'claude' | 'pi'` at this point since it just passed the `if` check, so this type-checks cleanly against `assertAgentIdentity`'s now-widened acceptance.)

- [ ] **Step 5: Run to verify tests pass**

Run: `pnpm vitest run <the run-flow test file>`
Expected: PASS. Re-run the full file to confirm claude/codex cases are unaffected.

- [ ] **Step 6: Typecheck + full unit suite**

Run: `pnpm typecheck && pnpm vitest run tests/unit`

- [ ] **Step 7: Commit**

```bash
git add src/bot/run-flow.ts tests/
git commit -m "fix: wire pi through run-flow images/resume/session-catalog-write, fixing a hardcoded agentId bug"
```

---

### Task 9: `src/bot/comments.ts` — mirror the same three read-side branches

**Files:**
- Modify: `src/bot/comments.ts:240-245` (resume-eligibility/threadId split), `:326-328` (`system` event sessionId capture)
- Test: find the existing comments test file(s) (`tests/integration/comments/*.test.ts`)

Note: the capability-construction ternary at comments.ts:184-187 was already replaced with `capabilityForAgentKind` in Task 6 — skip it here.

- [ ] **Step 1: Read the existing comment-flow tests**

Read `tests/integration/comments/claude-comments.test.ts` and `tests/integration/comments/comment-run-flow.test.ts` to find the harness pattern (likely similar to `resume-command.test.ts`'s `createHarness`).

- [ ] **Step 2: Write a failing pi comment-resume test**

Add a test (in a new `tests/integration/comments/pi-comments.test.ts`, modeled directly on `claude-comments.test.ts` with `agentKind: 'pi'` substituted throughout) asserting: a comment run with a prior pi session in the catalog resumes it (i.e. `sessionId` gets threaded through to the simulated agent run), and a fresh comment run's `system` event with a `sessionId` gets captured into the legacy `sessions` store.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run tests/integration/comments/pi-comments.test.ts`
Expected: FAIL — pi doesn't resume today (falls into neither the `capability.agentId === 'claude'` sessionId branch nor is treated as codex-with-threadId, so `sessionId`/`threadId` both end up `undefined`).

- [ ] **Step 4: Fix `src/bot/comments.ts`**

Line ~240-244, change:
```ts
const sessionId =
  canResumeAgentSession && capability.agentId === 'claude'
    ? sessions.resumeFor(docSessionScopeId, cwdRealpath) ??
      sessions.resumeFor(legacyDocSessionScopeId, cwdRealpath)
    : undefined;
```
to:
```ts
const sessionId =
  canResumeAgentSession && (capability.agentId === 'claude' || capability.agentId === 'pi')
    ? sessions.resumeFor(docSessionScopeId, cwdRealpath) ??
      sessions.resumeFor(legacyDocSessionScopeId, cwdRealpath)
    : undefined;
```
(Line 245's `const threadId = capability.agentId === 'codex' ? ... : undefined;` stays unchanged — pi has no threadId concept.)

Line ~326-328, change:
```ts
if (capability.agentId === 'claude' && e.type === 'system' && e.sessionId) {
  sessions.set(docSessionScopeId, e.sessionId, policy.cwdRealpath);
}
```
to:
```ts
if (
  (capability.agentId === 'claude' || capability.agentId === 'pi') &&
  e.type === 'system' &&
  e.sessionId
) {
  sessions.set(docSessionScopeId, e.sessionId, policy.cwdRealpath);
}
```

- [ ] **Step 5: Run to verify tests pass**

Run: `pnpm vitest run tests/integration/comments/pi-comments.test.ts tests/integration/comments/`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/bot/comments.ts tests/integration/comments/pi-comments.test.ts
git commit -m "fix: resume pi sessions in the cloud-doc comments flow like claude"
```

---

### Task 10: `src/commands/index.ts` — remaining sites

This file has the most scattered touch points. Handle them one at a time; some need real 3-way branches, some are intentional no-ops (pi falls through an existing "not codex" path correctly already) — don't blanket-edit every `agentKind`/`agentId` occurrence.

**Files:**
- Modify: `src/commands/index.ts` at lines ~149-155 (`ResumeCandidate` type), ~607-620 (`upsertActive` hardcoded agentId bug — same bug class as run-flow.ts), ~638 (session-set-on-resume), ~691-692 (resume candidate filter), ~751-767 (`runtimeAccessStatus`), ~804-820 (`handleStatus`'s `isCodex` flag)
- Sites that are correctly **no-ops** (verify, don't change): ~549 and ~645 (codex-only resume-history-card guard, where pi correctly falls through the existing non-codex/claude-shaped path)
- Test: whatever integration test currently exercises `/resume`, `/status` for codex (likely `tests/integration/commands/resume-command.test.ts`, `tests/integration/commands/profile-config-command.test.ts`, or a dedicated status-command test — search first)

- [ ] **Step 1: Widen the local `ResumeCandidate` type**

Line ~150-155, change:
```ts
interface ResumeCandidate {
  scopeId: string;
  agentId: 'claude' | 'codex';
  ...
}
```
to:
```ts
interface ResumeCandidate {
  scopeId: string;
  agentId: 'claude' | 'codex' | 'pi';
  ...
}
```
(Consider importing `AgentCapabilityId` from `../agent/capability` instead of redeclaring the union locally, if that doesn't create a circular import — check first; if it's simpler to leave the local union, just keep it in sync.)

- [ ] **Step 2: Write a failing test for the `upsertActive` hardcoded-agentId bug**

Around line 607-620, `if (ctx.sessionCatalogIdentity.agentId === 'codex') { ...agentId: 'codex'... } else { ...agentId: 'claude'... }` — the `else` branch hardcodes `'claude'` regardless of actual identity, same bug class as the one fixed in Task 8. Find/extend the test file covering this handler (likely the `/resume` or `/new` command handler — search for what calls this code path) and add a pi case asserting `sessionCatalog.upsertActive` is called with `agentId: 'pi'`, not `'claude'`.

- [ ] **Step 3: Run to verify failure**

Expected: FAIL — a pi identity currently gets recorded as `'claude'`.

- [ ] **Step 4: Fix the hardcoded branch**

Change:
```ts
if (ctx.sessionCatalogIdentity.agentId === 'codex') {
  ctx.sessionCatalog.upsertActive({
    ...
    agentId: 'codex',
    ...
  });
} else {
  ctx.sessionCatalog.upsertActive({
    ...
    agentId: 'claude',
    ...
  });
}
```
to:
```ts
if (ctx.sessionCatalogIdentity.agentId === 'codex') {
  ctx.sessionCatalog.upsertActive({
    ...
    agentId: 'codex',
    ...
  });
} else {
  ctx.sessionCatalog.upsertActive({
    ...
    agentId: ctx.sessionCatalogIdentity.agentId,
    ...
  });
}
```
(Preserve whatever the `...` fields are exactly — only change the `agentId:` value from the literal `'claude'` to the actual identity.)

- [ ] **Step 5: Fix the session-set-on-resume check (line ~638)**

Change:
```ts
if (ctx.sessionCatalogIdentity.agentId === 'claude') {
  ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
}
```
to:
```ts
if (
  ctx.sessionCatalogIdentity.agentId === 'claude' ||
  ctx.sessionCatalogIdentity.agentId === 'pi'
) {
  ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
}
```

- [ ] **Step 6: Fix the resume-candidate filter (line ~691-692)**

Change:
```ts
(identity.agentId === 'claude' && !candidate.sessionId) ||
(identity.agentId === 'codex' && !candidate.threadId)
```
to:
```ts
((identity.agentId === 'claude' || identity.agentId === 'pi') && !candidate.sessionId) ||
(identity.agentId === 'codex' && !candidate.threadId)
```

- [ ] **Step 7: Fix `runtimeAccessStatus` (line ~751-767)**

Read the full function first (lines ~748-768) to get exact surrounding code — the excerpt found during research was:
```ts
if (profileConfig.agentKind === 'claude') {
  return { label: 'permission', value: accessToClaudePermissionMode(...) };
}
return { label: 'sandbox', value: `${profileConfig.sandbox.defaultMode}/${profileConfig.sandbox.maxMode}` };
```
Change to a real 3-way switch — pi has neither Claude's permission-mode concept nor Codex's sandbox-mode concept, it uses the bridge's own `AccessMode` directly:
```ts
if (profileConfig.agentKind === 'claude') {
  return { label: 'permission', value: accessToClaudePermissionMode(...) };
}
if (profileConfig.agentKind === 'pi') {
  return { label: 'access', value: profileConfig.permissions.defaultAccess };
}
return { label: 'sandbox', value: `${profileConfig.sandbox.defaultMode}/${profileConfig.sandbox.maxMode}` };
```

- [ ] **Step 8: Fix `handleStatus`'s codex/claude split (line ~804-820)**

Read lines 795-825 in full first. The pattern found was `const isCodex = ctx.controls.profileConfig.agentKind === 'codex';` reused at multiple following lines to pick `sessionId: isCodex ? catalogEntry?.threadId : sess?.sessionId` and similar. Since this boolean already means "does this agent use threadId instead of sessionId" (true only for codex; false for both claude and pi), **no rename or pi-specific branch is needed** — `isCodex` is already correctly `false` for a pi profile, and every line gated on it already falls into the claude-shaped `sessionId`-based path. Read the surrounding ~20 lines carefully and confirm this — if you find a label string like `'thread'` vs `'session'` also gated on `isCodex`, that's fine too (pi should display as `'session'`, same as claude). **Do not change this site** unless your read of the actual code shows something the earlier research pass missed; if so, note the discrepancy in your task-completion notes.

- [ ] **Step 9: Verify the two no-op sites**

Read lines ~545-595 and ~640-650 in full. Confirm: the `if (agentKind === 'codex') { ...codex-thread-shaped resume listing... }` guard at ~549 and the `if (agentKind === 'codex') { ...'no resumable codex thread'... return; }` guard at ~645 both correctly let a `pi` profile fall through to the existing claude-shaped `else`/continuation path below them. Do not add a third branch at either site — just confirm by reading, and add a short comment if the fallthrough behavior isn't obvious from context (e.g. `// pi falls through here too: pi uses sessionId/native history like claude, not a codex thread`).

- [ ] **Step 10: Run tests, typecheck**

Run: `pnpm vitest run tests/unit tests/integration && pnpm typecheck`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/commands/index.ts tests/
git commit -m "fix: wire pi through commands/index.ts resume/status/access-display, fixing a second hardcoded agentId bug"
```

---

## Phase 7 — Model list

### Task 11: `src/agent/models.ts` — `PI_MODELS` and a real 3-way `supportedModels`

**Files:**
- Modify: `src/agent/models.ts` (add `PI_MODELS`, change `supportedModels`)
- Modify: `tests/unit/agent/models.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/unit/agent/models.test.ts`:
```ts
it('offers pi only the default-model sentinel, since pi spans multiple providers', () => {
  const pi = supportedModels('pi');
  expect(pi).toEqual([{ value: DEFAULT_MODEL, label: '跟随默认（不指定）' }]);
});

it('coerces any non-default pi selection back to default', () => {
  expect(normalizeModelSelection('pi', 'gpt-5')).toBe(DEFAULT_MODEL);
  expect(resolveModelArg('pi', 'anthropic/claude-sonnet-4-5')).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/agent/models.test.ts`
Expected: FAIL — `supportedModels('pi')` currently returns `CLAUDE_MODELS` (the binary ternary's else-branch default).

- [ ] **Step 3: Implement**

In `src/agent/models.ts`, add after `CODEX_MODELS`:
```ts
/** Pi spans multiple providers/models via --provider/--model; not curated yet. */
const PI_MODELS: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随默认（不指定）' }];
```
Change:
```ts
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  return agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}
```
to:
```ts
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  switch (agentKind) {
    case 'codex':
      return CODEX_MODELS;
    case 'pi':
      return PI_MODELS;
    case 'claude':
      return CLAUDE_MODELS;
  }
}
```

- [ ] **Step 4: Run to verify tests pass**

Run: `pnpm vitest run tests/unit/agent/models.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/models.ts tests/unit/agent/models.test.ts
git commit -m "feat: add PI_MODELS (default-only) to the model catalog"
```

---

## Phase 8 — CLI, bootstrap, binary resolution, profile store

### Task 12: `src/config/profile-store.ts` — persist `pi` config, parse `--agent pi`

**Files:**
- Modify: `src/config/profile-store.ts:48-62` (`StoredProfileConfig`, a `Pick<ProfileConfig, ...>` union of field-name keys, not a plain string union — it currently picks `'schemaVersion' | 'agentKind' | 'accounts' | 'secrets' | 'preferences' | 'access' | 'workspaces' | 'permissions' | 'codex' | 'attachments' | 'comments' | 'larkCli'`), `:85-96` (`serializeProfileConfig`, where line 95 is `...(profile.codex ? { codex: profile.codex } : {}),`), `:294-298` (`agentKindFromString`)
- Test: find/extend the existing profile-store test file

- [ ] **Step 1: Read the existing profile-store test file, write a failing test for `agentKindFromString('pi')`**

```ts
it('parses pi as a valid --agent value', () => {
  expect(agentKindFromString('pi')).toBe('pi');
});

it('still rejects unsupported agent strings', () => {
  expect(() => agentKindFromString('bogus')).toThrow(/unsupported agent: bogus/);
});
```
Also add a serialize/round-trip test asserting a profile with `pi: { binaryPath: '...' }` survives `serializeProfileConfig` (mirroring whatever existing codex round-trip test is there).

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — `agentKindFromString('pi')` throws today.

- [ ] **Step 3: Fix**

`StoredProfileConfig` (the `Pick<ProfileConfig, ...>` field list at lines 48-62), add `| 'pi'` next to `| 'codex'` in that key union — this is picking a **property name** off `ProfileConfig` (which already has an optional `pi?: PiConfig` field once Task 1 lands), not adding a new literal type.

`serializeProfileConfig` (line 95), add `...(profile.pi ? { pi: profile.pi } : {}),` next to the existing `...(profile.codex ? { codex: profile.codex } : {}),`.

`agentKindFromString` (line ~294-298), change:
```ts
export function agentKindFromString(value: string | undefined): AgentKind | undefined {
  if (value === 'claude' || value === 'codex') return value;
  if (value === undefined) return undefined;
  throw new Error(`unsupported agent: ${value}`);
}
```
to:
```ts
export function agentKindFromString(value: string | undefined): AgentKind | undefined {
  if (value === 'claude' || value === 'codex' || value === 'pi') return value;
  if (value === undefined) return undefined;
  throw new Error(`unsupported agent: ${value}`);
}
```

- [ ] **Step 4: Run to verify tests pass, typecheck**

Run: `pnpm vitest run <profile-store test file> && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/config/profile-store.ts tests/
git commit -m "feat: persist pi profile config and accept --agent pi"
```

---

### Task 13: `src/cli/profile-bootstrap.ts` — `createBootstrapPiConfig`

**Files:**
- Modify: `src/cli/profile-bootstrap.ts` (add `piBinaryPath?` to `BootstrapProfileInput`, add `pi` block in `createBootstrapProfileConfig`, add `createBootstrapPiConfig`, add `pi-home` mkdir)
- Test: `tests/integration/cli/first-run-profile.test.ts` (extend, following the existing `agentKind: 'codex'` bootstrap test)

- [ ] **Step 1: Read `tests/integration/cli/first-run-profile.test.ts`'s codex bootstrap test in full** (lines ~21-91 per earlier research) to match its exact assertions style.

- [ ] **Step 2: Write a failing pi bootstrap test**

Mirror the codex test, asserting: `createBootstrapProfileConfig({ agentKind: 'pi', ..., piBinaryPath: <fake binary path> })` resolves, `profile.pi.binaryPath` is the resolved absolute path, `profile.pi.realpath`/`version`/`sha256` stay `undefined` (matching what the function actually populates, confirmed in this same phase for Codex), and — new case not present for codex — `profile.pi.inheritPiHome` is `false` and (if `profileDir` is passed) a `pi-home` directory gets created under it.

- [ ] **Step 3: Run to verify failure**

Expected: FAIL — `BootstrapProfileInput` has no `piBinaryPath` field, `agentKind: 'pi'` bootstrap produces no `pi` config.

- [ ] **Step 4: Implement**

Add `piBinaryPath?: string;` to `BootstrapProfileInput` (next to `codexBinaryPath?: string;`).

In `createBootstrapProfileConfig`, add after the existing `codex` block:
```ts
const pi =
  input.agentKind === 'pi'
    ? await createBootstrapPiConfig(input.piBinaryPath)
    : undefined;
```
Add `...(pi ? { pi } : {}),` to the `createDefaultProfileConfig({...})` call, next to `...(codex ? { codex } : {}),`.

After the existing codex-home mkdir block, add:
```ts
if (input.profileDir && profile.pi?.inheritPiHome === false) {
  await mkdir(join(input.profileDir, 'pi-home'), { recursive: true });
}
```

Add `createBootstrapPiConfig`, mirroring `createBootstrapCodexConfig` exactly (same shape confirmed during plan research — only resolves+records `binaryPath`, nothing else):
```ts
export async function createBootstrapPiConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_PI_BIN ?? 'pi';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: 'pi',
      agentName: 'Pi',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}
```
(Reuses `codexBootstrapBinaryErrorCode` as-is — it's already generic errno-mapping logic despite the name; consider renaming it to `agentBootstrapBinaryErrorCode` since it's now used by two agents, but that's optional cleanup, not required.)

- [ ] **Step 5: Run to verify tests pass**

Run: `pnpm vitest run tests/integration/cli/first-run-profile.test.ts`

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/cli/profile-bootstrap.ts tests/integration/cli/first-run-profile.test.ts
git commit -m "feat: bootstrap pi profiles (binary resolution, profile-scoped pi-home)"
```

---

### Task 14: `src/cli/commands/start.ts` — `createRuntimeAgent` pi branch + fix the `checkRuntimeAgentAvailability` ternary

**Files:**
- Modify: `src/cli/commands/start.ts` — read lines 1-30 (imports) and the full `createRuntimeAgent`/`checkRuntimeAgentAvailability` functions before editing (earlier research read this file in fragments and one previously-noted "second ternary site" turned out to be an unrelated shutdown-handler line that merely mentions `'codex'`/`'claude'` in a different context — re-verify by reading the whole file section, don't assume there are two sites until you've confirmed it yourself)
- Test: whatever test covers `createRuntimeAgent`/`checkRuntimeAgentAvailability` (search `tests/unit/cli/start-agent-factory.test.ts` — this name came up in the earlier file listing)

- [ ] **Step 1: Read `tests/unit/cli/start-agent-factory.test.ts` in full**

This is almost certainly the test file exercising `createRuntimeAgent`. Read it to see how it constructs a fake `ProfileConfig` for claude/codex and asserts the returned adapter type/options.

- [ ] **Step 2: Read `src/cli/commands/start.ts`'s full `createRuntimeAgent` and `checkRuntimeAgentAvailability` functions**

You need the complete, un-truncated `createRuntimeAgent` function (the earlier research pass got cut off mid-function at the codex branch's closing brace) and the one real `agent.id === 'codex' ? 'codex' : 'claude'` ternary site inside `checkRuntimeAgentAvailability`, with full surrounding context. (A prior research pass over-counted this as two sites; confirm the actual count yourself before editing — fix every real occurrence you find, whether that's one or more.)

- [ ] **Step 3: Write failing tests**

In `tests/unit/cli/start-agent-factory.test.ts`, add a case mirroring the existing codex case: construct a `ProfileConfig` with `agentKind: 'pi'` and `pi: { binaryPath: '/usr/local/bin/pi', inheritPiHome: false }`, call `createRuntimeAgent(profileConfig, appPaths)`, assert the result is a `PiAdapter` instance (or has `.id === 'pi'`). Also add a case for `createRuntimeAgent` throwing when `agentKind === 'pi'` but `profileConfig.pi?.binaryPath` is missing (mirroring the existing `'codex profile requires codex.binaryPath'` throw test, if one exists).

For `checkRuntimeAgentAvailability`, add a test constructing a fake `AgentAdapter` with `id: 'pi'`, no `checkAvailability` method, and `isAvailable()` resolving `false`; assert the returned diagnostic has `agentId: 'pi'`, `agentName` equal to the adapter's `displayName`, and `command: 'pi'` — NOT `'claude'` (today's bug: any non-codex `agent.id` gets mislabeled as claude).

- [ ] **Step 4: Run to verify failure**

Expected: FAIL both on `createRuntimeAgent` (no pi branch exists → likely falls through to claude branch and either throws or misconstructs) and on `checkRuntimeAgentAvailability` (reports `agentId: 'claude'` for a pi adapter).

- [ ] **Step 5: Fix `createRuntimeAgent`**

Add an `else if (profileConfig.agentKind === 'pi')` branch parallel to the codex one, before the final claude fallback:
```ts
if (profileConfig.agentKind === 'codex') {
  const codex = profileConfig.codex;
  if (!codex?.binaryPath) {
    throw new Error('codex profile requires codex.binaryPath');
  }
  return new CodexAdapter({
    binary: codex.binaryPath,
    profileStateDir: appPaths.profileDir,
    ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
    inheritCodexHome: codex.inheritCodexHome === true,
  });
} else if (profileConfig.agentKind === 'pi') {
  const pi = profileConfig.pi;
  if (!pi?.binaryPath) {
    throw new Error('pi profile requires pi.binaryPath');
  }
  return new PiAdapter({
    binary: pi.binaryPath,
    profileStateDir: appPaths.profileDir,
    ...(pi.piHome ? { piHome: pi.piHome } : {}),
    inheritPiHome: pi.inheritPiHome === true,
  });
}
```
(Fit this into the actual surrounding structure you read in Step 2 — the function likely ends with a claude-adapter return after these branches; preserve that.) Add `import { PiAdapter } from '../../agent/pi/adapter';` at the top of the file next to the existing `ClaudeAdapter`/`CodexAdapter` imports.

- [ ] **Step 6: Fix the `checkRuntimeAgentAvailability` ternary**

At its one real site, change:
```ts
agentId: agent.id === 'codex' ? 'codex' as const : 'claude' as const,
...
command: agent.id === 'codex' ? 'codex' : 'claude',
```
to a real switch, e.g.:
```ts
agentId: agent.id as LocalAgentId,
...
command: agent.id,
```
(`AgentAdapter.id` is typed as `string` in `src/agent/types.ts`, so check whether `LocalAgentId` needs an explicit cast or whether narrowing via a small helper is cleaner — since `agent.id` for a real adapter is always one of `'claude' | 'codex' | 'pi'` in practice but the type is just `string`, prefer an explicit runtime check over a blind cast:
```ts
function knownAgentId(id: string): LocalAgentId {
  if (id === 'codex' || id === 'pi') return id;
  return 'claude';
}
```
and use `knownAgentId(agent.id)` at the ternary's call site (and any others you find during Step 2's read that this plan's earlier research miscounted), `agentName: agent.displayName` stays as-is, `command: knownAgentId(agent.id)` — this preserves today's "unknown → claude" fallback behavior for anything genuinely unrecognized, while correctly routing `'pi'` instead of collapsing it into `'claude'`.)

- [ ] **Step 7: Run to verify tests pass**

Run: `pnpm vitest run tests/unit/cli/start-agent-factory.test.ts`

- [ ] **Step 8: Full unit suite + typecheck**

Run: `pnpm vitest run tests/unit && pnpm typecheck`

- [ ] **Step 9: Commit**

```bash
git add src/cli/commands/start.ts tests/unit/cli/start-agent-factory.test.ts
git commit -m "feat: construct PiAdapter in createRuntimeAgent, fix agentId misreporting for non-codex adapters"
```

---

### Task 15: `src/cli/commands/service.ts` — `agentDisplay` 3-way

**Files:**
- Modify: `src/cli/commands/service.ts:471-475`
- Test: `tests/unit/cli/service-profile.test.ts` (found earlier)

- [ ] **Step 1: Read `tests/unit/cli/service-profile.test.ts`, write a failing test**

Add a case asserting `agentDisplay('pi')` returns `{ id: 'pi', displayName: 'Pi' }` (match whatever `displayName` capitalization convention the codebase already uses elsewhere for pi — check `PiAdapter.displayName` from Task 5, keep them consistent).

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — `agentDisplay('pi')` currently returns the claude fallback (`{ id: 'claude', displayName: 'Claude Code' }`).

- [ ] **Step 3: Fix**

```ts
function agentDisplay(agentKind: ProcessEntry['agentKind']): { id: string; displayName: string } {
  return agentKind === 'codex'
    ? { id: 'codex', displayName: 'Codex CLI' }
    : { id: 'claude', displayName: 'Claude Code' };
}
```
to:
```ts
function agentDisplay(agentKind: ProcessEntry['agentKind']): { id: string; displayName: string } {
  if (agentKind === 'codex') return { id: 'codex', displayName: 'Codex CLI' };
  if (agentKind === 'pi') return { id: 'pi', displayName: 'Pi' };
  return { id: 'claude', displayName: 'Claude Code' };
}
```

- [ ] **Step 4: Run to verify tests pass, typecheck**

Run: `pnpm vitest run tests/unit/cli/service-profile.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/service.ts tests/unit/cli/service-profile.test.ts
git commit -m "feat: display pi processes correctly in service commands"
```

---

### Task 16: `src/cli/commands/migrate.ts` and `src/config/migrate-v2.ts`

**Files:**
- Modify: `src/cli/commands/migrate.ts:53-55`
- Modify: `src/config/migrate-v2.ts:23-30` (`MigrateV2Options.pi?`), `:131` (merge), `:203` (`activeProcessFromRegistryEntry`)
- Test: whatever covers `migrateV1ToV2` (search `tests/` for `migrate-v2`)

- [ ] **Step 1: Read `src/cli/commands/migrate.ts` and `src/config/migrate-v2.ts` in full, and their existing test file**

- [ ] **Step 2: Write failing tests**

Add a `migrateV1ToV2` test asserting: given `agentKind: 'pi'` and `opts.pi = { binaryPath: '/x/pi' }`, the migrated v2 config includes `pi: { binaryPath: '/x/pi' }`. Add an `activeProcessFromRegistryEntry` (or wherever line ~203 lives) test asserting an entry with `agentKind: 'pi'` keeps that value rather than losing it.

- [ ] **Step 3: Run to verify failure**

- [ ] **Step 4: Fix `src/config/migrate-v2.ts`**

Add `pi?: PiConfig;` to `MigrateV2Options` (import `PiConfig` from `../config/profile-schema` alongside the existing `CodexConfig` import).

Line ~131, change:
```ts
...(agentKind === 'codex' && opts.codex ? { codex: opts.codex } : {}),
```
to also include, right after it:
```ts
...(agentKind === 'pi' && opts.pi ? { pi: opts.pi } : {}),
```

Line ~203, change:
```ts
if (entry.agentKind === 'claude' || entry.agentKind === 'codex') active.agentKind = entry.agentKind;
```
to:
```ts
if (entry.agentKind === 'claude' || entry.agentKind === 'codex' || entry.agentKind === 'pi') {
  active.agentKind = entry.agentKind;
}
```

- [ ] **Step 5: Fix `src/cli/commands/migrate.ts`**

Line ~53-55, change:
```ts
...(needsV2Migration && agentKind === 'codex'
  ? { codex: await createBootstrapCodexConfig(undefined) }
  : {}),
```
to also include:
```ts
...(needsV2Migration && agentKind === 'codex'
  ? { codex: await createBootstrapCodexConfig(undefined) }
  : {}),
...(needsV2Migration && agentKind === 'pi'
  ? { pi: await createBootstrapPiConfig(undefined) }
  : {}),
```
Import `createBootstrapPiConfig` from `../profile-bootstrap` alongside the existing `createBootstrapCodexConfig` import.

Leave line ~46's `opts.profile === 'codex' ? 'codex' : undefined` profile-name-sniffing heuristic untouched — this is a legacy convenience default for old profiles literally named `codex` and doesn't need a pi equivalent (a profile can't have pre-existing legacy pi state, since pi didn't exist before this feature).

- [ ] **Step 6: Run to verify tests pass, typecheck**

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/migrate.ts src/config/migrate-v2.ts tests/
git commit -m "feat: carry pi config through v1-to-v2 migration and process registry"
```

---

### Task 17: `src/runtime/profile-runtime.ts` — `displayAgentKind`, `createRuntimeProfileConfig`, ambiguous-selection error text

**Files:**
- Modify: `src/runtime/profile-runtime.ts:615-617` (`displayAgentKind`), `~90` (`createRuntimeProfileConfig` codex/pi config wiring), `~566-575` (`formatAmbiguousAgentSelectionError`)
- Test: `tests/unit/runtime/profile-runtime.test.ts` (extend the two existing tests found during research)

- [ ] **Step 1: Read `tests/unit/runtime/profile-runtime.test.ts`'s two ambiguous-agent-selection tests in full** (lines ~233-315 per research) to understand the fake-executable-on-PATH harness.

- [ ] **Step 2: Write failing tests**

Extend the ambiguity test to write a third fake `pi` executable on `PATH` alongside `claude`/`codex`, and assert:
- the thrown error (when `selectAgent` returns `undefined`) mentions all three binary paths and `'--agent <claude|codex|pi>'` (update the existing assertion's literal string too — it currently expects `'--agent <claude|codex>'`, which will need to change regardless, so do this as one edit).
- `detected.map((agent) => agent.kind)` includes `'pi'` in the `selectAgent` callback.
- a `selectAgent: (detected) => 'pi'` variant produces `runtime.profileConfig.agentKind === 'pi'` and a populated `profileConfig.pi?.binaryPath`.

- [ ] **Step 3: Run to verify failure**

Expected: FAIL — `displayAgentKind` has no pi case, error text still says `<claude|codex>`, `createRuntimeProfileConfig` builds no `pi` config block.

- [ ] **Step 4: Fix `displayAgentKind`**

```ts
function displayAgentKind(kind: AgentKind): string {
  return kind === 'claude' ? 'Claude Code' : 'Codex CLI';
}
```
to:
```ts
function displayAgentKind(kind: AgentKind): string {
  if (kind === 'codex') return 'Codex CLI';
  if (kind === 'pi') return 'Pi';
  return 'Claude Code';
}
```

- [ ] **Step 5: Fix `createRuntimeProfileConfig`'s config wiring (around line 90)**

Change:
```ts
...(input.agentKind === 'codex' ? { codex: ... } : {}),
```
to also add, right after:
```ts
...(input.agentKind === 'pi'
  ? { pi: input.pi ?? { binaryPath: process.env.LARK_CHANNEL_PI_BIN ?? 'pi' } }
  : {}),
```
(Match whatever the exact codex line does — the research excerpt showed `input.agentKind === 'codex' ? { codex: ... } : {}` but the `...` needs to be read in full first; mirror its exact shape for pi, don't guess.)

- [ ] **Step 6: Fix `formatAmbiguousAgentSelectionError`'s literal string (lines ~566-575)**

Update `'--agent <claude|codex>'` to `'--agent <claude|codex|pi>'`, and whatever loop/list formats detected agents to include pi (it's likely already generic over `DetectedAgent[]` via `displayAgentKind`, so only the hardcoded flag-hint string needs a literal edit — read the function in full to confirm there isn't a second hardcoded list elsewhere in it).

- [ ] **Step 7: Run to verify tests pass, typecheck**

Run: `pnpm vitest run tests/unit/runtime/profile-runtime.test.ts && pnpm typecheck`

- [ ] **Step 8: Commit**

```bash
git add src/runtime/profile-runtime.ts tests/unit/runtime/profile-runtime.test.ts
git commit -m "feat: recognize pi in the first-run agent-selection wizard"
```

---

### Task 18: `src/cli/index.ts` — help text

**Files:**
- Modify: `src/cli/index.ts:42,66,85,157` (help-text strings only, no logic)

- [ ] **Step 1: Update all four `--agent` help strings**

Change each occurrence of `'agent kind for a new profile (claude or codex)'` (and equivalents at lines 66/85/157) to `'agent kind for a new profile (claude, codex, or pi)'`.

- [ ] **Step 2: Typecheck (should be a no-op check since these are string literals) and run `pnpm build` to confirm the CLI still compiles**

Run: `pnpm typecheck && pnpm build`

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "docs: mention pi in CLI --agent help text"
```

---

## Phase 9 — Documentation

### Task 19: `README.md` updates

**Files:**
- Modify: `README.md` — prerequisites list (~line 22-26), multi-profile section (~91-105), CLI usage block (~112-129), permission-mode table (~211-219), FAQ (~308)

- [ ] **Step 1: Add pi to prerequisites**

After the Codex CLI bullet (line 25):
```markdown
  - Pi: `pi`, see https://pi.dev
```

- [ ] **Step 2: Update the multi-profile section heading and examples**

Change the heading `### Multiple profiles: Claude and Codex` to `### Multiple profiles: Claude, Codex, and Pi`, and add a third example line after the existing two:
```bash
lark-channel-bridge start --profile pi --agent pi
```

- [ ] **Step 3: Update CLI usage blocks**

Everywhere `[--agent claude|codex]` appears in the `Commands` section's code blocks, change to `[--agent claude|codex|pi]`. Add a third `lark-channel-bridge profile create pi --agent pi` line next to the existing `profile create claude`/`profile create codex` examples.

- [ ] **Step 4: Extend the permission-mode mapping table**

Change:
```markdown
| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |
```
to:
```markdown
| Bridge access | Claude permission mode | Codex mode | Pi mode |
|---|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` | no restriction |
| `workspace` | `acceptEdits` | `workspace-write` | no restriction |
| `read-only` | `plan` | `read-only` | `--tools read,grep,find,ls` |
```
Immediately after the table, add a note:
```markdown
Pi has no built-in workspace-scoped sandbox: `workspace` and `full` behave identically for Pi (no `--tools` restriction). Users wanting filesystem/network confinement for Pi should containerize it themselves — see Pi's own containerization docs.
```

- [ ] **Step 5: Update the FAQ line about local CLI login**

Change `` "Usually the local `claude` or `codex` CLI is not logged in..." `` to mention `pi` too: `` "Usually the local `claude`, `codex`, or `pi` CLI is not logged in..." ``.

- [ ] **Step 6: Run the README contract test**

Run: `pnpm vitest run tests/unit/docs/readme-contract.test.ts`
Expected: PASS. Specifically double-check your new prose doesn't introduce the literal quoted substring `"sandbox"` anywhere (the test bans that exact form) — the note in Step 4 above uses "sandbox" unquoted only, which is safe; re-verify your actual final wording, not just this plan's draft.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: add pi to README (prerequisites, profiles, permission table, FAQ)"
```

---

### Task 20: `README.zh.md` — mirror Task 19

**Files:**
- Modify: `README.zh.md` — same sections as README.md, using the exact line numbers/text found during plan research (prerequisites ~22-26, multi-profile heading+examples ~91-98, CLI usage ~111-130, permission table ~211-219, common-problems ~308)

- [ ] **Step 1: Add the pi prerequisite bullet**

After the Codex CLI line:
```markdown
  - pi：`pi`，安装说明：https://pi.dev
```

- [ ] **Step 2: Update the multi-profile heading and add a third profile example**

Change `### 多 profile：分别运行 Claude 和 Codex` to `### 多 profile：分别运行 Claude、Codex 和 pi`, add:
```bash
lark-channel-bridge start --profile pi --agent pi
```

- [ ] **Step 3: Update CLI usage blocks**

`[--agent claude|codex]` → `[--agent claude|codex|pi]` at both occurrences; add a third `profile create pi --agent pi` line.

- [ ] **Step 4: Extend the permission-mode table** (same shape as README.md's Task 19 Step 4, translated)

```markdown
| Bridge access | Claude permission mode | Codex mode | Pi mode |
|---|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` | 无限制 |
| `workspace` | `acceptEdits` | `workspace-write` | 无限制 |
| `read-only` | `plan` | `read-only` | `--tools read,grep,find,ls` |
```
Followed by:
```markdown
pi 目前没有内置的 workspace 级沙箱：`workspace` 和 `full` 对 pi 而言行为相同（不加 `--tools` 限制）。需要更强隔离的用户应自行为 pi 做容器化 — 参见 pi 自己的容器化文档。
```

- [ ] **Step 5: Update the common-problems line**

Change `` "通常是本机 `claude` 或 `codex` CLI 没登录" `` to `` "通常是本机 `claude`、`codex` 或 `pi` CLI 没登录" ``.

- [ ] **Step 6: Re-run the README contract test** (it may check both README files — confirm by reading the test)

Run: `pnpm vitest run tests/unit/docs/readme-contract.test.ts`

- [ ] **Step 7: Commit**

```bash
git add README.zh.md
git commit -m "docs: mirror pi documentation into README.zh.md"
```

---

## Phase 10 — Full verification

### Task 21: Full suite, typecheck, build

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `pnpm test`
Expected: PASS — this runs unit, integration, and process-level tests together per this repo's CI setup.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 4: Grep for any remaining un-widened binary agent checks**

Run: `grep -rn "agentKind === 'codex' ? \|agentId === 'codex' ? \|'claude' && \|'claude' || " src --include="*.ts" | grep -v "pi'"`

Manually review each hit. Given the scope of this plan, it's likely something was missed — this repo has ~20+ scattered call sites and the research pass, while thorough, explicitly flagged some as "re-check during implementation" (e.g. `start.ts` line 421's `if (profileConfig.agentKind === 'codex')` was noted but not fully inspected). Fix anything real you find, following the same pattern used throughout this plan: pi behaves like Claude for session/history-shaped checks, and needs its own explicit case for anything permission/sandbox-shaped.

- [ ] **Step 5: Re-run the full suite after any fixes from Step 4**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 6: Commit any fixes from this sweep**

```bash
git add -A
git commit -m "fix: catch remaining binary agent-kind checks missed by the mechanical pass"
```
(Skip this commit if Step 4 found nothing to fix.)

---

## Phase 11 — Manual end-to-end verification (not automated — do this yourself, or ask the user to)

This requires a real Feishu/Lark app and a logged-in local `pi` CLI. Not part of `pnpm test`.

- [ ] **Step 1:** `lark-channel-bridge profile create pi-test --agent pi`
- [ ] **Step 2:** `lark-channel-bridge run --profile pi-test` (foreground)
- [ ] **Step 3:** From `lark-cli`, authenticated as a real user account (not the bot), send a DM to the bot
- [ ] **Step 4:** Confirm the bridge spawns `pi`, streams back a reply (and a COT process message if enabled), and `/status` shows the pi session as active
- [ ] **Step 5:** Exercise `/stop` mid-run (interrupt path) and `/new` then a follow-up message in the same chat (session-continuity path via `--session`)
- [ ] **Step 6:** Report results back — if anything misbehaves, it's a real bug this plan's automated tests didn't catch (likely something in the argv/event-shape assumptions this plan made from pi's docs/source, since no automated test spawns a real `pi` binary)
