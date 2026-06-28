import { describe, it, expect, vi } from 'vitest';
import { processAgentStream } from '../../../src/bot/channel';
import type { AgentEvent } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';

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

describe('processAgentStream — onTerminal + fullText (U11/U12)', () => {
  it('fires onTerminal once with accumulated fullText on done', async () => {
    const handle = fakeHandle();
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'hello' } as AgentEvent,
      { type: 'text', delta: ' world' } as AgentEvent,
      { type: 'done', terminationReason: 'normal' } as AgentEvent,
    ];
    const onTerminal = vi.fn();
    await processAgentStream(handle, eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onTerminal,
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const [finalState, _elapsed, fullText] = onTerminal.mock.calls[0]!;
    expect(fullText).toBe('hello world');
    expect(finalState.terminal).toBe('done');
  });

  it('fires onTerminal on error terminal', async () => {
    const handle = fakeHandle();
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'partial' } as AgentEvent,
      { type: 'error', message: 'boom', terminationReason: 'failed' } as AgentEvent,
    ];
    const onTerminal = vi.fn();
    await processAgentStream(handle, eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onTerminal,
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]![0].terminal).toBe('error');
    expect(onTerminal.mock.calls[0]![2]).toBe('partial');
  });

  it('fullText accumulates even when window would truncate state', async () => {
    const handle = fakeHandle();
    const long = 'a'.repeat(10_000);
    const evts: AgentEvent[] = [
      { type: 'text', delta: long } as AgentEvent,
      { type: 'done', terminationReason: 'normal' } as AgentEvent,
    ];
    const onTerminal = vi.fn();
    await processAgentStream(handle, eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onTerminal,
    });
    expect(onTerminal.mock.calls[0]![2]).toBe(long);
  });
});

describe('processAgentStream — heartbeat (U7/U9/U10)', () => {
  it('fires onHeartbeat during a silent gap with current tool, clears on terminal', async () => {
    vi.useFakeTimers();
    try {
      const handle = fakeHandle();
      let resolveGap: () => void = () => {};
      const gap = new Promise<void>((r) => {
        resolveGap = r;
      });
      async function* gen(): AsyncIterable<AgentEvent> {
        yield { type: 'tool_use', id: '1', name: 'Bash', input: {} } as AgentEvent;
        await gap;
        yield { type: 'tool_result', id: '1', output: 'ok', isError: false } as AgentEvent;
        yield { type: 'done', terminationReason: 'normal' } as AgentEvent;
      }
      const onHeartbeat = vi.fn();
      const onTerminal = vi.fn();
      const promise = processAgentStream(handle, gen(), 'scope', undefined, noRecord, noFlush, {
        onHeartbeat,
        onTerminal,
        heartbeatIntervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(onHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(1);
      const [elapsed, tool] = onHeartbeat.mock.calls[0]!;
      expect(elapsed).toBeGreaterThan(0);
      expect(tool).toBe('Bash');
      resolveGap();
      await vi.advanceTimersByTimeAsync(50);
      await promise;
      expect(onTerminal).toHaveBeenCalledTimes(1);
      const heartbeatCountAfterTerminal = onHeartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(onHeartbeat.mock.calls.length).toBe(heartbeatCountAfterTerminal);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires onHeartbeat periodically during a long silent gap (≥2 times)', async () => {
    vi.useFakeTimers();
    try {
      const handle = fakeHandle();
      let resolveGap: () => void = () => {};
      const gap = new Promise<void>((r) => {
        resolveGap = r;
      });
      async function* gen(): AsyncIterable<AgentEvent> {
        yield { type: 'tool_use', id: '1', name: 'Bash', input: {} } as AgentEvent;
        await gap;
        yield { type: 'done', terminationReason: 'normal' } as AgentEvent;
      }
      const onHeartbeat = vi.fn();
      const promise = processAgentStream(handle, gen(), 'scope', undefined, noRecord, noFlush, {
        onHeartbeat,
        heartbeatIntervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(onHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
      resolveGap();
      await vi.advanceTimersByTimeAsync(50);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });
});
