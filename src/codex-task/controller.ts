import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CodexAppServerAdapter, type CodexAppServerAdapterOptions } from '../agent/codex/app-server-adapter';
import { withCodexAppServerConnection } from '../agent/codex/app-server-client';
import { withConfigFileLock } from '../config/profile-store';
import type { CodexTaskRecord, CodexTaskStatus } from './registry';
import { CodexTaskRegistry } from './registry';

export interface CodexTaskControllerOptions extends CodexAppServerAdapterOptions {
  registry: CodexTaskRegistry;
}

export interface CreateCodexTaskInput {
  title: string;
  cwd: string;
  model?: string;
  message?: string;
}

export interface SendCodexTaskInput {
  message: string;
  model?: string;
}

export interface CodexTaskExecutionResult {
  task: CodexTaskRecord;
  output: string;
  terminationReason: CodexTaskTerminationReason;
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
    return this.options.registry.list();
  }

  async create(input: CreateCodexTaskInput): Promise<CodexTaskRecord | CodexTaskExecutionResult> {
    const title = nonEmpty(input.title, 'title');
    const cwd = nonEmpty(input.cwd, 'cwd');
    const response = recordValue(await withCodexAppServerConnection(
      { ...this.options, cwd },
      async (connection) => {
        const started = await connection.request('thread/start', {
          cwd,
          approvalPolicy: 'never',
          sandbox: this.options.sandbox ?? 'danger-full-access',
          serviceName: 'lark-channel-bridge-task-controller',
          threadSource: 'user',
          ephemeral: false,
          ...(input.model ? { model: input.model } : {}),
        });
        const raw = recordValue(started);
        const threadId = stringValue(recordValue(raw?.thread)?.id);
        if (!threadId) throw new Error('codex app-server returned no thread id');
        await connection.request('thread/name/set', { threadId, name: title });
        return started;
      },
    ));
    const thread = recordValue(response?.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) throw new Error('codex app-server returned no thread id');
    const model = stringValue(response?.model) ?? input.model;
    const task = await this.options.registry.register({
      threadId,
      title,
      cwd,
      ...(model ? { model } : {}),
      status: 'idle',
    });
    if (!input.message?.trim()) return task;
    return this.send(task.handle, { message: input.message, ...(input.model ? { model: input.model } : {}) });
  }

  async read(handle: string, includeTurns = true): Promise<CodexTaskReadResult> {
    const task = await this.requireTask(handle);
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
    const task = await this.requireTask(handle);
    const runLockPath = join(this.options.profileStateDir, 'codex-task-runs', task.handle);
    return withConfigFileLock(runLockPath, async () => {
      const model = input.model ?? task.model;
      await this.options.registry.update(task.handle, {
        status: 'running',
        ...(model ? { model } : {}),
      });
      try {
        const outcome = await this.executeTurn(task, message, model);
        const updated = await this.options.registry.update(task.handle, {
          status: executionStatus(outcome.terminationReason),
          ...(model ? { model } : {}),
          lastResult: truncate(outcome.output, 4_000),
        });
        return {
          task: updated,
          output: outcome.output,
          terminationReason: outcome.terminationReason,
        };
      } catch (err) {
        await this.options.registry.update(task.handle, {
          status: 'failed',
          ...(model ? { model } : {}),
          lastResult: truncate(err instanceof Error ? err.message : String(err), 4_000),
        });
        throw err;
      }
    });
  }

  private async executeTurn(
    task: CodexTaskRecord,
    message: string,
    model: string | undefined,
  ): Promise<{ output: string; terminationReason: CodexTaskTerminationReason }> {
    const adapter = new CodexAppServerAdapter({
      ...this.options,
      ignoreRules: false,
      developerInstructions: WORKER_DEVELOPER_INSTRUCTIONS,
    });
    const runOptions = {
      runId: randomUUID(),
      prompt: message,
      cwd: task.cwd,
      threadId: task.threadId,
      ...(model ? { model } : {}),
      sandbox: this.options.sandbox,
    };
    await adapter.prepareRun(runOptions);
    const run = adapter.run(runOptions);
    let output = '';
    let terminationReason: CodexTaskTerminationReason | undefined;
    let terminalError: string | undefined;
    try {
      for await (const event of run.events) {
        if (event.type === 'final_text') output = event.content;
        if (event.type === 'error') terminalError = event.message;
        if (event.type === 'done') terminationReason = event.terminationReason;
      }
    } finally {
      if (!(await run.waitForExit(2_000))) await run.stop().catch(() => undefined);
    }
    if (terminalError) {
      throw new Error(terminalError);
    }
    if (!terminationReason) {
      throw new Error('Codex turn ended without a terminal event');
    }
    return { output, terminationReason };
  }

  private async requireTask(handle: string): Promise<CodexTaskRecord> {
    const task = await this.options.registry.get(handle);
    if (!task) throw new Error(`Codex task not found: ${handle.trim().toUpperCase()}`);
    return task;
  }
}

function executionStatus(reason: CodexTaskTerminationReason): CodexTaskStatus {
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

export function compactTaskForOutput(task: CodexTaskRecord): Omit<CodexTaskRecord, 'threadId'> {
  const { threadId: _threadId, ...publicTask } = task;
  return publicTask;
}
