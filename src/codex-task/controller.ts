import { randomUUID } from 'node:crypto';
import { CodexAppServerAdapter, type CodexAppServerAdapterOptions } from '../agent/codex/app-server-adapter';
import {
  CodexAppServerRpcError,
  withCodexAppServerConnection,
} from '../agent/codex/app-server-client';
import type { AgentRunOptions } from '../agent/types';
import type { CodexTaskRecord, CodexTaskStatus } from './registry';
import { CodexTaskRegistry } from './registry';

export interface CodexTaskControllerOptions extends CodexAppServerAdapterOptions {
  registry: CodexTaskRegistry;
  /** Stop a worker after this many milliseconds without an agent event. Set to 0 to disable. */
  turnIdleTimeoutMs?: number;
}

export interface CreateCodexTaskInput {
  title: string;
  cwd: string;
  model?: string;
  message?: string;
  signal?: AbortSignal;
}

export interface SendCodexTaskInput {
  message: string;
  model?: string;
  signal?: AbortSignal;
}

export interface CodexTaskExecutionResult {
  task: CodexTaskRecord;
  output: string;
  terminationReason: CodexTaskTerminationReason;
  registrySync: 'synced' | 'pending';
  registryError?: string;
}

export interface CodexTaskReadResult {
  task: CodexTaskRecord;
  thread: Record<string, unknown>;
}

export type CodexTaskTerminationReason = 'normal' | 'interrupted' | 'timeout';

export interface CodexTaskMessage {
  role: 'user' | 'assistant';
  text: string;
}

export class CodexTaskAmbiguousOutcomeError extends Error {
  readonly code = 'codex-task-outcome-ambiguous';

  constructor(readonly handle: string, cause?: unknown) {
    super(
      `Codex task ${handle} recovered a durable thread, but its previous first-turn outcome is ambiguous; `
        + 'inspect it with codex-task read before sending more work',
    );
    this.name = 'CodexTaskAmbiguousOutcomeError';
    this.cause = cause;
  }
}

const DEFAULT_TURN_IDLE_TIMEOUT_MS = 5 * 60_000;

const WORKER_DEVELOPER_INSTRUCTIONS = `You are a persistent Codex worker task managed by lark-channel-bridge.
Work only on the instruction sent to this worker and follow the target repository's AGENTS.md and skills.
Do not manage, create, or send messages to other Codex tasks from this worker.
Do not assume you are replying directly in Feishu; return a concise result for the controller to summarize.`;

export class CodexTaskController {
  private readonly options: CodexTaskControllerOptions;

  constructor(options: CodexTaskControllerOptions) {
    this.options = options;
  }

  list(): Promise<CodexTaskRecord[]> {
    return this.reconciledList();
  }

