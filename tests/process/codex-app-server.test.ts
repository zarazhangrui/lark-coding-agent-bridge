import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { normalizeUserInputRequest } from '../../src/agent/codex/app-server-normalizer.js';
import type {
  AgentEvent,
  AgentUserInputRequest,
  AgentUserInputResponse,
} from '../../src/agent/types.js';

interface FakeAppServer {
  path: string;
  dir: string;
  recordPath: string;
}

const cleanup: string[] = [];
const originalMode = process.env.FAKE_APP_SERVER_MODE;
const originalUserAgent = process.env.FAKE_APP_SERVER_USER_AGENT;

afterEach(async () => {
  if (originalMode === undefined) delete process.env.FAKE_APP_SERVER_MODE;
  else process.env.FAKE_APP_SERVER_MODE = originalMode;
  if (originalUserAgent === undefined) delete process.env.FAKE_APP_SERVER_USER_AGENT;
  else process.env.FAKE_APP_SERVER_USER_AGENT = originalUserAgent;
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Codex app-server interactive process contract', () => {
  it('maps a fresh IM run, pauses for answers, and continues the original turn', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'interactive';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(cwd, 'question.png');
    const codexHome = join(cwd, 'codex-home');
    const controller = new AbortController();
    const requests: AgentUserInputRequest[] = [];

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      codexHome,
      sandbox: 'read-only',
      ignoreRules: false,
    }).run({
      runId: 'run-interactive',
      prompt: '请继续',
      cwd,
      sandbox: 'workspace-write',
      model: 'gpt-5.6',
      images: [image],
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle(request): Promise<AgentUserInputResponse> {
          requests.push(request);
          return {
            answers: [
              { questionId: 'deploy', value: 'Staging' },
              { questionId: 'note', value: '包含 <特殊> & 字符' },
            ],
          };
        },
      },
    });

    const events = await collect(run.events);
    expect(requests).toEqual([
      {
        id: 'request-item',
        questions: [
          {
            id: 'deploy',
            header: '环境',
            question: '部署到哪里？',
            allowOther: false,
            options: [
              { label: 'Staging', description: '预发布环境' },
              { label: 'Production', description: '生产环境' },
            ],
          },
          {
            id: 'note',
            header: '备注',
            question: '选择或补充说明',
            allowOther: true,
            options: [{ label: 'None', description: '无需备注' }],
          },
        ],
      },
    ]);
    expect(events).toEqual([
      { type: 'system', threadId: 'thread-new', cwd, model: 'gpt-5.6' },
      { type: 'thinking', delta: '正在判断' },
      {
        type: 'tool_use',
        id: 'command-1',
        name: 'command_execution',
        input: { command: 'pwd', cwd },
      },
      { type: 'tool_result', id: 'command-1', output: `${cwd}\n`, isError: false },
      {
        type: 'tool_use',
        id: 'request-item',
        name: 'request_user_input',
        input: requests[0],
      },
      { type: 'tool_result', id: 'request-item', output: '用户已提交回答', isError: false },
      { type: 'text', delta: '正在整理最终答复。' },
      {
        type: 'usage',
        inputTokens: 120,
        outputTokens: 20,
        cachedInputTokens: 40,
        reasoningOutputTokens: 5,
      },
      { type: 'final_text', content: '已按你的选择继续。' },
      { type: 'done', threadId: 'thread-new', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'shell_environment_policy.inherit="all"',
      '-c',
      'features.default_mode_request_user_input=true',
    ]);
    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.env).toEqual({ LARK_CHANNEL: '1', CODEX_HOME: codexHome });
    expect(record.messages.map((message) => message.method ?? `response:${String(message.id)}`)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
      'response:server-request-1',
    ]);
    expect(record.messages[0]?.params).toMatchObject({
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: pkg.version,
      },
      capabilities: { experimentalApi: true },
    });
    expect((record.messages[0]?.params as { capabilities?: unknown }).capabilities).toEqual({
      experimentalApi: true,
    });
    expect(record.messages[2]?.params).toMatchObject({
      cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: 'gpt-5.6',
    });
    const turnParams = record.messages[3]?.params as { input?: unknown[] };
    expect(turnParams.input).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('lark-channel-bridge 运行约定'),
        text_elements: [],
      }),
      { type: 'localImage', path: image },
    ]);
    expect(record.messages[4]?.result).toEqual({
      answers: {
        deploy: { answers: ['Staging'] },
        note: { answers: ['包含 <特殊> & 字符'] },
      },
    });
  });

  it('inherits the adapter sandbox when an interactive run does not override it', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'simple';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const controller = new AbortController();

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
      ignoreRules: false,
    }).run({
      runId: 'run-adapter-sandbox',
      prompt: '使用适配器默认沙箱',
      cwd,
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle() {
          throw new Error('simple 模式不应请求输入');
        },
      },
    });

    expect(await collect(run.events)).toContainEqual({
      type: 'done',
      threadId: 'thread-old',
      terminationReason: 'normal',
    });
    const record = await readRecord(fake.recordPath);
    expect(record.messages[2]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
      },
    });
  });

  it('resumes an existing thread with the same cwd, sandbox, and model overrides', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'simple';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const controller = new AbortController();

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreRules: false,
    }).run({
      runId: 'run-resume',
      prompt: '继续',
      cwd,
      threadId: 'thread-old',
      sandbox: 'read-only',
      model: 'gpt-5.6-mini',
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle() {
          throw new Error('simple 模式不应请求输入');
        },
      },
    });

    expect(await collect(run.events)).toContainEqual({
      type: 'done',
      threadId: 'thread-old',
      terminationReason: 'normal',
    });
    const record = await readRecord(fake.recordPath);
    expect(record.messages[2]).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'thread-old',
        cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        model: 'gpt-5.6-mini',
      },
    });
  });

  it('cancels a pending handler when the server resolves the request itself', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'resolved';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreRules: false,
    }).run({
      runId: 'run-resolved',
      prompt: 'resolve',
      cwd: await realpath(fake.dir),
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        handle(_request, signal) {
          requestSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      },
    });

    const events = await collect(run.events);
    expect(requestSignal?.aborted).toBe(true);
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'request-item',
      output: 'Codex 已结束此输入请求',
      isError: false,
    });
    expect(events.at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-new',
      terminationReason: 'normal',
    });
    const record = await readRecord(fake.recordPath);
    expect(record.messages.some((message) => message.id === 'server-request-1' && !message.method)).toBe(false);
  });

  it('fails malformed or secret questions instead of fabricating a default answer', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'malformed';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const controller = new AbortController();
    let called = false;
    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreRules: false,
    }).run({
      runId: 'run-malformed',
      prompt: 'malformed',
      cwd: await realpath(fake.dir),
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle() {
          called = true;
          return { answers: [{ questionId: 'secret', value: 'unsafe' }] };
        },
      },
    });

    const events = await collect(run.events);
    expect(called).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      terminationReason: 'failed',
      message: expect.stringContaining('不支持 secret 问题'),
    });
  });

  it('interrupts the same app-server turn and aborts its pending input handler on stop', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'wait';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const controller = new AbortController();
    let signalSeen!: (signal: AbortSignal) => void;
    const signalReady = new Promise<AbortSignal>((resolve) => {
      signalSeen = resolve;
    });
    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreRules: false,
      stopGraceMs: 100,
    }).run({
      runId: 'run-stop',
      prompt: 'wait',
      cwd: await realpath(fake.dir),
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        handle(_request, signal) {
          signalSeen(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      },
    });

    const eventsPromise = collect(run.events);
    const requestSignal = await signalReady;
    await run.stop();
    expect(requestSignal.aborted).toBe(true);
    expect(await eventsPromise).toContainEqual({
      type: 'done',
      threadId: 'thread-new',
      terminationReason: 'interrupted',
    });
  });

  it('stops the app-server process when the interactive run signal is aborted', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'wait';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const controller = new AbortController();
    let signalSeen!: (signal: AbortSignal) => void;
    const signalReady = new Promise<AbortSignal>((resolve) => {
      signalSeen = resolve;
    });
    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreRules: false,
      stopGraceMs: 100,
    }).run({
      runId: 'run-signal-abort',
      prompt: 'wait',
      cwd: await realpath(fake.dir),
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        handle(_request, signal) {
          signalSeen(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      },
    });

    const eventsPromise = collect(run.events);
    const requestSignal = await signalReady;
    controller.abort(new Error('caller cancelled interactive run'));
    const events = await eventsPromise;
    const terminalEvents = events.filter((event) => event.type === 'done' || event.type === 'error');

    expect(requestSignal.aborted).toBe(true);
    expect(terminalEvents).toEqual([{
      type: 'done',
      threadId: 'thread-new',
      terminationReason: 'interrupted',
    }]);
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it('aborts a pending input handler when the app-server process exits', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'exit-pending';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreRules: false,
    }).run({
      runId: 'run-exit-pending',
      prompt: 'wait for exit',
      cwd: await realpath(fake.dir),
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        handle(_request, signal) {
          requestSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      },
    });

    const events = await collect(run.events);
    expect(requestSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      terminationReason: 'failed',
      message: expect.stringContaining('app-server 异常退出'),
    });
  });

  it('terminates explicitly when writing the JSON-RPC answer fails', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'write-fail';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const controller = new AbortController();
    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreRules: false,
    }).run({
      runId: 'run-write-fail',
      prompt: 'write fail',
      cwd: await realpath(fake.dir),
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            answers: [
              { questionId: 'deploy', value: 'Staging' },
              { questionId: 'note', value: 'None' },
            ],
          };
        },
      },
    });

    const events = await collect(run.events);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      terminationReason: 'failed',
      message: expect.stringMatching(/EPIPE|stdin 已关闭|处理 Codex 用户输入请求失败/),
    });
  });

  it.each([
    ['0.107 minimum', 'lark-channel-bridge/0.107.0 (Linux; x86_64)'],
    ['0.107 build metadata', 'lark-channel-bridge/0.107.0+vendor.1 (Linux; x86_64)'],
    ['later prerelease', 'codex-cli/0.108.0-alpha.1 (Linux; x86_64)'],
    ['later 0.x', 'lark-channel-bridge/0.250.4 (Linux; x86_64)'],
    ['future major prerelease', 'codex-cli/2.0.0-rc.1 (Linux; x86_64)'],
    ['future major', 'lark-channel-bridge/2.0.0 (Linux; x86_64)'],
    ['non-standard', 'custom app-server build from main'],
  ])('accepts the %s userAgent without a version-specific protocol branch', async (_label, userAgent) => {
    process.env.FAKE_APP_SERVER_MODE = 'simple';
    process.env.FAKE_APP_SERVER_USER_AGENT = userAgent;
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);

    const events = await collect(runFakeAppServer(fake, `run-version-${_label}`).events);

    expect(events.at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-old',
      terminationReason: 'normal',
    });
  });

  it.each([
    ['version below minimum', 'lark-channel-bridge/0.106.9 (Linux; x86_64)'],
    ['version below minimum with build metadata', 'codex-cli/0.106.9+vendor.1 (Linux; x86_64)'],
    ['prerelease of minimum version', 'lark-channel-bridge/0.107.0-alpha.1 (Linux; x86_64)'],
  ])('rejects a parseable Codex app-server %s before starting a thread', async (_label, userAgent) => {
    process.env.FAKE_APP_SERVER_MODE = 'simple';
    process.env.FAKE_APP_SERVER_USER_AGENT = userAgent;
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);

    const events = await collect(runFakeAppServer(fake, 'run-version-too-old').events);

    expect(events).toEqual([
      {
        type: 'error',
        message: expect.stringMatching(/0\.107\.0/),
        terminationReason: 'failed',
      },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.messages.map((message) => message.method)).toEqual(['initialize']);
  });

  it('surfaces handshake incompatibility and never falls back to codex exec', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'bad-handshake';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const controller = new AbortController();
    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      ignoreRules: false,
    }).run({
      runId: 'run-old-codex',
      prompt: 'hello',
      cwd: await realpath(fake.dir),
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle() {
          throw new Error('不应请求输入');
        },
      },
    });

    expect(await collect(run.events)).toEqual([
      {
        type: 'error',
        message: expect.stringMatching(/Codex CLI.*0\.107\.0/),
        terminationReason: 'failed',
      },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv[0]).toBe('app-server');
    expect(record.argv).not.toContain('exec');
  });

  it.each([
    ['thread/start', 'thread-error', '线程设置无效'],
    ['turn/start', 'turn-error', 'turn 启动失败'],
  ])('reports a %s failure as an execution error rather than an upgrade error', async (
    _stage,
    mode,
    expectedMessage,
  ) => {
    process.env.FAKE_APP_SERVER_MODE = mode;
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);

    const events = await collect(runFakeAppServer(fake, `run-${mode}`).events);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining(expectedMessage),
      terminationReason: 'failed',
    });
    expect(events.at(-1)).not.toMatchObject({
      message: expect.stringContaining('请升级'),
    });
  });

  it.each([
    ['initialize', 'hold-initialize'],
    ['thread/start', 'hold-thread'],
    ['turn/start', 'hold-turn'],
  ])('emits exactly one interrupted terminal event when stopped during %s', async (method, mode) => {
    process.env.FAKE_APP_SERVER_MODE = mode;
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const run = runFakeAppServer(fake, `run-stop-${mode}`, 100);
    const eventsPromise = collect(run.events);
    await waitForRecordedMethod(fake.recordPath, method);

    await run.stop();
    const terminalEvents = (await eventsPromise).filter(
      (event) => event.type === 'done' || event.type === 'error',
    );

    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      type: 'done',
      terminationReason: 'interrupted',
    });
  });

  it.each([
    ['missing threadId', 'context-missing-thread'],
    ['mismatched threadId', 'context-wrong-thread'],
    ['missing turnId', 'context-missing-turn'],
    ['mismatched turnId', 'context-wrong-turn'],
  ])('rejects a request_user_input with %s', async (_label, mode) => {
    process.env.FAKE_APP_SERVER_MODE = mode;
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    let called = false;

    const events = await collect(runFakeAppServer(fake, `run-${mode}`, undefined, () => {
      called = true;
      return Promise.resolve({ answers: [{ questionId: 'deploy', value: 'Staging' }] });
    }).events);

    expect(called).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('thread/turn 上下文不合法'),
      terminationReason: 'failed',
    });
  });

  it.each([
    ['missing threadId', 'completed-missing-thread'],
    ['mismatched threadId', 'completed-wrong-thread'],
    ['missing turn id', 'completed-missing-turn'],
    ['mismatched turn id', 'completed-wrong-turn'],
  ])('rejects turn/completed with %s', async (_label, mode) => {
    process.env.FAKE_APP_SERVER_MODE = mode;
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);

    const events = await collect(runFakeAppServer(fake, `run-${mode}`).events);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('turn/completed 的 thread/turn 上下文不合法'),
      terminationReason: 'failed',
    });
  });

  it('rejects serverRequest/resolved from another thread without cancelling the pending handler', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'resolved-wrong-thread';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    let requestSignal: AbortSignal | undefined;

    const events = await collect(runFakeAppServer(
      fake,
      'run-resolved-wrong-thread',
      undefined,
      (_request, signal) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    ).events);

    expect(requestSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('serverRequest/resolved 的 thread/request 上下文不合法'),
      terminationReason: 'failed',
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'tool_result',
      output: 'Codex 已结束此输入请求',
    }));
  });

  it('fails a malformed command completion after opening its tool lifecycle', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'malformed-command-completed';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);

    const events = await collect(runFakeAppServer(fake, 'run-malformed-command-completed').events);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      id: 'command-1',
      name: 'command_execution',
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'tool_result',
      id: 'command-1',
    }));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('item/completed commandExecution 字段不合法'),
      terminationReason: 'failed',
    });
  });

  it('answers an unknown well-formed server request with JSON-RPC method-not-found', async () => {
    process.env.FAKE_APP_SERVER_MODE = 'unknown-request';
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);

    const events = await collect(runFakeAppServer(fake, 'run-unknown-request').events);

    expect(events.at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-new',
      terminationReason: 'normal',
    });
    const record = await readRecord(fake.recordPath);
    expect(record.messages).toContainEqual(expect.objectContaining({
      id: 'future-request-1',
      error: expect.objectContaining({ code: -32601 }),
    }));
  });

  it('fails explicitly when ignoreUserConfig is enabled for an interactive run', async () => {
    const controller = new AbortController();
    const run = new CodexAdapter({
      binary: 'must-not-spawn',
      profileStateDir: tmpdir(),
      ignoreUserConfig: true,
    }).run({
      runId: 'run-ignore-config',
      prompt: 'hello',
      cwd: tmpdir(),
      userInput: {
        kind: 'interactive',
        signal: controller.signal,
        async handle() {
          throw new Error('不应请求输入');
        },
      },
    });

    expect(await collect(run.events)).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('不支持 --ignore-user-config'),
        terminationReason: 'failed',
      },
    ]);
  });
});

