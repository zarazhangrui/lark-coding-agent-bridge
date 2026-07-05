import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TopicContextStore } from '../../../src/bot/topic-context.js';

describe('TopicContextStore', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('shares and deduplicates bounded context for a thread scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'topic-context-'));
    cleanup.push(dir);
    const first = new TopicContextStore(dir);
    const second = new TopicContextStore(dir);
    const scope = 'oc_chat:omt_topic';

    await first.append(scope, {
      id: 'om_1',
      role: 'user',
      speaker: 'Liangmin',
      text: '检查项目',
    });
    await first.append(scope, {
      id: 'om_1',
      role: 'user',
      speaker: 'Liangmin',
      text: '检查项目',
    });
    await second.append(scope, {
      id: 'run_1',
      role: 'assistant',
      speaker: 'lark-claudecode',
      agent: 'claude',
      text: '项目正常',
    });

    expect(await second.read(scope)).toMatchObject([
      { id: 'om_1', role: 'user', text: '检查项目' },
      { id: 'run_1', role: 'assistant', agent: 'claude', text: '项目正常' },
    ]);
    expect(await second.read(scope, { excludeIds: ['om_1'] })).toHaveLength(1);
    expect(await second.read('oc_plain')).toEqual([]);
  });
});
