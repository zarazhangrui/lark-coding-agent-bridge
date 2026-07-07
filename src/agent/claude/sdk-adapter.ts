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

    const env = mergeProcessEnv(buildLarkChannelEnv(this.larkChannel), this.env);
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
