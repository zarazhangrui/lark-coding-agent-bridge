import { setTimeout as delay } from 'node:timers/promises';
import type { ProactiveTask, TaskDraft } from './types';

export interface DocumentClient {
  request<T>(payload: { method: string; url: string; data?: unknown; params?: Record<string, unknown> }): Promise<T>;
}
interface Envelope<T> { code?: number; data?: T }

/** Bounded host-side operations. The model never receives Feishu API credentials. */
export class TaskDocuments {
  constructor(private readonly client: DocumentClient, private readonly tenant: 'feishu' | 'lark') {}

  async readSources(task: ProactiveTask, signal: AbortSignal): Promise<Array<{ url: string; content: string }>> {
    const links = [...new Set(task.request.match(/https:\/\/[^\s<>\])，。]+/g) ?? [])];
    const sources: Array<{ url: string; content: string }> = [];
    for (const link of links.slice(0, 5)) {
      const url = new URL(link);
      if (!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname) || url.username || url.password) {
        if (task.kind !== 'research') throw new Error('资料整理和文档起草暂只读取飞书文档或话题文字。请粘贴网页内容，或调整为公开资料调研。');
        continue;
      }
      const match = url.pathname.match(/^\/(docx|wiki)\/([a-zA-Z0-9]+)\/?$/);
      if (!match) throw new Error('当前仅支持飞书 docx/wiki 文档；其他材料请粘贴文字。');
      signal.throwIfAborted();
      let token = match[2]!;
      if (match[1] === 'wiki') {
        const data = await this.call<{ node?: { obj_token?: string; obj_type?: string } }>({
          method: 'GET', url: '/open-apis/wiki/v2/spaces/get_node', params: { token },
        });
        if (data.node?.obj_type !== 'docx' || !data.node.obj_token) throw new Error('该知识库节点不是可读取的文档，请粘贴所需材料。');
        token = data.node.obj_token;
      }
      const data = await this.call<{ content?: string }>({ method: 'GET', url: `/open-apis/docx/v1/documents/${token}/raw_content` });
      if (!data.content?.trim()) throw new Error('提供的文档没有可读正文，请补充材料。');
      if (data.content.length > 40_000) throw new Error('源文档超过本次处理范围，请粘贴需要处理的章节。');
      sources.push({ url: link, content: data.content });
    }
    if (links.length > 5) throw new Error('一次最多处理 5 个来源，请缩小材料范围。');
    return sources;
  }

  async publish(task: ProactiveTask, signal: AbortSignal, created: (id: string, url: string) => Promise<void>): Promise<string> {
    if (!task.draft) throw new Error('缺少可交付正文。');
    signal.throwIfAborted();
    const doc = await this.call<{ document?: { document_id?: string } }>({
      method: 'POST', url: '/open-apis/docx/v1/documents', data: { title: task.draft.title.slice(0, 200) },
    });
    const id = doc.document?.document_id;
    if (!id || !/^[a-zA-Z0-9]+$/.test(id)) throw new Error('文档服务没有返回有效标识。');
    const url = `https://${this.tenant === 'lark' ? 'www.larksuite.com' : 'www.feishu.cn'}/docx/${id}`;
    await created(id, url);
    const blocks = draftBlocks(task.draft);
    for (let offset = 0; offset < blocks.length; offset += 40) {
      signal.throwIfAborted();
      if (offset > 0) await delay(400, undefined, { signal });
      await this.call({ method: 'POST', url: `/open-apis/docx/v1/documents/${id}/blocks/${id}/children`,
        params: { document_revision_id: -1 }, data: { children: blocks.slice(offset, offset + 40), index: -1 } });
    }
    signal.throwIfAborted();
    // Grant the requesting owner edit access only; never open the document to the internet.
    const permission = await this.call<{ member?: { member_id?: string; perm?: string } }>({
      method: 'POST', url: `/open-apis/drive/v1/permissions/${id}/members`, params: { type: 'docx' },
      data: { member_type: 'openid', member_id: task.ownerId, perm: 'edit', type: 'user' },
    });
    if (permission.member?.member_id !== task.ownerId || permission.member.perm !== 'edit') {
      throw new Error('文档已创建，但无法确认你的阅读/编辑权限。');
    }
    const readback = await this.call<{ content?: string }>({ method: 'GET', url: `/open-apis/docx/v1/documents/${id}/raw_content` });
    const expected = plainContent(task.draft.content).replace(/\s/g, '');
    const actual = readback.content?.replace(/\s/g, '') ?? '';
    if (actual.length < expected.length * 0.8 || !actual.includes(expected.slice(0, 30))) {
      throw new Error('文档正文回读未通过，请检查交付服务。');
    }
    return url;
  }

  private async call<T>(input: Parameters<DocumentClient['request']>[0]): Promise<T> {
    let result: Envelope<T>;
    try { result = await this.client.request<Envelope<T>>(input); }
    catch { throw new Error('飞书文档接口暂不可用或缺少权限，请确认源文档已授权给机器人。'); }
    if (result.code !== undefined && result.code !== 0) throw new Error(`飞书文档接口返回错误 ${result.code}，请检查权限或稍后重试。`);
    if (!result.data) throw new Error('飞书文档接口未返回数据。');
    return result.data;
  }
}

function plainContent(content: string): string {
  return content.replace(/^#{1,6}\s+/gm, '').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)').replace(/\*\*([^*]+)\*\*/g, '$1');
}

export function draftBlocks(draft: TaskDraft): object[] {
  const text = `${draft.content}\n\n## 资料来源\n${draft.sources.length ? draft.sources.map((s) => `${s.title}：${s.url}`).join('\n') : '依据本话题中提供的材料整理。'}`;
  return text.split('\n').filter((line) => line.trim()).flatMap((line) => {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const plain = plainContent(heading?.[2] ?? line);
    const key = heading ? `heading${heading[1]!.length}` : 'text';
    const blockType = heading ? heading[1]!.length + 2 : 2;
    const chunks = plain.match(/[\s\S]{1,1500}/g) ?? [];
    return chunks.map((content) => ({ block_type: blockType, [key]: { elements: [{ text_run: { content } }] } }));
  });
}
