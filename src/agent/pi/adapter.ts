import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { spawnProcess, mergeProcessEnv, type SpawnedProcessByStdio } from '../../platform/spawn';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function textBlocks(value: unknown): string {
  return Array.isArray(value) ? value.map(object).filter(b => b.type === 'text').map(b => typeof b.text === 'string' ? b.text : '').join('\n') : '';
}

/** Pi's JSON CLI owns authentication, extensions, models and session files. */
export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi';
  private identity?: AgentBotIdentity;
  private readonly binary: string;
  private readonly sessionDir: string;

  constructor(private readonly opts: { profileStateDir: string; binary?: string; larkChannel?: LarkChannelEnvContext }) {
    this.binary = opts.binary ?? process.env.LARK_CHANNEL_PI_BIN ?? 'pi';
    this.sessionDir = join(opts.profileStateDir, 'pi-sessions');
  }

  setBotIdentity(identity: AgentBotIdentity): void { this.identity = identity; }
  checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({ agentId: 'pi', agentName: 'Pi', command: this.binary, binaryPath: this.binary });
  }
  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }
  async prepareRun(opts: AgentRunOptions): Promise<void> {
    // Pi has no built-in permission sandbox; never silently weaken a policy.
    if ((opts.sandbox && opts.sandbox !== 'danger-full-access') || (opts.permissionMode && opts.permissionMode !== 'bypassPermissions')) {
      throw new Error('Pi requires full access; use trusted extensions or an external sandbox for restricted execution.');
    }
    if (opts.sessionId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(opts.sessionId)) {
      throw new Error('Pi resume requires an exact session UUID.');
    }
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const available = await this.checkAvailability();
    if (!available.ok) throw available.error;
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for PiAdapter.run');
    const sessionId = opts.sessionId ?? randomUUID();
    const args = ['--mode', 'json', '--session-dir', this.sessionDir, '--session-id', sessionId];
    if (opts.model) args.push('--model', opts.model);
    for (const path of opts.images ?? []) args.push(`@${path}`);
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.opts.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;
    let spawnError: Error | undefined;
    let stopped = false;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', (err) => { spawnError = err; });
    child.on('error', (err) => { spawnError = err; });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.identity), 'utf8');
    return {
      runId: opts.runId,
      events: this.events(child, exit, sessionId, opts.cwd, () => ({ spawnError, stopped, stderr })),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopped = true;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), opts.stopGraceMs ?? 5000);
        try { await exit; } finally { clearTimeout(timer); }
      },
      async waitForExit(timeoutMs: number) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([exit.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
        finally { if (timer) clearTimeout(timer); }
      },
    };
  }

  private async *events(
    child: PiChild,
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    sessionId: string,
    cwd: string,
    state: () => { spawnError?: Error; stopped: boolean; stderr: string },
  ): AsyncGenerator<AgentEvent> {
    yield { type: 'system', sessionId, cwd };
    const translator = new PiJsonTranslator();
    // Split only LF. readline also splits U+2028/U+2029 inside JSON strings.
    child.stdout.setEncoding('utf8');
    let pending = '';
    try {
      for await (const chunk of child.stdout) {
        pending += chunk;
        let lf: number;
        while ((lf = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, lf).replace(/\r$/, '');
          pending = pending.slice(lf + 1);
          if (line.trim()) yield* translator.translate(JSON.parse(line));
        }
      }
      if (pending.trim()) yield* translator.translate(JSON.parse(pending));
    } catch {
      child.kill('SIGKILL');
      await exit;
      yield { type: 'error', message: 'Invalid Pi JSON protocol; check the Pi version and extensions.', terminationReason: 'failed' };
      return;
    }
    const result = await exit;
    const last = state();
    if (last.stopped) yield { type: 'done', sessionId, terminationReason: 'interrupted' };
    else if (last.spawnError || result.code !== 0 || translator.error || !translator.settled) {
      // Provider/stderr bodies can contain credentials; keep errors in local Pi sessions.
      yield { type: 'error', message: last.spawnError ? `Pi process failed (${last.spawnError.name})` : `Pi did not complete successfully (exit ${result.code ?? result.signal ?? 'unknown'}). Check the private Pi session.`, terminationReason: 'failed' };
    } else {
      if (translator.finalText) yield { type: 'final_text', content: translator.finalText };
      yield { type: 'done', sessionId, terminationReason: 'normal' };
    }
  }
}

export class PiJsonTranslator {
  settled = false;
  error = false;
  finalText = '';

  *translate(value: unknown): Generator<AgentEvent> {
    const e = object(value);
    if (e.type === 'message_update') {
      const delta = object(e.assistantMessageEvent);
      if (delta.type === 'text_delta' && typeof delta.delta === 'string') yield { type: 'text', delta: delta.delta };
      if (delta.type === 'thinking_delta' && typeof delta.delta === 'string') yield { type: 'thinking', delta: delta.delta };
    } else if (e.type === 'tool_execution_start' && typeof e.toolCallId === 'string' && typeof e.toolName === 'string') {
      yield { type: 'tool_use', id: e.toolCallId, name: e.toolName, input: e.args };
    } else if (e.type === 'tool_execution_end' && typeof e.toolCallId === 'string') {
      yield { type: 'tool_result', id: e.toolCallId, output: textBlocks(object(e.result).content), isError: e.isError === true };
    } else if (e.type === 'message_end') {
      const message = object(e.message);
      if (message.role !== 'assistant') return;
      this.error = message.stopReason === 'error' || message.stopReason === 'aborted';
      this.finalText = textBlocks(message.content);
      const usage = object(message.usage);
      yield { type: 'usage', inputTokens: typeof usage.input === 'number' ? usage.input : undefined, outputTokens: typeof usage.output === 'number' ? usage.output : undefined, cachedInputTokens: typeof usage.cacheRead === 'number' ? usage.cacheRead : undefined };
    } else if (e.type === 'agent_settled') {
      this.settled = true;
      this.error ||= e.aborted === true;
    }
  }
}
