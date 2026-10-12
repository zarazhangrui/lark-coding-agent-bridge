import { describe, expect, it } from 'vitest';
import { TaskDocuments, draftBlocks, type DocumentClient } from '../../../src/proactive/task-documents';
import type { ProactiveTask } from '../../../src/proactive/types';

const content = '# 验收方案\n\n**目的**：验证提醒与交付能在原话题内运行，并且确认后才会创建文档。\n\n## 步骤\n第一步提出要求，第二步确认，第三步检查交付。';
function task(request = '请帮我整理材料'): ProactiveTask {
  return { id: 'pt_123456abcdef', chatId: 'chat', threadId: 'topic', sourceMessageId: 'source', ownerId: 'owner', kind: 'summary',
    request, context: [], fingerprint: 'fp', revision: 1, status: 'publishing', createdAt: 1, updatedAt: 1, artifacts: [],
    draft: { title: '验收方案', content, sources: [] } };
}
function fake(overrides: { permission?: boolean; empty?: boolean; error?: boolean } = {}) {
  const calls: Parameters<DocumentClient['request']>[0][] = [];
  const client: DocumentClient = { async request<T>(input: Parameters<DocumentClient['request']>[0]): Promise<T> {
    calls.push(input);
    if (overrides.error) return { code: 99991672 } as T;
    if (input.url.endsWith('/get_node')) return { code: 0, data: { node: { obj_type: 'docx', obj_token: 'doc1' } } } as T;
    if (input.url.endsWith('/raw_content')) return { code: 0, data: { content: overrides.empty ? '' : content.replace(/[#*]/g, '') } } as T;
    if (input.url.endsWith('/members')) return { code: 0, data: { member: { member_id: 'owner', perm: overrides.permission === false ? 'view' : 'edit' } } } as T;
    return { code: 0, data: input.url.endsWith('/documents') ? { document: { document_id: 'doc1' } } : {} } as T;
  } };
  return { documents: new TaskDocuments(client, 'feishu'), calls };
}
describe('host-owned task documents', () => {
  it('creates, writes, grants only owner access and verifies readback before delivery', async () => {
    const h = fake(); const ids: string[] = [];
    const url = await h.documents.publish(task(), new AbortController().signal, async (id) => { ids.push(id); });
    expect(url).toBe('https://www.feishu.cn/docx/doc1'); expect(ids).toEqual(['doc1']);
    expect(h.calls).toHaveLength(4);
    expect(h.calls[2]).toMatchObject({ data: { member_id: 'owner', perm: 'edit', type: 'user' } });
    expect(h.calls[3]!.url).toContain('raw_content');
  });
  it.each([{ permission: false }, { empty: true }, { error: true }])('fails closed on incomplete publication %j', async (mode) => {
    const h = fake(mode);
    await expect(h.documents.publish(task(), new AbortController().signal, async () => {})).rejects.toThrow();
    expect(h.calls.filter((c) => c.url.endsWith('/documents'))).toHaveLength(1);
  });
  it('resolves wiki and reads docx but never fetches arbitrary URLs in the host', async () => {
    const h = fake(); const data = await h.documents.readSources({ ...task('https://tenant.feishu.cn/wiki/wiki1 https://example.com/data'), kind: 'research' }, new AbortController().signal);
    expect(data).toHaveLength(1); expect(h.calls.map((c) => c.url)).toEqual(['/open-apis/wiki/v2/spaces/get_node', '/open-apis/docx/v1/documents/doc1/raw_content']);
  });
  it('stops before creating a document when cancelled', async () => {
    const h = fake(); const abort = new AbortController(); abort.abort();
    await expect(h.documents.publish(task(), abort.signal, async () => {})).rejects.toThrow(); expect(h.calls).toHaveLength(0);
  });
  it('writes bounded text and heading blocks, never model-supplied API instructions', () => {
    const blocks = draftBlocks({ title: 'test', content: '# 标题\n' + '正文'.repeat(2000), sources: [] });
    expect(blocks[0]).toMatchObject({ block_type: 3, heading1: { elements: [{ text_run: { content: '标题' } }] } });
    expect(blocks).toHaveLength(6);
  });
});