describe('request_user_input protocol normalization', () => {
  it('accepts the 0.107 core fields, applies boolean defaults, and ignores later extensions', () => {
    expect(normalizeUserInputRequest({
      ...requestParams([
        {
          id: 'compat',
          header: 'Compatibility',
          question: 'Continue?',
          options: [{ label: 'Yes', description: 'Continue' }],
          arbitraryFutureQuestionField: { ignored: true },
        },
      ]),
      arbitraryFutureRequestField: { futureShape: true },
      anotherFutureRequestField: 'future-format',
      thirdArbitraryFutureField: ['ignored'],
    })).toEqual({
      id: 'request-item',
      questions: [
        {
          id: 'compat',
          header: 'Compatibility',
          question: 'Continue?',
          allowOther: false,
          options: [{ label: 'Yes', description: 'Continue' }],
        },
      ],
    });
  });

  it('rejects duplicate question ids and missing options', () => {
    expect(() => normalizeUserInputRequest(requestParams([
      question('same'),
      question('same'),
    ]))).toThrow(/问题 id 重复/);
    expect(() => normalizeUserInputRequest(requestParams([
      { ...question('missing'), options: null },
    ]))).toThrow(/缺少选项/);
  });

  it('rejects empty fields, duplicate labels, and an empty question set', () => {
    expect(() => normalizeUserInputRequest(requestParams([]))).toThrow(/1 到 3/);
    expect(() => normalizeUserInputRequest(requestParams([
      { ...question('blank'), header: '   ' },
    ]))).toThrow(/字段不完整/);
    expect(() => normalizeUserInputRequest(requestParams([
      {
        ...question('labels'),
        options: [
          { label: 'Same', description: 'A' },
          { label: 'Same', description: 'B' },
        ],
      },
    ]))).toThrow(/选项标签重复/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const output: AgentEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

function runFakeAppServer(
  fake: FakeAppServer,
  runId: string,
  stopGraceMs?: number,
  handle: (
    request: AgentUserInputRequest,
    signal: AbortSignal,
  ) => Promise<AgentUserInputResponse> = async () => {
    throw new Error('此模式不应请求用户输入');
  },
) {
  const controller = new AbortController();
  return new CodexAdapter({
    binary: fake.path,
    profileStateDir: fake.dir,
    ignoreRules: false,
    ...(stopGraceMs === undefined ? {} : { stopGraceMs }),
  }).run({
    runId,
    prompt: 'protocol test',
    cwd: fake.dir,
    userInput: {
      kind: 'interactive',
      signal: controller.signal,
      handle,
    },
  });
}

async function waitForRecordedMethod(path: string, method: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const record = await readRecord(path);
      if (record.messages.some((message) => message.method === method)) return;
    } catch {
      // The child creates the record before it starts consuming stdin.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`未观察到 ${method}`);
}

function question(id: string): Record<string, unknown> {
  return {
    id,
    header: 'Header',
    question: 'Question?',
    isOther: false,
    isSecret: false,
    options: [{ label: 'Yes', description: 'Continue' }],
  };
}

function requestParams(questions: unknown[]): Record<string, unknown> {
  return {
    threadId: 'thread-new',
    turnId: 'turn-1',
    itemId: 'request-item',
    questions,
  };
}

async function createFakeAppServer(): Promise<FakeAppServer> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-test-'));
  const path = join(dir, 'fake-codex-app-server.mjs');
  const recordPath = join(dir, 'app-server-record.json');
  const script = `#!/usr/bin/env node
import { closeSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const recordPath = ${JSON.stringify(recordPath)};
const mode = process.env.FAKE_APP_SERVER_MODE;
const messages = [];
const persist = () => writeFileSync(recordPath, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  messages,
  env: { LARK_CHANNEL: process.env.LARK_CHANNEL, CODEX_HOME: process.env.CODEX_HOME },
}));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const threadId = mode === 'simple' ? 'thread-old' : 'thread-new';
const standardQuestion = {
  threadId,
  turnId: 'turn-1',
  itemId: 'request-item',
  arbitraryFutureRequestField: { ignored: true },
  questions: [
    { id: 'deploy', header: '环境', question: '部署到哪里？', arbitraryFutureQuestionField: 'ignored', options: [
      { label: 'Staging', description: '预发布环境' },
      { label: 'Production', description: '生产环境' },
    ] },
    { id: 'note', header: '备注', question: '选择或补充说明', isOther: true, options: [
      { label: 'None', description: '无需备注' },
    ] },
  ],
};
const complete = () => {
  send({ method: 'item/started', params: { threadId, turnId: 'turn-1', startedAtMs: 1, item: { type: 'agentMessage', id: 'commentary-1', text: '', phase: 'commentary' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: 'commentary-1', delta: '正在整理最终答复。' } });
  send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', completedAtMs: 2, item: { type: 'agentMessage', id: 'commentary-1', text: '正在整理最终答复。', phase: 'commentary' } } });
  send({ method: 'item/started', params: { threadId, turnId: 'turn-1', startedAtMs: 1, item: { type: 'agentMessage', id: 'answer-1', text: '', phase: 'final_answer' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: 'answer-1', delta: '已按你的选择继续。' } });
  send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', completedAtMs: 2, item: { type: 'agentMessage', id: 'answer-1', text: '已按你的选择继续。', phase: 'final_answer' } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn-1', tokenUsage: {
    last: { inputTokens: 120, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 5, totalTokens: 140 },
    total: { inputTokens: 120, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 5, totalTokens: 140 },
  } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', items: [], error: null } } });
};
persist();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  messages.push(message);
  persist();
  if (message.method === 'initialize') {
    if (mode === 'hold-initialize') return;
    if (mode === 'bad-handshake') {
      send({ id: message.id, error: { code: -32601, message: 'method not found' } });
    } else {
      send({ id: message.id, result: { userAgent: process.env.FAKE_APP_SERVER_USER_AGENT || 'lark-channel-bridge/0.107.0 (Linux; x86_64)', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'linux' } });
    }
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (mode === 'hold-thread') return;
    if (mode === 'thread-error') {
      send({ id: message.id, error: { code: -32602, message: '线程设置无效' } });
      return;
    }
    send({ id: message.id, result: { thread: { id: threadId }, model: 'fake', cwd: process.cwd() } });
    return;
  }
  if (message.method === 'turn/start') {
    if (mode === 'hold-turn') return;
    if (mode === 'turn-error') {
      send({ id: message.id, error: { code: -32000, message: 'turn 启动失败' } });
      return;
    }
    send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } });
    if (mode === 'simple') {
      complete();
      return;
    }
    if (mode === 'malformed') {
      send({ method: 'item/tool/requestUserInput', id: 'server-request-1', params: {
        ...standardQuestion,
        questions: [{ id: 'secret', header: 'Secret', question: 'Token?', isOther: false, isSecret: true, options: [{ label: 'A', description: 'A' }] }],
      } });
      return;
    }
    if (mode.startsWith('context-')) {
      const params = { ...standardQuestion };
      if (mode === 'context-missing-thread') delete params.threadId;
      if (mode === 'context-wrong-thread') params.threadId = 'thread-other';
      if (mode === 'context-missing-turn') delete params.turnId;
      if (mode === 'context-wrong-turn') params.turnId = 'turn-other';
      send({ method: 'item/tool/requestUserInput', id: 'server-request-context', params });
      return;
    }
    if (mode === 'unknown-request') {
      send({ method: 'future/unsupported', id: 'future-request-1', params: { future: true } });
      return;
    }
    if (mode.startsWith('completed-')) {
      const params = { threadId, turn: { id: 'turn-1', status: 'completed', items: [], error: null } };
      if (mode === 'completed-missing-thread') delete params.threadId;
      if (mode === 'completed-wrong-thread') params.threadId = 'thread-other';
      if (mode === 'completed-missing-turn') delete params.turn.id;
      if (mode === 'completed-wrong-turn') params.turn.id = 'turn-other';
      send({ method: 'turn/completed', params });
      return;
    }
    if (mode === 'malformed-command-completed') {
      send({ method: 'item/started', params: { threadId, turnId: 'turn-1', item: {
        type: 'commandExecution', id: 'command-1', command: 'pwd', commandActions: [],
        cwd: process.cwd(), status: 'inProgress',
      } } });
      send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: {
        type: 'commandExecution', id: 'command-1', commandActions: [],
        cwd: process.cwd(), status: 'completed',
      } } });
      return;
    }
    send({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0, delta: '正在判断' } });
    send({ method: 'item/started', params: { threadId, turnId: 'turn-1', startedAtMs: 1, item: { type: 'commandExecution', id: 'command-1', command: 'pwd', commandActions: [], cwd: process.cwd(), status: 'inProgress' } } });
    send({ method: 'item/commandExecution/outputDelta', params: { threadId, turnId: 'turn-1', itemId: 'command-1', delta: process.cwd() + '\\n' } });
    send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', completedAtMs: 2, item: { type: 'commandExecution', id: 'command-1', command: 'pwd', commandActions: [], cwd: process.cwd(), status: 'completed', aggregatedOutput: process.cwd() + '\\n', exitCode: 0 } } });
    send({ method: 'item/tool/requestUserInput', id: 'server-request-1', params: standardQuestion });
    if (mode === 'exit-pending') {
      setTimeout(() => process.exit(17), 5);
      return;
    }
    if (mode === 'write-fail') {
      closeSync(0);
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === 'resolved') {
      send({ method: 'serverRequest/resolved', params: { threadId, requestId: 'server-request-1' } });
      setTimeout(complete, 5);
    }
    if (mode === 'resolved-wrong-thread') {
      send({ method: 'serverRequest/resolved', params: { threadId: 'thread-other', requestId: 'server-request-1' } });
    }
    return;
  }
  if (message.id === 'future-request-1' && !message.method) {
    complete();
    return;
  }
  if (message.id === 'server-request-1' && !message.method) complete();
});
process.on('SIGTERM', () => { persist(); process.exit(0); });
`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  env: { LARK_CHANNEL?: string; CODEX_HOME?: string };
  messages: Array<{
    method?: string;
    id?: string | number;
    params?: unknown;
    result?: unknown;
    error?: { code?: number; message?: string };
  }>;
}> {
  const deadline = Date.now() + 1000;
  while (true) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as {
        argv: string[];
        cwd: string;
        env: { LARK_CHANNEL?: string; CODEX_HOME?: string };
        messages: Array<{
          method?: string;
          id?: string | number;
          params?: unknown;
          result?: unknown;
          error?: { code?: number; message?: string };
        }>;
      };
    } catch (error) {
      if (!(error instanceof SyntaxError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
