import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProactiveStore } from '../../../src/proactive/store';

describe('proactive store', () => {
  it('migrates a V2 ledger and retains reminders and preferences', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proactive-store-v2-'));
    const path = join(dir, 'state.json');
    await writeFile(path, JSON.stringify({ version: 2, messages: [], decisions: [], followUps: [],
      preferences: [{ userId: 'owner', enabled: false, overdueReminders: false, dailyReminderLimit: 2, updatedAt: 1 }], processedMessageIds: ['seen'] }));
    const store = new ProactiveStore(path); await store.load();
    expect(store.snapshot()).toMatchObject({ version: 3, tasks: [], processedMessageIds: ['seen'], preferences: [{ enabled: false }] });
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(3);
  });
  it('atomically reloads follow-up state and processed-message dedupe keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proactive-store-'));
    const path = join(dir, 'state.json');
    const first = new ProactiveStore(path);
    first.recordMessage({
      messageId: 'm1',
      chatId: 'oc_intern',
      threadId: 'omt_topic',
      senderId: 'ou_user',
      text: '明天交报告',
      createTime: 1,
    });
    first.createFollowUp({
      id: 'fu_1',
      chatId: 'oc_intern',
      threadId: 'omt_topic',
      sourceMessageId: 'm1',
      summary: '明天交报告',
      ownerId: 'ou_user',
      dueAt: 2,
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    });
    await first.flush();

    const second = new ProactiveStore(path);
    await second.load();
    expect(second.hasProcessed('m1')).toBe(true);
    expect(second.pendingFollowUps('oc_intern', 'omt_topic')).toHaveLength(1);
    expect(second.pendingFollowUps('oc_intern')).toHaveLength(0);
    expect(second.snapshot().messages[0]?.threadId).toBe('omt_topic');
  });

  it('migrates a V1 ledger without dropping follow-ups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proactive-store-v1-'));
    const path = join(dir, 'state.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        messages: [],
        decisions: [],
        processedMessageIds: [],
        followUps: [
          {
            id: 'fu_v1',
            chatId: 'oc_intern',
            sourceMessageId: 'm_v1',
            summary: 'V1 事项',
            ownerId: 'ou_user',
            dueAt: 20,
            status: 'pending',
            createdAt: 10,
            updatedAt: 10,
          },
        ],
      }),
    );

    const store = new ProactiveStore(path);
    await store.load();
    expect(store.snapshot()).toMatchObject({
      version: 3,
      tasks: [],
      preferences: [],
      followUps: [
        {
          id: 'fu_v1',
          createdById: 'ou_user',
          nextReminderAt: 20,
          reminderHistory: [],
        },
      ],
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 3, preferences: [], tasks: [] });
  });
});

