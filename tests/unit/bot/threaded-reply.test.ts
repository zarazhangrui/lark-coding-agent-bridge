import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import {
  renderReplyText,
  sendThreadedMarkdown,
  splitMarkdownForPost,
  stripSilentMarker,
} from '../../../src/bot/channel.js';
import { initialState, type RunState } from '../../../src/card/run-state.js';

function state(partial: Partial<RunState>): RunState {
  return { ...initialState, terminal: 'done', ...partial };
}

describe('stripSilentMarker', () => {
  it('removes the bare sentinel from a text block', () => {
    const out = stripSilentMarker(
      state({ blocks: [{ kind: 'text', content: '[[silent]]', streaming: false }] }),
    );
    expect((out.blocks[0] as { content: string }).content).toBe('');
  });

  it('strips a sentinel wrapped in backticks / bold / whitespace', () => {
    const out = stripSilentMarker(
      state({ blocks: [{ kind: 'text', content: '好的 `[[silent]]`', streaming: false }] }),
    );
    expect((out.blocks[0] as { content: string }).content).toBe('好的');
  });

  it('leaves a real reply untouched', () => {
    const s = state({ blocks: [{ kind: 'text', content: '我来帮你看', streaming: false }] });
    expect(stripSilentMarker(s)).toBe(s); // same ref — no allocation when clean
  });
});

describe('renderReplyText (post-strip)', () => {
  // Mirrors the real flow: filterForPrefs strips the marker, then renderReplyText runs.
  const render = (s: RunState, mustReply: boolean) =>
    renderReplyText(stripSilentMarker(s), mustReply);

  it('falls back to an ack when @-mentioned and the agent only said the sentinel', () => {
    const body = render(
      state({ blocks: [{ kind: 'text', content: '[[silent]]', streaming: false }] }),
      true,
    );
    expect(body).not.toContain('[[silent]]');
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('stays empty for an un-mentioned (smart) silent eval', () => {
    expect(
      render(state({ blocks: [{ kind: 'text', content: '[[silent]]', streaming: false }] }), false),
    ).toBe('');
  });

  it('does not fire the ack fallback mid-run (only at terminal)', () => {
    // While running, renderText surfaces the typing footer — the point is the
    // empty-reply ack must NOT appear until the run is done.
    const body = render(
      state({ terminal: 'running', blocks: [{ kind: 'text', content: '[[silent]]', streaming: true }] }),
      true,
    );
    expect(body).not.toContain('有什么可以帮你的');
  });

  it('returns the real reply verbatim when there is one', () => {
    expect(
      render(state({ blocks: [{ kind: 'text', content: '改好了', streaming: false }] }), true),
    ).toBe('改好了');
  });
});

describe('splitMarkdownForPost', () => {
  it('returns a single chunk when under the limit', () => {
    expect(splitMarkdownForPost('hello', 3500)).toEqual(['hello']);
  });

  it('splits oversized text into <=limit chunks', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const chunks = splitMarkdownForPost(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    // No content lost (modulo the join newlines / reopened fences).
    expect(chunks.join('\n')).toContain('line 0');
    expect(chunks.join('\n')).toContain('line 49');
  });
});

describe('sendThreadedMarkdown', () => {
  function fakeChannel(): {
    channel: LarkChannel;
    calls: Array<{ replyTo?: string; replyInThread?: boolean }>;
  } {
    const calls: Array<{ replyTo?: string; replyInThread?: boolean }> = [];
    let n = 0;
    const channel = {
      send: async (
        _chatId: string,
        _input: unknown,
        opts: { replyTo?: string; replyInThread?: boolean },
      ) => {
        calls.push({ replyTo: opts.replyTo, replyInThread: opts.replyInThread });
        return { messageId: `m${++n}` };
      },
    } as unknown as LarkChannel;
    return { channel, calls };
  }

  const long = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i} ${'y'.repeat(60)}`).join('\n');

  it('chains continuation chunks under the previous message in a topic', async () => {
    const { channel, calls } = fakeChannel();
    await sendThreadedMarkdown(channel, 'oc_x', long(200), {
      replyTo: 'om_root',
      replyInThread: true,
    });
    expect(calls.length).toBeGreaterThan(1);
    // Head replies to the user's message; every continuation replies to the
    // previous chunk's id, so all of them land in the one topic.
    expect(calls[0]).toEqual({ replyTo: 'om_root', replyInThread: true });
    expect(calls[1]?.replyTo).toBe('m1');
    expect(calls[2]?.replyTo).toBe('m2');
    expect(calls.every((c) => c.replyInThread === true)).toBe(true);
  });

  it('leaves continuation chunks at top level outside a thread', async () => {
    const { channel, calls } = fakeChannel();
    await sendThreadedMarkdown(channel, 'oc_x', long(200), { replyTo: 'om_root' });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]?.replyTo).toBe('om_root'); // head still quotes the user msg
    expect(calls.slice(1).every((c) => c.replyTo === undefined)).toBe(true);
  });
});
