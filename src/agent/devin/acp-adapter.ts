import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { AcpClient, type JsonRpcNotification, type JsonRpcRequest } from './acp-client';

/**
 * Phase B adapter for the Devin CLI — uses the Agent Client Protocol (ACP)
 * over stdio (JSON-RPC 2.0 / NDJSON) instead of `devin -p`.
 *
 * Advantages over Phase A (`devin -p`):
 *   - Structured tool_call / tool_call_update events → real tool chips in
 *     the Lark card
 *   - Session resume via `session/load` (when the agent supports it)
 *   - Permission auto-approval via `session/request_permission` response
 *   - Agent message chunks stream as text deltas (same as Phase A)
 *
 * @see https://agentclientprotocol.com/protocol/v1/overview
 */
export interface DevinAcpAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /** When true, auto-approve all tool permission requests. Default: true. */
  autoApprovePermissions?: boolean;
}

type DevinChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

// ── ACP protocol types (subset we use) ──────────────────────────────────

interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  };
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: unknown[];
}

interface AcpSessionNewResult {
  sessionId: string;
}

type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

interface AcpSessionPromptResult {
  stopReason: AcpStopReason;
}

type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; image?: { url?: string; data?: string; mimeType?: string } }
  | { type: 'resource'; resource?: { uri?: string; text?: string; mimeType?: string } }
  | { type: 'resource_link'; resource_link?: { uri?: string } };

interface AcpSessionUpdate {
  sessionUpdate: string;
  // agent_message_chunk / user_message_chunk
  messageId?: string;
  content?: AcpContentBlock;
  // tool_call
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  content_array?: unknown[];
  content_list?: unknown[];
  // tool_call_update
  // plan
  entries?: unknown[];
  // usage_update
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string };
}

interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

// ── Adapter ─────────────────────────────────────────────────────────────

export class DevinAcpAdapter implements AgentAdapter {
  readonly id = 'devin';
  readonly displayName = 'Devin CLI (ACP)';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly autoApprove: boolean;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: DevinAcpAdapterOptions = {}) {
    this.binary = opts.binary ?? 'devin';
    this.larkChannel = opts.larkChannel;
    this.autoApprove = opts.autoApprovePermissions !== false;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'devin',
      agentName: 'Devin CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for DevinAcpAdapter.run');
    }

    const child = spawnProcess(this.binary, ['acp'], {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as DevinChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      protocol: 'acp',
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    let runtimeError: Error | null = null;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn devin: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal, protocol: 'acp' });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createAcpEventStream(child, opts, () => runtimeError, this.autoApprove, stderrChunks),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop', { pid: child.pid ?? null, graceMs: stopGraceMs, protocol: 'acp' });
        // On Windows, `child.kill('SIGTERM')` only kills the parent process,
        // not the entire process tree. `devin acp` spawns child processes
        // (MCP servers, etc.) that keep the stdout pipe open, preventing the
        // event loop from exiting. Use `taskkill /T /F` to kill the whole
        // tree. On Unix, SIGTERM → SIGKILL cascade is sufficient.
        if (process.platform === 'win32' && child.pid) {
          await killProcessTreeWindows(child.pid, stopGraceMs);
        } else {
          child.kill('SIGTERM');
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                log.warn('agent', 'stop-sigkill', { pid: child.pid ?? null, graceMs: stopGraceMs });
                child.kill('SIGKILL');
              }
              resolve();
            }, stopGraceMs);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
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
}

// ── Event stream: ACP → AgentEvent ──────────────────────────────────────

