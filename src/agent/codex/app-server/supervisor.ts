import type { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../../lark-channel-env';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../../platform/spawn';
import { CodexAppServerClient } from './client';
import { log } from '../../../core/logger';
import pkg from '../../../../package.json';

type Child = SpawnedProcessByStdio<Writable, Readable, Readable>;
export interface CodexAppServerSupervisorOptions {
  binary: string; profileStateDir: string; codexHome?: string; inheritCodexHome?: boolean;
  larkChannel?: LarkChannelEnvContext; requestTimeoutMs?: number;
  ignoreUserConfig?: boolean; ignoreRules?: boolean;
  spawn?: typeof spawnProcess;
}

export class CodexAppServerSupervisor extends EventEmitter {
  private child?: Child;
  private current?: CodexAppServerClient;
  private starting?: Promise<CodexAppServerSupervisor>;
  private stopping = false;
  private restartAttempt = 0;
  constructor(private readonly options: CodexAppServerSupervisorOptions) { super(); }

  async start(): Promise<CodexAppServerSupervisor> {
    if (this.current) return this;
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.spawn();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.start();
    return this.current!.request<T>(method, params);
  }

  private async spawn(): Promise<CodexAppServerSupervisor> {
    const overrides = buildLarkChannelEnv(this.options.larkChannel);
    if (this.options.codexHome) overrides.CODEX_HOME = this.options.codexHome;
    else if (this.options.inheritCodexHome === false) overrides.CODEX_HOME = join(this.options.profileStateDir, 'codex-home');
    const child = (this.options.spawn ?? spawnProcess)(this.options.binary, [
      '-c', 'approval_policy="never"',
      '-c', 'shell_environment_policy.inherit="all"',
      ...(this.options.ignoreUserConfig ? ['-c', 'ignore_user_config=true'] : []),
      ...(this.options.ignoreRules === false ? [] : ['-c', 'ignore_rules=true', '-c', 'project_doc_max_bytes=0']),
      'app-server', '--listen', 'stdio://',
    ], {
      env: mergeProcessEnv(process.env, overrides), stdio: ['pipe', 'pipe', 'pipe'],
    }) as Child;
    if (!child.pid) throw new Error('failed to spawn Codex App Server');
    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4096);
      let newline = stderrTail.indexOf('\n');
      while (newline >= 0) {
        const line = redactDiagnostic(stderrTail.slice(0, newline)).slice(0, 500);
        stderrTail = stderrTail.slice(newline + 1);
        if (line.trim()) log.warn('codex-app-server', 'stderr', { line });
        newline = stderrTail.indexOf('\n');
      }
    });
    this.child = child;
    const client = new CodexAppServerClient(child.stdin, child.stdout, this.options.requestTimeoutMs);
    let initialized = false;
    this.current = client;
    client.on('notification', (event) => this.emit('notification', event));
    client.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    });
    child.once('exit', () => {
      client.close(new Error('Codex App Server exited'));
      if (this.current === client) this.current = undefined;
      this.emit('disconnect');
      if (!this.stopping && initialized) {
        const delay = Math.min(10_000, 250 * 2 ** this.restartAttempt++);
        setTimeout(() => { void this.start().catch((error) => this.emit('runtimeError', error)); }, delay).unref();
      }
    });
    try {
      await client.request('initialize', {
        clientInfo: { name: 'lark-channel-bridge', title: 'Lark Channel Bridge', version: pkg.version },
        capabilities: null,
      });
      client.notify('initialized');
      initialized = true;
    } catch (error) {
      client.close(error instanceof Error ? error : new Error(String(error)));
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (this.current === client) this.current = undefined;
      throw error;
    }
    this.restartAttempt = 0;
    this.emit('ready');
    return this;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child; this.current?.close(); this.current = undefined; this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
function redactDiagnostic(value: string): string { return value.replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]'); }
