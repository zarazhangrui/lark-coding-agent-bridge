import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
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
      { type: 'text', delta: 'hello' },
      { type: 'thinking', delta: 'checking' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
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
        // Top-level totals are summed over every request the agentic loop
        // made; `iterations` describes the final message. Shapes and ratios
        // here are taken from a real 4-tool-call run.
        usage: {
          input_tokens: 8,
          output_tokens: 895,
          cache_read_input_tokens: 144_499,
          cache_creation_input_tokens: 15_764,
          iterations: [
            {
              input_tokens: 2,
              output_tokens: 678,
              cache_read_input_tokens: 40_113,
              cache_creation_input_tokens: 75,
            },
          ],
        },
        total_cost_usd: 0.1234,
      }),
    ]).toEqual([
      {
        type: 'usage',
        // Final request only: 2 + 40113 + 75 + 678. Summing the top-level
        // totals instead would give 161166 — four times over, and past a 1M
        // window within a normal session.
        contextTokens: 40_868,
        inputTokens: 8,
        outputTokens: 895,
        cachedInputTokens: 144_499,
        cacheCreationInputTokens: 15_764,
        contextWindow: undefined,
        costUsd: 0.1234,
      },
      { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
    ]);
    expect([...translateEvent({ type: 'result', session_id: 'sess-2' })][0]).not.toHaveProperty('threadId');
  });

  it('reports no context size when the CLI gives no per-request breakdown', () => {
    // Cumulative totals cannot be decomposed into the final request, and no
    // footer beats a fourfold-wrong one.
    const [usage] = [...translateEvent({
      type: 'result',
      session_id: 'sess-3',
      usage: { input_tokens: 8, output_tokens: 895, cache_read_input_tokens: 144_499 },
    })];
    expect(usage).toMatchObject({ type: 'usage', contextTokens: undefined });
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
