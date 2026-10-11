import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createTaskRuntime, parseTaskResult } from '../../../src/proactive/task-runtime';
import type { TaskDocuments } from '../../../src/proactive/task-documents';
import type { RunExecutor, SubmitRunInput } from '../../../src/runtime/run-executor';
import type { AgentEvent } from '../../../src/agent/types';
import type { ProactiveTask } from '../../../src/proactive/types';

const data = { status: 'ready', title: '测试', content: '这是一份根据已确认要求生成的文档，包含明确的实施步骤和可检查的验收标准，不包含虚构数字。', sources: [] };
const task: ProactiveTask = { id: 'pt_123456abcdef', chatId: 'chat', threadId: 'thread', sourceMessageId: 'source', ownerId: 'owner', kind: 'draft',
  request: '请帮我起草测试方案', context: [], fingerprint: 'fp', revision: 1, status: 'running', createdAt: 1, updatedAt: 1, artifacts: [] };
async function setup(events: AgentEvent[] = [{ type: 'final_text', content: JSON.stringify(data) }, { type: 'done', terminationReason: 'normal' }]) {
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, codex: { binaryPath: 'codex' } });
  const stop = vi.fn(async () => undefined);
  const submit = vi.fn(async (_input: SubmitRunInput) => ({ stop, async *subscribe() { for (const e of events) yield e; } }));
  const readSources = vi.fn(async () => []);
  const runtime = createTaskRuntime({ executor: { submit } as unknown as RunExecutor, profile: () => profile, profileName: 'test',
    stateDir: await mkdtemp(join(tmpdir(), 'task-runtime-')), access: () => ({ ok: true, reason: 'allowed-chat' }),
    documents: { readSources } as unknown as TaskDocuments });
  return { runtime, submit, stop, readSources };
}
describe('bounded Codex task runtime', () => {
  it('submits a fresh read-only isolated run without bridge instructions or prior session', async () => {
    const h = await setup();
    expect(await h.runtime.run(task, new AbortController().signal, async () => {})).toMatchObject({ status: 'ready' });
    expect(h.submit.mock.calls[0]![0]).toMatchObject({ restrictedTask: { research: false }, nowait: true, policy: { sandbox: 'read-only' } });
    expect(h.submit.mock.calls[0]![0]).not.toHaveProperty('threadId');
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it('asks for missing source access before starting a worker', async () => {
    const h = await setup(); h.readSources.mockRejectedValue(new Error('请授权源文档'));
    expect(await h.runtime.run(task, new AbortController().signal, async () => {})).toMatchObject({ status: 'needs_input' });
    expect(h.submit).not.toHaveBeenCalled();
  });
  it('does not accept partial output without a normal terminal event', async () => {
    const h = await setup([{ type: 'final_text', content: JSON.stringify(data) }]);
    await expect(h.runtime.run(task, new AbortController().signal, async () => {})).rejects.toThrow('完整结果');
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it('validates structured output and requires real links for research', () => {
    expect(() => parseTaskResult('hello')).toThrow();
    expect(() => parseTaskResult(JSON.stringify(data), true)).toThrow('来源');
    expect(parseTaskResult('{"status":"needs_input","question":"请提供材料"}')).toMatchObject({ status: 'needs_input' });
    expect(parseTaskResult(JSON.stringify({ ...data, sources: [{ title: 'bad', url: 'javascript:alert(1)' }] }))).toMatchObject({ draft: { sources: [] } });
  });
});
