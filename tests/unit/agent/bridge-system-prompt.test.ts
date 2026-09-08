import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SYSTEM_PROMPT,
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';

describe('bridge system prompt bot collaboration rules', () => {
  it('states that bots only receive messages via a real structured mention', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('只有被真实 @');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('收不到');
  });

  it('scopes the mention requirement to bots, not human users', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('人类用户');
  });

  it('tells the agent not to mention other bots by default to avoid loops', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('默认不要 @ 其他 bot');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('死循环');
  });

  it('allows mentioning a bot when the user explicitly asks for a handoff', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('用户明确要求');
  });

  it('points self-identification at the bridge_context botOpenId field', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('botOpenId');
  });

  it('documents the senderType and mentions context fields', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('senderType');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('mentions');
  });

  it('tells the agent not to mimic the batch sender annotation format', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('[名字 (user|bot)]');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('不要模仿');
  });
});

/**
 * A run that spawns a detached job and returns reports only "I started it".
 * The bridge sees nothing after `flush.end`, so the job's completion reaches
 * the user only if the agent wires the notification itself.
 */
describe('bridge system prompt detached-job reporting', () => {
  it('states that the bridge reports nothing once the run ends', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('只汇报本轮 run 期间发生的事');
  });

  it('distinguishes a reaped child from a truly detached process', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('run_in_background');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('setsid');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('活过本轮');
  });

  it('routes the completion notice through the wake file, not a chat message', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('bridge 会把你叫回来');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('bridge_context.wakePrefix');
  });

  it('shows the unique-name-then-rename form, not a fixed filename', () => {
    // A fixed name loses one of two concurrent reports; writing `.wake` in
    // place can be swept half-written.
    expect(BRIDGE_SYSTEM_PROMPT).toContain('mktemp');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('mv "$f" "$f.wake"');
  });

  it('names the lark-cli subcommand that actually exists', () => {
    // `lark-cli im send` / `im send-card` are not commands — both fail with
    // "unknown subcommand", which the agent then has to discover at runtime.
    expect(BRIDGE_SYSTEM_PROMPT).toContain('+messages-send');
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('lark-cli im send ');
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('lark-cli im send-card');
  });

  it('makes every outbound send example use the bot identity', () => {
    // Sending as the user makes the message look like the user wrote it, and
    // in a p2p chat it comes back through intake as a fresh user turn. Asserted
    // per example, not once for the whole prompt: an agent copies the nearest
    // concrete command, so one example missing the flag is enough to reproduce
    // the impersonation.
    const sends = BRIDGE_SYSTEM_PROMPT.split('\n').filter((line) =>
      line.includes('+messages-send') && line.includes('--chat-id'),
    );
    expect(sends.length).toBeGreaterThan(0);
    for (const line of sends) expect(line).toContain('--as bot');
  });

  it('names bridge_context fields as they actually appear', () => {
    // The block is JSON: `chatId`, not `chat_id`. A snake_case reference sends
    // the agent looking for a key that is not there.
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('bridge_context.chat_id');
  });

  it('pins the notice to the bridge_context chat rather than a hardcoded id', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('不要写死');
  });

  it('demands the notice sit inside the same subshell, after the long command', () => {
    // Detaching the notice separately would fire it immediately, which is the
    // failure this whole section exists to prevent.
    expect(BRIDGE_SYSTEM_PROMPT).toContain('同一个子 shell 内');
  });

  it('requires failures to be reported, not just successes', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('只在成功时回执，等于把失败变成静默');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('退出码');
  });

  it('tells the agent to set expectations in its own reply', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('跑完会在这里告诉你');
  });

  it('prefers finishing inside the run over detaching at all', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('能在本轮内跑完的就不要 detach');
  });
});

describe('buildBridgeSystemPrompt', () => {
  it('returns the base prompt unchanged when no identity is available', () => {
    expect(buildBridgeSystemPrompt(undefined)).toBe(BRIDGE_SYSTEM_PROMPT);
  });

  it('appends a concrete identity line with open_id and name', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: '助手' });
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('ou_bot_self');
    expect(prompt).toContain('助手');
  });

  it('appends the identity line even when the bot name is missing', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
  });
});

describe('prefixBridgeSystemPrompt', () => {
  it('prefixes the identity-aware system prompt before the user message', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', { openId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
    expect(prompt.indexOf('ou_bot_self')).toBeLessThan(prompt.indexOf('## user_message'));
    expect(prompt.endsWith('hello world')).toBe(true);
  });

  it('keeps working without an identity', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', undefined);
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt.endsWith('hello world')).toBe(true);
  });
});
