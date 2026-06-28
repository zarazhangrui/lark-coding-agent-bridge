import { describe, it, expect, vi } from 'vitest';
import { processAgentStream, awaitRenderAwareStream } from '../../../src/bot/channel';
import type { AgentEvent } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { initialState } from '../../../src/card/run-state';

function fakeHandle(): RunHandle {
  return {
    run: {
      stop: vi.fn().mockResolvedValue(undefined),
      waitForExit: vi.fn().mockResolvedValue(undefined),
    } as never,
    interrupted: false,
  };
}

async function* eventsFrom(evts: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of evts) yield e;
}

const noFlush = vi.fn().mockResolvedValue(undefined);
const noRecord = (_: AgentEvent) => {};

describe('card-stream integration — D + N scenarios (processAgentStream level)', () => {
  it('D2: only tools, no text → window trims tools, no C2 (fullText empty)', async () => {
    const evts: AgentEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evts.push({ type: 'tool_use', id: String(i), name: 'Bash', input: {} } as AgentEvent);
      evts.push({ type: 'tool_result', id: String(i), output: 'ok', isError: false } as AgentEvent);
    }
    evts.push({ type: 'done', terminationReason: 'normal' } as AgentEvent);
    const flush = vi.fn().mockResolvedValue(undefined);
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, flush, {
      onTerminal,
    });
    const lastState = flush.mock.calls[flush.mock.calls.length - 1]![0];
    const toolBlocks = lastState.blocks.filter((b: { kind: string }) => b.kind === 'tool');
    expect(toolBlocks.length).toBeLessThanOrEqual(8);
    expect(onTerminal.mock.calls[0]![2]).toBe('');
  });

  it('D3: empty run (done immediately) → no heartbeat, notice 0 tools, no C2', async () => {
    const evts: AgentEvent[] = [{ type: 'done', terminationReason: 'normal' } as AgentEvent];
    const onHeartbeat = vi.fn();
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onHeartbeat,
      onTerminal,
    });
    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const [state, , fullText] = onTerminal.mock.calls[0]!;
    expect(state.blocks.filter((b: { kind: string }) => b.kind === 'tool').length).toBe(0);
    expect(fullText).toBe('');
  });

  it('N1: 20 tool pairs + long text → bounded flushes, onTerminal, fullText complete, truncated', async () => {
    const evts: AgentEvent[] = [];
    for (let i = 0; i < 20; i++) {
      evts.push({ type: 'tool_use', id: String(i), name: 'Read', input: {} } as AgentEvent);
      evts.push({ type: 'tool_result', id: String(i), output: 'ok', isError: false } as AgentEvent);
    }
    const longText = 'x'.repeat(10_000);
    evts.push({ type: 'text', delta: longText } as AgentEvent);
    evts.push({ type: 'done', terminationReason: 'normal' } as AgentEvent);
    const flush = vi.fn().mockResolvedValue(undefined);
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, flush, {
      onTerminal,
    });
    for (const call of flush.mock.calls) {
      const s = call[0];
      const toolBlocks = s.blocks.filter((b: { kind: string }) => b.kind === 'tool');
      expect(toolBlocks.length).toBeLessThanOrEqual(9);
    }
    expect(onTerminal.mock.calls[0]![2]).toBe(longText);
    expect(onTerminal.mock.calls[0]![3]).toBe(true);
  });

  it('N2: short run (< intervalMs) → no heartbeat, notice, not truncated', async () => {
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'hi' } as AgentEvent,
      { type: 'done', terminationReason: 'normal' } as AgentEvent,
    ];
    const onHeartbeat = vi.fn();
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onHeartbeat,
      onTerminal,
      heartbeatIntervalMs: 60_000,
    });
    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]![3]).toBe(false);
  });

  it('N3: interrupted → onTerminal fires with interrupted terminal', async () => {
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'partial' } as AgentEvent,
      { type: 'error', message: 'stopped', terminationReason: 'interrupted' } as AgentEvent,
    ];
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onTerminal,
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]![0].terminal).toBe('interrupted');
  });

  it('N4: idle_timeout → onTerminal fires with idle_timeout terminal', async () => {
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'working' } as AgentEvent,
      { type: 'error', message: 'idle', terminationReason: 'timeout' } as AgentEvent,
    ];
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onTerminal,
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]![0].terminal).toBe('idle_timeout');
  });
});

describe('N5: awaitRenderAwareStream fallback on stream failure', () => {
  it('invokes fallback with final state when the card stream rejects', async () => {
    const fallback = vi.fn().mockResolvedValue(undefined);
    const finalState = { ...initialState, terminal: 'done' as const };
    await awaitRenderAwareStream({
      mode: 'card',
      streamDone: Promise.reject(new Error('stream failed')),
      renderDone: Promise.resolve(finalState),
      producerStarted: () => false,
      fallback,
    });
    expect(fallback).toHaveBeenCalledWith(finalState);
  });
});
