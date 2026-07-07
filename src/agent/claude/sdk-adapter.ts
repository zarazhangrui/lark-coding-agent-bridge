import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../core/logger';
import { mergeProcessEnv } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { classifyTool } from './permission-policy';
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

    const env = mergeProcessEnv(
      mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      this.env,
    );
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

    // Merge two producers into one AgentEvent stream: the SDK message loop and
    // the canUseTool permission prompts. A tiny push/waiter queue serializes them.
    const queue: AgentEvent[] = [];
    const waiters = new Set<() => void>();
    let closed = false;
    const pushEvent = (evt: AgentEvent): void => {
      queue.push(evt);
      for (const w of [...waiters]) w();
    };
    const closeQueue = (): void => {
      closed = true;
      for (const w of [...waiters]) w();
    };

    interface Pending {
      resolve: (r: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
      onAbort: () => void;
    }
    const pending = new Map<string, Pending>();
    let permCounter = 0;
    const settle = (
      id: string,
      result: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string },
    ): void => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      controller.signal.removeEventListener('abort', p.onAbort);
      p.resolve(result);
    };

    const canUseTool =
      permissionMode === 'bypassPermissions'
        ? undefined
        : async (
            toolName: string,
            input: Record<string, unknown>,
            ctx: { signal: AbortSignal; title?: string; displayName?: string; description?: string; toolUseID?: string },
          ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }> => {
            if (classifyTool(toolName) === 'auto-allow') return { behavior: 'allow' };
            if (controller.signal.aborted) return { behavior: 'deny', message: 'run stopped' };
            const id = ctx.toolUseID ?? `perm-${++permCounter}`;
            pushEvent({
              type: 'permission_request',
              id,
              toolName,
              input,
              title: ctx.title,
              displayName: ctx.displayName,
              description: ctx.description,
            });
            return new Promise((resolve) => {
              const onAbort = (): void => settle(id, { behavior: 'deny', message: 'run stopped' });
              const timer = setTimeout(
                () => settle(id, { behavior: 'deny', message: 'approval timed out' }),
                this.permissionTimeoutMs,
              );
              controller.signal.addEventListener('abort', onAbort);
              pending.set(id, { resolve, timer, onAbort });
            });
          };
    if (canUseTool) options.canUseTool = canUseTool;

    const q = this.queryFn({ prompt: opts.prompt, options });
    let finished = false;
    const exitWaiters = new Set<() => void>();
    const markFinished = (): void => {
      finished = true;
      for (const w of [...exitWaiters]) w();
    };

    // Drain the SDK stream into the shared queue.
    void (async () => {
      let sawTerminal = false;
      try {
        for await (const msg of q) {
          for (const evt of translateSdkMessage(msg)) {
            if (evt.type === 'done' || evt.type === 'error') sawTerminal = true;
            pushEvent(evt);
          }
        }
      } catch (err) {
        if (!sawTerminal) {
          sawTerminal = true;
          pushEvent({
            type: 'error',
            message: `claude sdk error: ${err instanceof Error ? err.message : String(err)}`,
            terminationReason: controller.signal.aborted ? 'interrupted' : 'failed',
          });
        }
      } finally {
        if (!sawTerminal) {
          pushEvent(
            controller.signal.aborted
              ? { type: 'error', message: 'claude run interrupted', terminationReason: 'interrupted' }
              : { type: 'done', terminationReason: 'normal' },
          );
        }
        // Force-resolve any parked permission so canUseTool callers unblock.
        for (const id of [...pending.keys()]) settle(id, { behavior: 'deny', message: 'run ended' });
        markFinished();
        closeQueue();
      }
    })();

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      let i = 0;
      for (;;) {
        if (i < queue.length) {
          yield queue[i++]!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
        });
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
      respondPermission(id, decision, respOpts) {
        settle(
          id,
          decision === 'allow'
            ? { behavior: 'allow', updatedInput: respOpts?.updatedInput }
            : { behavior: 'deny', message: respOpts?.message ?? 'denied by user' },
        );
      },
    };
  }
}
