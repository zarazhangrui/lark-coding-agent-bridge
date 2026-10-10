import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { createTranslateEvent, translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('Claude stream-json translator', () => {
  it('translates system init metadata', () => {
    expect([
      ...translateEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/repo',
        model: 'sonnet',
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo', model: 'sonnet' },
    ]);
    expect([...translateEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' })][0]).not.toHaveProperty('threadId');
  });

  it('translates assistant text, thinking, and tool_use blocks in order', () => {
    // Text is buffered; a tool_use in the same message flushes it as progress
    // before the tool call, so order is thinking → text → tool_use.
    expect([
      ...translateEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'checking' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
    ]).toEqual([
      { type: 'thinking', delta: 'checking' },
      { type: 'text', delta: 'hello' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('emits the last buffered text as final_text on result', () => {
    const translate = createTranslateEvent();
    expect(translate.translate({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'final answer' }] },
    })).toEqual([]);
    expect(translate.translate({
      type: 'result',
      session_id: 'sess-final',
    })).toEqual([
      { type: 'final_text', content: 'final answer' },
      { type: 'done', sessionId: 'sess-final', terminationReason: 'normal' },
    ]);
  });

  it('translates user tool_result blocks including structured output and errors', () => {
    expect([
      ...translateEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      }),
    ]).toEqual([
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 'tool-2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('translates result usage before done', () => {
    expect([
      ...translateEvent({
        type: 'result',
        session_id: 'sess-2',
        usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 },
        total_cost_usd: 0.1234,
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 12, outputTokens: 34, cachedInputTokens: 5, costUsd: 0.1234 },
      { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
    ]);
    expect([...translateEvent({ type: 'result', session_id: 'sess-2' })][0]).not.toHaveProperty('threadId');
  });

  it('streams token-level text_delta deltas live, then buffers the full block as final_text', () => {
    // --include-partial-messages emits content_block_delta (text_delta) tokens
    // before the full assistant block. Deltas must stream as `text` events
    // immediately; the full block must not be re-emitted (it would duplicate).
    const translate = createTranslateEvent();
    const deltas = [
      translate.translate({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
      }),
      translate.translate({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '世界' } },
      }),
    ];
    expect(deltas).toEqual([
      [{ type: 'text', delta: '你好' }],
      [{ type: 'text', delta: '世界' }],
    ]);

    // Full assistant block arrives after deltas: buffer it for final_text,
    // do not stream it again.
    const full = translate.translate({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '你好世界' }] },
    });
    expect(full).toEqual([]);

    const final = translate.translate({ type: 'result', session_id: 'sess-stream' });
    expect(final).toEqual([
      { type: 'final_text', content: '你好世界' },
      { type: 'done', sessionId: 'sess-stream', terminationReason: 'normal' },
    ]);
  });

  it('does not re-emit streamed text when tool calls split turns (regression: duplicate replies)', () => {
    // Real long runs emit delta-text → full assistant block → tool_use →
    // delta-text → full assistant block → … The full blocks whose content was
    // already streamed as deltas must not be re-emitted as progress text, and
    // tool_use must not flush them either (that posted every sentence twice).
    const translate = createTranslateEvent();
    const all: Array<{ type: string; delta?: string; content?: string }> = [];
    const feed = (raw: unknown): void => {
      all.push(...(translate.translate(raw) as Array<{ type: string; delta?: string; content?: string }>));
    };

    feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '需求明确' } } });
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: '需求明确' }] } });
    feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
    feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '检查环境' } } });
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: '检查环境' }] } });
    feed({ type: 'result', session_id: 'sess-dup' });

    const texts = all.filter((e) => e.type === 'text').map((e) => e.delta ?? '');
    expect(texts).toEqual(['需求明确', '检查环境']);

    const finals = all.filter((e) => e.type === 'final_text').map((e) => e.content ?? '');
    expect(finals).toEqual(['检查环境']);

    // No duplicated sentence.
    const counts = new Map<string, number>();
    for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });

  it('streams thinking_delta deltas live', () => {
    const translate = createTranslateEvent();
    expect(
      translate.translate({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } },
      }),
    ).toEqual([{ type: 'thinking', delta: '想' }]);
  });

  it('ignores unknown, empty, and incomplete raw events', () => {
    expect([...translateEvent(null)]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'system', subtype: 'other' })]).toEqual([]);
  });
});

describe('Claude stream-json reader behavior', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('skips non-JSON stdout lines and reports non-zero stderr detail without redacting visible paths', async () => {
    const stderr = 'fatal stderr at /Users/example/work/repo/file.ts';
    const binary = await createFakeBinary([
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } }),
    ], 7, stderr);
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-reader',
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const events = await collect(run.events);

    expect(events).toEqual([
      { type: 'text', delta: 'kept' },
      {
        type: 'error',
        message: `claude exited with code 7: ${stderr}`,
        terminationReason: 'failed',
      },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeBinary(lines: string[], exitCode: number, stderr: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stream-json-test-'));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      `const lines = ${JSON.stringify(lines)};`,
      'for (const line of lines) console.log(line);',
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return {
    path,
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
