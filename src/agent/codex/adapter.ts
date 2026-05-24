import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { createCodexTranslator } from './stream-json';

export interface CodexAdapterOptions {
  binary?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

const BRIDGE_PROMPT_PREFIX = `# lark-channel-bridge 运行约定

你正在 lark-channel-bridge 里跑：把飞书/Lark 用户消息桥到本地 \`codex\` CLI。

每条 user message 顶部会带一个 \`<bridge_context>\` 块，里面是当前对话的 chat_id、chat 类型、发送者。这些是 bridge 注入的元数据，不要照抄、不要在回复里渲染。

如果用户引用消息，bridge 会注入 \`<quoted_message>\` 块。用户实际问题在它之后，回答时围绕引用内容展开，不要照抄 XML 标签。

如果用户发送或引用交互卡片，bridge 会注入 \`<interactive_card>\` 块，里面是卡片 JSON。解析它来理解按钮、字段和布局，不要照抄 XML 标签。

如果你想发一张可回调的交互卡片，请用 \`lark-cli im send-card --chat-id <chat_id> --card '<json>'\` 发送 CardKit 2.0 卡片，并在按钮 value 里放 \`"__agent_cb": true\`。用户点击后，bridge 会把 payload 去掉 marker 后作为 \`[card-click] {...}\` 发回同一会话。

以下是用户的真实输入：

`;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly binary: string;
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? 'codex';
    this.sandbox = opts.sandbox ?? 'danger-full-access';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const prompt = `${BRIDGE_PROMPT_PREFIX}${opts.prompt}`;
    const args = this.buildArgs(opts, prompt);
    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      sandbox: this.sandbox,
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
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

  private buildArgs(opts: AgentRunOptions, prompt: string): string[] {
    if (opts.sessionId) {
      const args = ['exec', 'resume', '--json', '--skip-git-repo-check'];
      if (this.sandbox === 'danger-full-access') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
      if (opts.model) args.push('-m', opts.model);
      args.push(opts.sessionId, prompt);
      return args;
    }

    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      this.sandbox,
      '-C',
      opts.cwd ?? process.cwd(),
    ];
    if (this.sandbox === 'danger-full-access') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (opts.model) args.push('-m', opts.model);
    args.push(prompt);
    return args;
  }
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const translator = createCodexTranslator();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
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
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with code ${exitCode}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}
