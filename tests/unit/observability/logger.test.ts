import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeLogger,
  configureLogger,
  flushLogger,
  getLoggerConfig,
  log,
  reportError,
  reportMetric,
} from '../../../src/core/logger.js';
import { loadTelemetryAdapter } from '../../../src/core/telemetry.js';
import { REQUIRED_OBSERVABILITY_EVENTS } from '../../../src/observability/events.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('profile logger observability', () => {
  afterEach(async () => {
    await closeLogger();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('writes profile-local bridge JSONL logs with a 30 day default retention', async () => {
    const tmp = await createTmpProfile('logger-profile-');
    cleanups.push(tmp.cleanup);
    const logsDir = join(tmp.profile, 'logs');

    configureLogger({
      logsDir,
      now: () => new Date('2026-05-25T12:34:56.000Z'),
    });

    log.info('run', 'started', { runId: 'run-1', profile: 'claude', agent: 'claude' });
    await flushLogger();

    expect(getLoggerConfig().retentionDays).toBe(30);
    const text = await readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
    expect(JSON.parse(text.trim())).toMatchObject({
      phase: 'run',
      event: 'started',
      runId: 'run-1',
      profile: 'claude',
      agent: 'claude',
    });
    expect(JSON.parse(text.trim()).ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it('prints topic scope, message id, run, COT, outbound, and fallback context on stdout', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureLogger({ now: () => new Date('2026-05-25T12:34:56.000Z') });

    log.info('intake', 'enter', {
      chatType: 'group',
      chatMode: 'topic',
      scope: 'oc_chat:omt_topic_abcdef',
      sender: 'ou_sender_123456',
      msgId: 'om_msg_654321',
      preview: 'hello',
    });
    log.info('run', 'started', {
      scope: 'oc_chat:omt_topic_abcdef',
      runId: 'run_123456',
      queueWaitMs: 7,
    });
    log.info('run', 'completed', {
      scope: 'oc_chat:omt_topic_abcdef',
      runId: 'run_123456',
      result: 'normal',
      durationMs: 202000,
    });
    log.info('cot', 'created', { cotId: 'cot_123456', messageId: 'om_cot_456789' });
    log.info('outbound', 'sent', {
      type: 'markdown',
      scope: 'oc_chat:omt_topic_abcdef',
      replyTo: 'om_reply_111111',
      messageId: 'om_out_222222',
      replyInThread: true,
    });
    log.warn('outbound', 'markdown-stream-fallback', { err: 'cardid is invalid' });

    expect(out.mock.calls.map((call) => String(call[0]))).toEqual([
      '▸ topic/- scope=abcdef sender=...123456 msg=654321: hello',
      '  ▶ run start scope=abcdef run=123456 queue=7ms',
      '  ✓ run normal scope=abcdef run=123456 duration=3m22s',
      '  ◇ cot created message=456789 cot=123456',
      '  ↗ sent markdown scope=abcdef thread=111111 msg=222222',
    ]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('markdown stream fallback');

    out.mockRestore();
    warn.mockRestore();
  });

  it('redacts raw payloads, tokens, paths, proxy, env, and resource ids before writing local logs', async () => {
    const tmp = await createTmpProfile('logger-redact-');
    cleanups.push(tmp.cleanup);
    const logsDir = join(tmp.profile, 'logs');
    await mkdir(logsDir, { recursive: true });

    configureLogger({
      logsDir,
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    });

    log.warn('agent', 'stderr', {
      prompt: 'raw prompt secret',
      stdout: 'raw stdout secret',
      stderr: 'raw stderr token',
      env: { HTTPS_PROXY: 'http://proxy.local', API_TOKEN: 'token-secret' },
      proxy: 'http://proxy.local',
      chatId: 'oc_1234567890',
      userId: 'ou_1234567890',
      msgId: 'om_1234567890',
      sessionId: 'sess_1234567890',
      threadId: 'thread_1234567890',
      docToken: 'doc_token_secret',
      fileKey: 'file_key_secret',
      sourceFileKey: 'source_file_key_secret',
      sourceMessageId: 'om_source_secret',
      commentId: 'comment_secret',
      replyId: 'reply_secret',
      reactionId: 'reaction_secret',
      scope: 'scope_secret',
      appId: 'cli_secret_app',
      token: 'plain-token-secret',
      attachmentPath: '/tmp/private/media/hash.png',
      cwd: '/opt/private/repo',
      path: '/workspace/private/file.txt',
      apiData: {
        code: 1069307,
        msg: 'permission denied',
        app_secret: 'api-data-secret',
        token: 'api-data-token',
      },
    });
    await flushLogger();

    const text = await readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
    expect(text).not.toContain('raw prompt secret');
    expect(text).not.toContain('raw stdout secret');
    expect(text).not.toContain('raw stderr token');
    expect(text).not.toContain('http://proxy.local');
    expect(text).not.toContain('plain-token-secret');
    expect(text).not.toContain('/tmp/private/media/hash.png');
    expect(text).not.toContain('/opt/private/repo');
    expect(text).not.toContain('/workspace/private/file.txt');
    expect(text).not.toContain('file_key_secret');
    expect(text).not.toContain('api-data-secret');
    expect(text).not.toContain('api-data-token');

    const entry = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(entry.prompt).toBe('[REDACTED]');
    expect(entry.stdout).toBe('[REDACTED]');
    expect(entry.stderr).toBe('[REDACTED]');
    expect(entry.env).toBe('[REDACTED]');
    expect(entry.attachmentPath).toBe('[REDACTED_PATH]');
    expect(entry.cwd).toBe('[REDACTED_PATH]');
    expect(entry.path).toBe('[REDACTED_PATH]');
    expect(entry._chatId).toBe('oc_1234567890');
    expect(entry.sessionId).toBe('sess_1234567890');
    expect(entry.sourceMessageId).toBe('om_source_secret');
    expect(entry.replyId).toBe('reply_secret');
    expect(entry.reactionId).toBe('reaction_secret');
    expect(entry.scope).toBe('scope_secret');
    expect(entry.apiData).toMatchObject({
      code: 1069307,
      msg: 'permission denied',
      app_secret: '[REDACTED]',
      token: '[REDACTED]',
    });
  });

  it('bounds large run trace fields before writing', async () => {
    const tmp = await createTmpProfile('logger-trace-bound-');
    cleanups.push(tmp.cleanup);
    const logsDir = join(tmp.profile, 'logs');

    configureLogger({
      logsDir,
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    });

    log.info('run', 'completed', { runId: 'run-1', trace: 'x'.repeat(6000) });
    await flushLogger();

    const text = await readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
    const entry = JSON.parse(text.trim()) as { trace: string };
    expect(entry.trace.length).toBeLessThan(4200);
    expect(entry.trace).toContain('[truncated]');
  });

  it('sends sanitized events and errors to the optional telemetry adapter', async () => {
    const tmp = await createTmpProfile('logger-telemetry-redact-');
    cleanups.push(tmp.cleanup);
    const logsDir = join(tmp.profile, 'logs');
    const adapterPath = join(tmp.root, 'telemetry-adapter.mjs');
    await writeFile(
      adapterPath,
      `
        globalThis.__bridgeTelemetryEvents = [];
        globalThis.__bridgeTelemetryErrors = [];
        export function createAdapter() {
          return {
            emit(event) { globalThis.__bridgeTelemetryEvents.push(event); },
            recordError(err, ctx) { globalThis.__bridgeTelemetryErrors.push({ err, ctx }); },
            recordMetric() {},
          };
        }
      `,
    );
    process.env.LARK_CHANNEL_TELEMETRY_MODULE = pathToFileURL(adapterPath).href;
    await loadTelemetryAdapter({
      version: 'test',
      appId: 'cli_secret_app',
      tenant: 'feishu',
      hostname: 'host',
    });

    configureLogger({
      logsDir,
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    });

    log.fail('agent', new Error('failed token=raw-token /Users/example/private/repo'), {
      prompt: 'raw prompt secret',
      cwd: '/opt/private/repo',
      chatId: 'oc_1234567890',
      fileKey: 'file_v2_rawsecret',
      sourceFileKey: 'file_v2_sourcesecret',
    });
    reportError(new Error('direct file_v2_errorsecret /Users/example/private/repo'), {
      fileKey: 'file_v2_ctxsecret',
      sourceFileKey: 'file_v2_ctxsourcesecret',
    });
    await flushLogger();

    const globals = globalThis as typeof globalThis & {
      __bridgeTelemetryEvents?: unknown[];
      __bridgeTelemetryErrors?: unknown[];
    };
    const telemetryText = JSON.stringify({
      events: globals.__bridgeTelemetryEvents,
      errors: globals.__bridgeTelemetryErrors,
    });
    expect(telemetryText).not.toContain('raw prompt secret');
    expect(telemetryText).not.toContain('raw-token');
    expect(telemetryText).not.toContain('/Users/example/private/repo');
    expect(telemetryText).not.toContain('/opt/private/repo');
    expect(telemetryText).not.toContain('file_v2_rawsecret');
    expect(telemetryText).not.toContain('file_v2_sourcesecret');
    expect(telemetryText).not.toContain('file_v2_errorsecret');
    expect(telemetryText).not.toContain('file_v2_ctxsecret');
    expect(telemetryText).not.toContain('file_v2_ctxsourcesecret');
    expect(telemetryText).toContain('[REDACTED]');
    expect(telemetryText).toContain('[REDACTED_PATH]');
    expect(telemetryText).toContain('[REDACTED_RESOURCE]');

    delete process.env.LARK_CHANNEL_TELEMETRY_MODULE;
  });

  it('sanitizes optional telemetry metric tags', async () => {
    const tmp = await createTmpProfile('logger-telemetry-metric-');
    cleanups.push(tmp.cleanup);
    const adapterPath = join(tmp.root, 'telemetry-metric-adapter.mjs');
    await writeFile(
      adapterPath,
      `
        globalThis.__bridgeTelemetryMetrics = [];
        export function createAdapter() {
          return {
            emit() {},
            recordError() {},
            recordMetric(name, value, tags) {
              globalThis.__bridgeTelemetryMetrics.push({ name, value, tags });
            },
          };
        }
      `,
    );
    process.env.LARK_CHANNEL_TELEMETRY_MODULE = pathToFileURL(adapterPath).href;
    await loadTelemetryAdapter({
      version: 'test',
      appId: 'cli_secret_app',
      tenant: 'feishu',
      hostname: 'host',
    });

    reportMetric('command_fail', 1, {
      chatId: 'oc_1234567890',
      token: 'raw-token',
      cwd: '/Users/example/private/repo',
      fileKey: 'file_v2_metricsecret',
      sourceFileKey: 'file_v2_metricsourcesecret',
    });

    const globals = globalThis as typeof globalThis & {
      __bridgeTelemetryMetrics?: unknown[];
    };
    const metricsText = JSON.stringify(globals.__bridgeTelemetryMetrics);
    expect(metricsText).not.toContain('oc_1234567890');
    expect(metricsText).not.toContain('raw-token');
    expect(metricsText).not.toContain('/Users/example/private/repo');
    expect(metricsText).not.toContain('file_v2_metricsecret');
    expect(metricsText).not.toContain('file_v2_metricsourcesecret');
    expect(metricsText).toContain('...567890');
    expect(metricsText).toContain('[REDACTED]');
    expect(metricsText).toContain('[REDACTED_PATH]');
    expect(metricsText).toContain('[REDACTED_RESOURCE]');

    delete process.env.LARK_CHANNEL_TELEMETRY_MODULE;
  });

  it('declares the required low-sensitivity event names', () => {
    expect(REQUIRED_OBSERVABILITY_EVENTS).toEqual(
      expect.arrayContaining([
        'run.started',
        'run.completed',
        'run.failed',
        'policy.denied',
        'callback.denied',
        'access.owner_refresh_failed',
        'jsonl.unknown_event',
        'attachment.decision',
        'comment.reply_failed',
      ]),
    );
  });
});