  async create(input: CreateCodexTaskInput): Promise<CodexTaskRecord | CodexTaskExecutionResult> {
    const title = nonEmpty(input.title, 'title');
    const cwd = nonEmpty(input.cwd, 'cwd');
    const pending = await this.options.registry.reserve({
      title,
      cwd,
      ...(input.model ? { model: input.model } : {}),
    });
    if (!input.message?.trim()) return pending;
    try {
      return await this.send(pending.handle, {
        message: input.message,
        ...(input.model ? { model: input.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      throw new Error(
        `Codex task ${pending.handle} was reserved, but its first turn failed: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }

  async read(handle: string, includeTurns = true): Promise<CodexTaskReadResult> {
    const task = await this.requireDurableTask(handle);
    const result = recordValue(await withCodexAppServerConnection(
      { ...this.options, cwd: task.cwd },
      (connection) => connection.request('thread/read', {
        threadId: task.threadId,
        includeTurns,
      }),
    ));
    const thread = recordValue(result?.thread);
    if (!thread) throw new Error(`codex app-server returned no thread for ${task.handle}`);
    return { task, thread };
  }

  async send(handle: string, input: SendCodexTaskInput): Promise<CodexTaskExecutionResult> {
    const message = nonEmpty(input.message, 'message');
    return this.options.registry.withTaskLock(handle, async () => {
      // Read only after acquiring the execution lock. Otherwise a queued sender
      // can use a model or thread id that a preceding sender has just replaced.
      let task = await this.requireRegisteredTask(handle);
      task = await this.resolveThreadCandidate(task);
      if (task.status === 'running' && !task.threadId) {
        throw new Error(
          `Codex task ${task.handle} was left running without a recoverable thread; `
            + 'refusing to create a replacement that could duplicate work',
        );
      }
      const model = input.model ?? task.model;
      if (input.signal?.aborted) {
        const interrupted = await this.options.registry.update(task.handle, {
          status: 'interrupted',
          ...(input.model ? { model: input.model } : {}),
          lastResult: 'Interrupted before the Codex turn started',
        });
        return {
          task: interrupted,
          output: '',
          terminationReason: 'interrupted',
          registrySync: 'synced',
        };
      }
      const running = await this.options.registry.update(task.handle, {
        status: 'running',
        ...(input.model ? { model: input.model } : {}),
      });

      let durableThreadId = task.threadId;
      let threadImported = Boolean(task.threadId);
      let outcome: Awaited<ReturnType<CodexTaskController['executeTurn']>>;
      try {
        outcome = await this.executeTurn(
          running,
          message,
          model,
          input.signal,
          async (threadId) => {
            await this.options.registry.setThreadCandidate(task.handle, threadId);
          },
          async (threadId) => {
            durableThreadId = threadId;
            if (task.threadId) {
              if (task.threadId !== threadId) {
                throw new Error(`codex app-server resumed an unexpected thread: ${threadId}`);
              }
              return;
            }
            await this.options.registry.importThread(task.handle, threadId);
            threadImported = true;
          },
        );
        durableThreadId = outcome.threadId ?? durableThreadId;
      } catch (err) {
        const messageText = errorMessage(err);
        const lastResult = truncate(messageText, 4_000);
        const desiredStatus = input.signal?.aborted ? 'interrupted' : 'failed';
        let registryFailure: string | undefined;

        if (durableThreadId && !threadImported) {
          try {
            await this.options.registry.markReconcile(task.handle, {
              desiredStatus,
              error: messageText,
              threadId: durableThreadId,
              lastResult,
            });
          } catch (recoveryErr) {
            registryFailure = errorMessage(recoveryErr);
          }
        } else {
          try {
            await this.options.registry.update(task.handle, {
              status: desiredStatus,
              ...(input.model ? { model: input.model } : {}),
              lastResult,
            });
          } catch (updateErr) {
            const updateMessage = errorMessage(updateErr);
            try {
              await this.options.registry.markReconcile(task.handle, {
                desiredStatus,
                error: updateMessage,
                ...(durableThreadId ? { threadId: durableThreadId } : {}),
                lastResult,
              });
            } catch (recoveryErr) {
              registryFailure = `${updateMessage}; recovery record failed: ${errorMessage(recoveryErr)}`;
            }
          }
        }

        if (registryFailure) {
          throw new Error(
            `${messageText}; registry failure state was not persisted: ${registryFailure}`,
            { cause: err },
          );
        }
        throw err;
      }

      const status = executionStatus(outcome.terminationReason);
      const lastResult = truncate(outcome.output, 4_000);
      try {
        const updated = await this.options.registry.update(task.handle, {
          status,
          ...(input.model ? { model: input.model } : {}),
          lastResult,
        });
        return {
          task: updated,
          output: outcome.output,
          terminationReason: outcome.terminationReason,
          registrySync: 'synced',
        };
      } catch (registryErr) {
        const registryError = errorMessage(registryErr);
        const lastTurnId = outcome.threadId
          ? await this.readLatestTurnId({ ...task, threadId: outcome.threadId }).catch(() => undefined)
          : undefined;
        let recoveryError: string | undefined;
        try {
          await this.options.registry.markReconcile(task.handle, {
            desiredStatus: status,
            error: registryError,
            ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
            ...(lastTurnId ? { lastTurnId } : {}),
            lastResult,
          });
        } catch (err) {
          recoveryError = errorMessage(err);
        }
        return {
          task: {
            ...running,
            ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
            status,
            lastResult,
            ...(lastTurnId ? { lastTurnId } : {}),
          },
          output: outcome.output,
          terminationReason: outcome.terminationReason,
          registrySync: 'pending',
          registryError: recoveryError
            ? `${registryError}; recovery record failed: ${recoveryError}`
            : registryError,
        };
      }
    });
  }

  private async executeTurn(
    task: CodexTaskRecord,
    message: string,
    model: string | undefined,
    signal: AbortSignal | undefined,
    onThreadCandidate: (threadId: string) => Promise<void>,
    onThreadReady: (threadId: string) => Promise<void>,
  ): Promise<{
    output: string;
    terminationReason: CodexTaskTerminationReason;
    threadId?: string;
  }> {
    let refreshActivity = (): void => {};
    const inheritedActivity = this.options.onActivity;
    const inheritedThreadCandidate = this.options.onThreadCandidate;
    const adapter = new CodexAppServerAdapter({
      ...this.options,
      ignoreRules: false,
      developerInstructions: WORKER_DEVELOPER_INSTRUCTIONS,
      onActivity: () => {
        try {
          inheritedActivity?.();
        } finally {
          refreshActivity();
        }
      },
      onThreadCandidate: async (threadId) => {
        await onThreadCandidate(threadId);
        await inheritedThreadCandidate?.(threadId);
      },
    });
    const runOptions: AgentRunOptions = {
      runId: randomUUID(),
      prompt: message,
      cwd: task.cwd,
      threadName: task.title,
      ...(task.threadId ? { threadId: task.threadId } : {}),
      ...(model ? { model } : {}),
      sandbox: this.options.sandbox,
    };
    try {
      await adapter.prepareRun(runOptions);
    } catch (err) {
      if (signal?.aborted) {
        return { output: '', terminationReason: 'interrupted' };
      }
      throw err;
    }
    if (signal?.aborted) {
      adapter.discardPreparedRun(runOptions);
      return { output: '', terminationReason: 'interrupted' };
    }
    const run = adapter.run(runOptions);
    const idleTimeoutMs = this.options.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let stopPromise: Promise<void> | undefined;
    let stopReason: Extract<CodexTaskTerminationReason, 'interrupted' | 'timeout'> | undefined;
    let terminalObserved = false;
    let output = '';
    let streamedOutput = '';
    let threadId = task.threadId;
    let threadReadyHandled = Boolean(task.threadId);
    let terminationReason: CodexTaskTerminationReason | undefined;
    let terminalError: string | undefined;

    const clearIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const requestStop = (
      reason: Extract<CodexTaskTerminationReason, 'interrupted' | 'timeout'>,
    ): void => {
      if (terminalObserved || stopReason) return;
      stopReason = reason;
      stopPromise = run.stop();
      void stopPromise.catch(() => undefined);
    };
    const armIdleTimer = (): void => {
      clearIdleTimer();
      if (idleTimeoutMs <= 0 || stopReason) return;
      idleTimer = setTimeout(() => requestStop('timeout'), idleTimeoutMs);
      idleTimer.unref?.();
    };
    refreshActivity = armIdleTimer;
    const abortTurn = (): void => requestStop('interrupted');
    signal?.addEventListener('abort', abortTurn, { once: true });
    if (signal?.aborted) abortTurn();
    armIdleTimer();

    try {
      for await (const event of run.events) {
        if (event.type === 'done' || event.type === 'error') {
          terminalObserved = true;
          clearIdleTimer();
        } else {
          armIdleTimer();
        }

        if (event.type === 'system' && event.threadId) {
          if (threadId && threadId !== event.threadId) {
            throw new Error(`codex app-server returned an unexpected thread: ${event.threadId}`);
          }
          threadId = event.threadId;
          if (!threadReadyHandled) {
            threadReadyHandled = true;
            clearIdleTimer();
            await onThreadReady(event.threadId);
            armIdleTimer();
          }
        }
        if (event.type === 'text') streamedOutput += event.delta;
        if (event.type === 'final_text') output = event.content;
        if (event.type === 'done') terminationReason = event.terminationReason;
        if (event.type === 'error') {
          if (event.terminationReason === 'failed') terminalError = event.message;
          else terminationReason = event.terminationReason;
        }
      }
    } finally {
      terminalObserved = true;
      refreshActivity = (): void => {};
      signal?.removeEventListener('abort', abortTurn);
      clearIdleTimer();
      if (stopPromise) await stopPromise.catch(() => undefined);
      if (!(await run.waitForExit(2_000))) await run.stop().catch(() => undefined);
    }

    const finalOutput = output || streamedOutput;
    if (stopReason) {
      return {
        output: finalOutput,
        terminationReason: stopReason,
        ...(threadId ? { threadId } : {}),
      };
    }
    if (terminalError) throw new Error(terminalError);
    if (!terminationReason) throw new Error('Codex turn ended without a terminal event');
    if (!threadId) throw new Error('Codex turn ended without a durable thread id');
    return { output: finalOutput, terminationReason, threadId };
  }

  private async readLatestTurnId(task: CodexTaskRecord & { threadId: string }): Promise<string | undefined> {
    const result = recordValue(await withCodexAppServerConnection(
      { ...this.options, cwd: task.cwd },
      (connection) => connection.request('thread/read', {
        threadId: task.threadId,
        includeTurns: true,
      }),
    ));
    const thread = recordValue(result?.thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    return stringValue(recordValue(turns.at(-1))?.id);
  }

  private async resolveThreadCandidate(task: CodexTaskRecord): Promise<CodexTaskRecord> {
    const candidate = task.candidateThreadId;
    if (!candidate) return task;

    try {
      const result = recordValue(await withCodexAppServerConnection(
        { ...this.options, cwd: task.cwd },
        (connection) => connection.request('thread/read', {
          threadId: candidate,
          includeTurns: true,
        }),
      ));
      if (!recordValue(result?.thread)) {
        throw new Error('codex app-server returned no thread while verifying the candidate');
      }
    } catch (err) {
      if (isExplicitMissingThread(err)) {
        return this.options.registry.clearThreadCandidate(task.handle, candidate, {
          status: 'failed',
          lastResult: 'The previous thread candidate was not durable; materialization may be retried',
        });
      }
      throw new Error(
        `Codex task ${task.handle} has an unresolved thread candidate; `
          + `refusing to start a replacement turn (${candidateVerificationError(err)})`,
        { cause: err },
      );
    }

    const ambiguous = new CodexTaskAmbiguousOutcomeError(task.handle);
    try {
      await this.options.registry.importThread(task.handle, candidate, {
        status: 'failed',
        lastResult: truncate(ambiguous.message, 4_000),
      });
    } catch (err) {
      throw new Error(
        `Codex task ${task.handle} has a durable but unresolved thread candidate; `
          + `refusing to continue (${candidateVerificationError(err)})`,
        { cause: err },
      );
    }
    throw ambiguous;
  }

  private async reconciledList(): Promise<CodexTaskRecord[]> {
    await this.options.registry.reconcile();
    return this.options.registry.list();
  }

  private async requireRegisteredTask(handle: string): Promise<CodexTaskRecord> {
    await this.options.registry.reconcile(handle);
    const task = await this.options.registry.get(handle);
    if (!task) throw new Error(`Codex task not found: ${handle.trim().toUpperCase()}`);
    return task;
  }

  private async requireDurableTask(handle: string): Promise<CodexTaskRecord & { threadId: string }> {
    const task = await this.requireRegisteredTask(handle);
    if (!task.threadId) {
      if (task.candidateThreadId) {
        throw new Error(
          `Codex task ${task.handle} has an unresolved first-turn outcome; `
            + 'send is required to verify its private thread candidate before reading',
        );
      }
      if (task.status === 'pending') {
        throw new Error(
          `Codex task ${task.handle} is pending; send its first message to create a durable thread`,
        );
      }
      throw new Error(
        `Codex task ${task.handle} has no durable thread (status: ${task.status}); `
          + (task.status === 'running'
            ? 'refusing automatic retry because it could duplicate work'
            : 'send a message to retry materialization'),
      );
    }
    return { ...task, threadId: task.threadId };
  }
}

function executionStatus(
  reason: CodexTaskTerminationReason,
): Exclude<CodexTaskStatus, 'pending' | 'reconcile' | 'idle' | 'running' | 'failed'> {
  if (reason === 'normal') return 'completed';
  return reason;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isExplicitMissingThread(err: unknown): boolean {
  return err instanceof CodexAppServerRpcError
    && err.method === 'thread/read'
    && err.code === -32600
    && err.message.startsWith('thread not loaded:');
}

function candidateVerificationError(err: unknown): string {
  if (err instanceof CodexAppServerRpcError) {
    return `${err.method} failed with code ${String(err.code ?? 'unknown')}`;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${err.name} (${code})` : err.name;
  }
  return 'unknown verification error';
}

export function finalAgentMessages(thread: Record<string, unknown>, limit = 5): string[] {
  return conversationMessages(thread, Number.MAX_SAFE_INTEGER)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text)
    .slice(-Math.max(1, limit));
}

export function conversationMessages(
  thread: Record<string, unknown>,
  limit = 10,
): CodexTaskMessage[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const messages: CodexTaskMessage[] = [];
  for (const turn of turns) {
    const items = Array.isArray(recordValue(turn)?.items) ? recordValue(turn)?.items as unknown[] : [];
    for (const item of items) {
      const record = recordValue(item);
      if (record?.type === 'agentMessage') {
        const text = stringValue(record.text);
        if (text) messages.push({ role: 'assistant', text });
        continue;
      }
      if (record?.type !== 'userMessage') continue;
      const text = stringValue(record.text) ?? contentText(record.content);
      if (text) messages.push({ role: 'user', text });
    }
  }
  return messages.slice(-Math.max(1, limit));
}

function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.map((item) => stringValue(recordValue(item)?.text)).filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export function compactTaskForOutput(
  task: CodexTaskRecord,
): Omit<CodexTaskRecord, 'threadId' | 'candidateThreadId'> {
  const {
    threadId: _threadId,
    candidateThreadId: _candidateThreadId,
    reconciliation,
    ...publicTask
  } = task;
  if (!reconciliation) return publicTask;
  const { threadId: _recoveryThreadId, ...publicReconciliation } = reconciliation;
  return { ...publicTask, reconciliation: publicReconciliation };
}