async function* createAcpEventStream(
  child: DevinChild,
  opts: AgentRunOptions,
  getError: () => Error | null,
  autoApprove: boolean,
  stderrChunks: Buffer[] = [],
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn devin: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const client = new AcpClient(child.stdin, child.stdout, child);

  // Collect events from ACP notifications into a queue
  const eventQueue: AgentEvent[] = [];
  let resolveEvent: (() => void) | null = null;
  let promptDone = false;
  const promptErrorRef: { error: Error | null } = { error: null };
  let finalText = '';

  function enqueue(evt: AgentEvent): void {
    eventQueue.push(evt);
    resolveEvent?.();
    resolveEvent = null;
  }

  // Track tool calls for status mapping
  const toolCalls = new Map<string, { name: string; status: string }>();

  // Handle Agent → Client notifications (session/update)
  client.on('notification', (msg: JsonRpcNotification) => {
    if (msg.method !== 'session/update') return;
    const params = msg.params as { sessionId?: string; update?: AcpSessionUpdate } | undefined;
    const update = params?.update;
    if (!update) return;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : '';
        if (text) {
          finalText += text;
          enqueue({ type: 'text', delta: text });
        }
        break;
      }

      case 'user_message_chunk':
        // Ignore — this is the user's own message echoed back
        break;

      case 'tool_call': {
        const toolCallId = update.toolCallId ?? '';
        const title = update.title ?? 'tool';
        const kind = update.kind ?? 'other';
        const status = update.status ?? 'pending';
        toolCalls.set(toolCallId, { name: `${title} (${kind})`, status });
        enqueue({
          type: 'tool_use',
          id: toolCallId,
          name: title,
          input: { kind, status },
        });
        break;
      }

      case 'tool_call_update': {
        const toolCallId = update.toolCallId ?? '';
        const prev = toolCalls.get(toolCallId);
        const status = update.status ?? prev?.status ?? 'in_progress';
        if (prev) toolCalls.set(toolCallId, { ...prev, status });

        // Extract output text from content
        let output = '';
        const contentArr = extractContentArray(update);
        for (const item of contentArr) {
          if (item && typeof item === 'object') {
            const c = (item as { content?: AcpContentBlock }).content;
            if (c?.type === 'text' && c.text) output += c.text;
          }
        }

        const isError = status === 'failed';
        if (status === 'completed' || status === 'failed') {
          enqueue({
            type: 'tool_result',
            id: toolCallId,
            output: output || status,
            isError,
          });
        }
        break;
      }

      case 'plan':
        // Could emit as thinking/reasoning — skip for now
        break;

      case 'usage_update':
        // Log but don't emit as AgentEvent
        log.info('acp', 'usage', { used: update.used, size: update.size });
        break;
    }
  });

  // Handle Agent → Client requests (session/request_permission)
  client.on('request', (req: JsonRpcRequest) => {
    if (req.method === 'session/request_permission') {
      if (autoApprove) {
        const params = req.params as { options?: AcpPermissionOption[] } | undefined;
        const allowOption = params?.options?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
        client.respond(req.id, {
          outcome: {
            outcome: 'selected',
            ...(allowOption ? { optionId: allowOption.optionId } : {}),
          },
        });
      } else {
        client.respond(req.id, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    // Unknown request — respond with error
    client.respondError(req.id, -32601, `method not found: ${req.method}`);
  });

  client.on('error', (err: Error) => {
    promptErrorRef.error = err;
    resolveEvent?.();
    resolveEvent = null;
  });

  client.on('closed', () => {
    if (!promptDone) {
      promptErrorRef.error = promptErrorRef.error ?? new Error('ACP connection closed before prompt completed');
      resolveEvent?.();
      resolveEvent = null;
    }
  });

  // ── ACP handshake ────────────────────────────────────────────────────

  try {
    // 1. initialize
    const initResult = await client.call<AcpInitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'lark-coding-agent-bridge',
        title: 'Lark Coding Agent Bridge',
        version: '0.5.9',
      },
    });
    log.info('acp', 'initialized', {
      protocolVersion: initResult.protocolVersion,
      agentName: initResult.agentInfo?.name,
      loadSession: initResult.agentCapabilities?.loadSession,
    });

    // 2. session/new or session/load
    let sessionId: string;
    if (opts.sessionId && initResult.agentCapabilities?.loadSession) {
      try {
        await client.call('session/load', {
          sessionId: opts.sessionId,
          cwd: opts.cwd,
          mcpServers: [],
        });
        sessionId = opts.sessionId;
        log.info('acp', 'session-loaded', { sessionId });
      } catch (err) {
        log.warn('acp', 'session-load-failed', { sessionId: opts.sessionId, err: String(err) });
        const newResult = await client.call<AcpSessionNewResult>('session/new', {
          cwd: opts.cwd,
          mcpServers: [],
        });
        sessionId = newResult.sessionId;
      }
    } else {
      const newResult = await client.call<AcpSessionNewResult>('session/new', {
        cwd: opts.cwd,
        mcpServers: [],
      });
      sessionId = newResult.sessionId;
      log.info('acp', 'session-created', { sessionId });
    }

    // Emit a system event so the bridge can record the session ID for
    // resume on the next run (same pattern as Claude's system event).
    enqueue({ type: 'system', sessionId, cwd: opts.cwd });

    // 3. session/prompt (async — we'll await the response while streaming
    //    notifications)
    const promptPromise = client.call<AcpSessionPromptResult>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: opts.prompt }],
      ...(opts.model ? { model: opts.model } : {}),
    });

    // Drain events from the queue while the prompt is running
    promptPromise
      .then((result) => {
        promptDone = true;
        log.info('acp', 'prompt-done', { stopReason: result.stopReason, sessionId });
        if (finalText.trim()) {
          enqueue({ type: 'final_text', content: finalText });
        }
        const terminationReason = mapStopReason(result.stopReason);
        if (terminationReason === 'failed') {
          enqueue({ type: 'error', message: `agent stopped: ${result.stopReason}`, terminationReason });
        } else {
          enqueue({ type: 'done', terminationReason });
        }
        resolveEvent?.();
        resolveEvent = null;
      })
      .catch((err: Error) => {
        promptErrorRef.error = err;
        resolveEvent?.();
        resolveEvent = null;
      });

    // Yield events as they arrive
    while (true) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
        continue;
      }
      if (promptDone && eventQueue.length === 0) break;
      const err = promptErrorRef.error;
      if (err && eventQueue.length === 0) {
        yield {
          type: 'error',
          message: err.message,
          terminationReason: 'failed',
        };
        break;
      }
      // Wait for more events
      await new Promise<void>((resolve) => {
        resolveEvent = resolve;
        // Safety timeout: if nothing happens for 120s, bail
        setTimeout(() => {
          resolveEvent = null;
          resolve();
        }, 120_000);
      });
    }

    // Clean up: close the session if supported
    try {
      client.notify('session/cancel', { sessionId });
    } catch {
      // best-effort
    }
    client.kill();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    yield {
      type: 'error',
      message: stderr ? `${message}: ${stderr.slice(0, 500)}` : message,
      terminationReason: 'failed',
    };
    client.kill();
  }
}

