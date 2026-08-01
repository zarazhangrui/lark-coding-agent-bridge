import { isAbsolute } from 'node:path';
import { resolveWorkingDirectory } from '../../policy/workspace';
import {
  compactTaskForOutput,
  conversationMessages,
} from '../../codex-task/controller';
import { initializeControllerWorkspace } from '../../codex-task/workspace';
import { resolveCodexTaskContext } from '../../codex-task/context';

interface CodexTaskCommandBaseOptions {
  config?: string;
  profile?: string;
  rootDir?: string;
}

export interface CodexTaskInitOptions extends CodexTaskCommandBaseOptions {
  workspace?: string;
  force?: boolean;
  json?: boolean;
}

export interface CodexTaskListOptions extends CodexTaskCommandBaseOptions {
  json?: boolean;
}

export interface CodexTaskCreateOptions extends CodexTaskCommandBaseOptions {
  title: string;
  cwd: string;
  model?: string;
  message?: string;
  json?: boolean;
  signal?: AbortSignal;
}

export interface CodexTaskReadOptions extends CodexTaskCommandBaseOptions {
  json?: boolean;
  limit?: string;
}

export interface CodexTaskSendOptions extends CodexTaskCommandBaseOptions {
  message: string;
  model?: string;
  json?: boolean;
  signal?: AbortSignal;
}