function mapStopReason(reason: AcpStopReason): 'normal' | 'interrupted' | 'failed' {
  switch (reason) {
    case 'end_turn':
      return 'normal';
    case 'cancelled':
      return 'interrupted';
    case 'refusal':
    case 'max_tokens':
    case 'max_turn_requests':
      return 'failed';
    default:
      return 'normal';
  }
}

function extractContentArray(update: AcpSessionUpdate): unknown[] {
  // ACP spec uses `content` as an array on tool_call_update, but some
  // implementations use `content_list` or `content_array`. Handle all.
  if (Array.isArray(update.content_array)) return update.content_array;
  if (Array.isArray(update.content_list)) return update.content_list;
  if (Array.isArray(update.content)) return [update.content];
  // If content is an object with a nested array, try common shapes
  const c = update.content as unknown as { content?: unknown[] } | undefined;
  if (c && Array.isArray(c.content)) return c.content;
  return [];
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

/**
 * Kill a process and its entire child tree on Windows using `taskkill /T /F`.
 * This is necessary because Node's `child.kill()` only sends a signal to the
 * direct child; `devin acp` spawns subprocesses (MCP servers, etc.) that
 * inherit the stdout pipe and keep the event loop alive even after the
 * parent exits.
 */
function killProcessTreeWindows(pid: number, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    taskkill.on('exit', (code) => {
      log.info('agent', 'taskkill-exit', { pid, code });
      done();
    });
    taskkill.on('error', (err) => {
      log.warn('agent', 'taskkill-error', { pid, err: String(err) });
      done();
    });
    // Safety timeout — don't hang forever
    setTimeout(done, graceMs + 1000);
  });
}

// Re-export for tests
export { AcpClient };