export async function runCodexTaskInit(options: CodexTaskInitOptions): Promise<void> {
  const context = await resolveCodexTaskContext(options);
  const configured = context.profileConfig.workspaces.default;
  if (!configured) {
    throw new Error('controller workspace is not configured in profiles.<name>.workspaces.default');
  }
  const workspace = await resolveWorkingDirectory(configured);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  if (options.workspace) {
    const explicit = await resolveWorkingDirectory(options.workspace);
    if (!explicit.ok) throw new Error(explicit.userVisible);
    if (explicit.cwdRealpath !== workspace.cwdRealpath) {
      throw new Error('--workspace must match the profile default workspace; update the profile first');
    }
  }
  const result = await initializeControllerWorkspace({
    workspace: workspace.cwdRealpath,
    force: options.force,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`✓ controller workspace: ${result.workspace}`);
  for (const path of result.created) console.log(`  created ${path}`);
  for (const path of result.skipped) console.log(`  kept    ${path}`);
}

export async function runCodexTaskList(options: CodexTaskListOptions): Promise<void> {
  const { controller } = await resolveCodexTaskContext(options);
  const tasks = await controller.list();
  if (options.json) {
    printJson(tasks.map(compactTaskForOutput));
    return;
  }
  if (tasks.length === 0) {
    console.log('暂无已注册的 Codex worker task。');
    return;
  }
  for (const task of tasks) {
    console.log([
      task.handle,
      task.status,
      task.model ?? 'default',
      task.cwd,
      task.title,
    ].join('\t'));
  }
}

export async function runCodexTaskCreate(options: CodexTaskCreateOptions): Promise<void> {
  return withCodexTaskSignals(options.signal, (signal) => runCodexTaskCreateInternal(options, signal));
}

async function runCodexTaskCreateInternal(
  options: CodexTaskCreateOptions,
  signal: AbortSignal,
): Promise<void> {
  const { controller } = await resolveCodexTaskContext(options);
  if (!isAbsolute(options.cwd)) throw new Error('--cwd must be an absolute path');
  const workspace = await resolveWorkingDirectory(options.cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const result = await controller.create({
    title: options.title,
    cwd: workspace.cwdRealpath,
    ...(options.model ? { model: options.model } : {}),
    ...(options.message ? { message: options.message } : {}),
    signal,
  });
  if ('output' in result) {
    const payload = {
      task: compactTaskForOutput(result.task),
      output: result.output,
      terminationReason: result.terminationReason,
      registrySync: result.registrySync,
      ...(result.registryError ? { registryError: result.registryError } : {}),
    };
    setExecutionExitCode(result.terminationReason);
    if (options.json) printJson(payload);
    else printExecution(payload);
    return;
  }
  const task = compactTaskForOutput(result);
  if (options.json) printJson(task);
  else {
    console.log(`✓ ${task.handle} ${task.title}`);
    console.log(`  status: ${task.status}`);
    console.log(`  cwd: ${task.cwd}`);
    console.log(`  model: ${task.model ?? 'default'}`);
    if (task.status === 'pending') {
      console.log('  thread: pending until the first codex-task send');
    }
  }
}

export async function runCodexTaskRead(handle: string, options: CodexTaskReadOptions): Promise<void> {
  const limit = parseLimit(options.limit);
  const { controller } = await resolveCodexTaskContext(options);
  const result = await controller.read(handle, true);
  const messages = conversationMessages(result.thread, limit);
  const turns = Array.isArray(result.thread.turns) ? result.thread.turns : [];
  const lastTurn = turns.length > 0 && turns.at(-1) && typeof turns.at(-1) === 'object'
    ? turns.at(-1) as Record<string, unknown>
    : undefined;
  const payload = {
    task: compactTaskForOutput(result.task),
    runtimeStatus: result.thread.status ?? null,
    lastTurnStatus: lastTurn?.status ?? null,
    thread: {
      name: result.thread.name ?? result.task.title,
      cwd: result.thread.cwd ?? result.task.cwd,
      preview: result.thread.preview ?? null,
      createdAt: result.thread.createdAt ?? null,
      updatedAt: result.thread.updatedAt ?? null,
      modelProvider: result.thread.modelProvider ?? null,
    },
    messages,
  };
  if (options.json) {
    printJson(payload);
    return;
  }
  console.log(`${payload.task.handle} ${payload.task.title}`);
  console.log(`cwd: ${payload.task.cwd}`);
  console.log(`model: ${payload.task.model ?? 'default'}`);
  console.log(`runtime status: ${JSON.stringify(payload.runtimeStatus)}`);
  console.log(`last turn status: ${String(payload.lastTurnStatus ?? 'none')}`);
  if (payload.messages.length === 0) console.log('(尚无 agent 回复)');
  for (const message of payload.messages) console.log(`\n${message.role}: ${message.text}`);
}

export async function runCodexTaskSend(
  handle: string,
  options: CodexTaskSendOptions,
): Promise<void> {
  return withCodexTaskSignals(
    options.signal,
    (signal) => runCodexTaskSendInternal(handle, options, signal),
  );
}

async function runCodexTaskSendInternal(
  handle: string,
  options: CodexTaskSendOptions,
  signal: AbortSignal,
): Promise<void> {
  const { controller } = await resolveCodexTaskContext(options);
  const result = await controller.send(handle, {
    message: options.message,
    ...(options.model ? { model: options.model } : {}),
    signal,
  });
  const payload = {
    task: compactTaskForOutput(result.task),
    output: result.output,
    terminationReason: result.terminationReason,
    registrySync: result.registrySync,
    ...(result.registryError ? { registryError: result.registryError } : {}),
  };
  setExecutionExitCode(result.terminationReason);
  if (options.json) printJson(payload);
  else printExecution(payload);
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 5;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error('--limit must be an integer between 1 and 50');
  }
  return parsed;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printExecution(payload: {
  task: ReturnType<typeof compactTaskForOutput>;
  output: string;
  terminationReason: string;
  registrySync: 'synced' | 'pending';
  registryError?: string;
}): void {
  const marker = payload.terminationReason === 'normal' ? '✓' : '✗';
  console.log(`${marker} ${payload.task.handle} ${payload.task.title}`);
  console.log(`  status: ${payload.task.status}`);
  console.log(`  cwd: ${payload.task.cwd}`);
  console.log(`  model: ${payload.task.model ?? 'default'}`);
  console.log(`  termination: ${payload.terminationReason}`);
  if (payload.registrySync === 'pending') {
    console.error(`  registry: pending reconciliation (${payload.registryError ?? 'unknown error'})`);
  }
  if (payload.output) console.log(`\n${payload.output}`);
}

function setExecutionExitCode(terminationReason: string): void {
  if (terminationReason === 'normal') return;
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
}

async function withCodexTaskSignals<T>(
  providedSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (providedSignal) return operation(providedSignal);

  const abort = new AbortController();
  const interrupt = (exitCode: number): void => {
    if (abort.signal.aborted) return;
    process.exitCode = exitCode;
    abort.abort();
  };
  const onSigint = (): void => interrupt(130);
  const onSigterm = (): void => interrupt(143);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    return await operation(abort.signal);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
