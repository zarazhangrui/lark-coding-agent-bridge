import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeInbox, wholeUtf8End, type Wake, type WakeArm } from '../../../src/bot/wake.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wake-inbox-'));
  dirs.push(dir);
  return dir;
}

const ROUTE = {
  scope: 'oc_chat',
  chatId: 'oc_chat',
  mode: 'p2p' as const,
  anchorId: 'om_anchor',
  senderId: 'ou_user',
};

/** Collects what the sweeper dispatched, in order. */
function collector(): { wakes: Wake[]; handler: (w: Wake) => void } {
  const wakes: Wake[] = [];
  return { wakes, handler: (w) => void wakes.push(w) };
}

async function armed(dir?: string): Promise<{ inbox: WakeInbox; path: string; prefix: string }> {
  const inbox = new WakeInbox(dir ?? (await tmpDir()));
  const prefix = await inbox.arm(ROUTE);
  if (!prefix) throw new Error('inbox should be enabled');
  // What the documented `mktemp` + `mv` produces.
  return { inbox, path: `${prefix}.aB3xQ1.wake`, prefix };
}

describe('WakeInbox paths', () => {
  it('gives one conversation the same prefix run after run', async () => {
    // Derived from the identity, not the clock: a chat with one person in it
    // rewrites neither its prefix nor its route file.
    const inbox = new WakeInbox(await tmpDir());
    expect(await inbox.arm(ROUTE)).toBe(await inbox.arm(ROUTE));
  });

  it('gives different scopes different prefixes', async () => {
    const inbox = new WakeInbox(await tmpDir());
    // A topic scope is `chatId:threadId`; it must not collide with its chat.
    const chat = await inbox.arm(ROUTE);
    const topic = await inbox.arm({ ...ROUTE, scope: 'oc_chat:omt_1', threadId: 'omt_1' });
    expect(chat).not.toBe(topic);
  });

  it('gives a second person in the same chat their own prefix', async () => {
    const inbox = new WakeInbox(await tmpDir());
    const mine = await inbox.arm(ROUTE);
    const theirs = await inbox.arm({ ...ROUTE, anchorId: 'om_b', senderId: 'ou_other' });
    expect(mine).not.toBe(theirs);
  });

  it('is off entirely without a profile directory', async () => {
    const inbox = new WakeInbox();
    expect(inbox.enabled).toBe(false);
    expect(await inbox.arm(ROUTE)).toBeUndefined();
    // Arming and sweeping are no-ops rather than errors, so a bridge without a
    // profile dir simply has no wake channel.
    expect(await inbox.sweep()).toBe(0);
    expect(await inbox.sweepStale(Date.now())).toBe(0);
  });
});

describe('WakeInbox dispatch', () => {
  it('delivers a wake to the armed route', async () => {
    const { inbox, path } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(path, '打包完成，1.29 GB');

    expect(await inbox.sweep()).toBe(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toBe('打包完成，1.29 GB');
    expect(wakes[0]?.kind).toBe('wake');
    expect(wakes[0]?.route.chatId).toBe('oc_chat');
    expect(wakes[0]?.route.anchorId).toBe('om_anchor');
    await inbox.stop();
  });

  it('consumes the file so one report is delivered once', async () => {
    const { inbox, path } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(path, '好了');

    await inbox.sweep();
    await inbox.sweep();
    expect(wakes).toHaveLength(1);
    await inbox.stop();
  });

  it('does not retry a failed delivery on every poll, but keeps it for restart', async () => {
    // Two failure modes to avoid at once: a Feishu outage must not turn one
    // report into an every-two-seconds retry, and it must not silently discard
    // the report either. The file stays under `.taken`, invisible to the
    // sweep, and startup housekeeping hands it back once.
    const { inbox, path } = await armed();
    let calls = 0;
    inbox.start(() => {
      calls++;
      throw new Error('send failed');
    });
    await writeFile(path, '好了');

    await inbox.sweep();
    await inbox.sweep();
    expect(calls).toBe(1);
    expect(await readdir(inbox.dir!)).toContain(`${path.split('/').pop()}.taken`);
    await inbox.stop();
  });

  it('removes a report it delivered', async () => {
    const { inbox, path } = await armed();
    const { handler } = collector();
    inbox.start(handler);
    await writeFile(path, '好了');

    await inbox.sweep();
    expect((await readdir(inbox.dir!)).filter((f) => !f.endsWith('.route'))).toEqual([]);
    await inbox.stop();
  });



  it('accepts a suffixed file so a job can report several times', async () => {
    const { inbox, prefix } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    // `<token>.wake` and `<token>.<n>.wake` are the same scope — a job that
    // writes twice before a sweep must not lose the first note.
    await writeFile(`${prefix}.aaa.wake`, '第一步好了');
    await writeFile(`${prefix}.bbb.wake`, '第二步好了');

    expect(await inbox.sweep()).toBe(2);
    expect(wakes.map((w) => w.text)).toEqual(['第一步好了', '第二步好了']);
    await inbox.stop();
  });

  it('delivers oldest first', async () => {
    const { inbox, prefix } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(`${prefix}.b.wake`, '上传完成');
    await writeFile(`${prefix}.a.wake`, '打包完成');
    // Alphabetical order would put "上传完成" first, which reverses what
    // actually happened.
    const older = new Date(Date.now() - 60_000);
    await utimes(`${prefix}.a.wake`, older, older);

    await inbox.sweep();
    expect(wakes.map((w) => w.text)).toEqual(['打包完成', '上传完成']);
    await inbox.stop();
  });

  it('drops a wake whose route it has never seen', async () => {
    const dir = await tmpDir();
    const inbox = new WakeInbox(dir);
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(join(dir, 'deadbeefdeadbeef.wake'), '来自哪里？');

    expect(await inbox.sweep()).toBe(0);
    expect(wakes).toHaveLength(0);
    // Still consumed — an undeliverable file must not accumulate.
    expect(await readdir(dir)).toEqual([]);
    await inbox.stop();
  });

  it('skips an empty file', async () => {
    const { inbox, path } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(path, '   \n');

    expect(await inbox.sweep()).toBe(0);
    expect(wakes).toHaveLength(0);
    await inbox.stop();
  });

  it('truncates a wake that is being used as a log', async () => {
    const { inbox, path } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(path, 'x'.repeat(5_000));

    await inbox.sweep();
    expect(wakes[0]?.text.length).toBeLessThan(2_100);
    expect(wakes[0]?.text).toContain('已截断');
    await inbox.stop();
  });

  it('does not read a redirected build log into memory', async () => {
    // `cmd > "$WAKE"` is one character from the documented form. Reading 20 MB
    // to then keep 2000 characters of it is the failure worth preventing.
    const { inbox, path } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(path, `第一行很重要\n${'y'.repeat(20_000_000)}`);

    await inbox.sweep();
    expect(wakes[0]?.text.startsWith('第一行很重要')).toBe(true);
    expect(wakes[0]?.text.length).toBeLessThan(2_100);
    await inbox.stop();
  });

  it('acts on the file it holds, not the name a job can still write to', async () => {
    // `stat` then `rm` on the live name deletes whatever is there *now*. With
    // the protocol's atomic `mv`, that can be a report that landed in between —
    // deleted unread. Taking the file first makes the two the same bytes.
    const { inbox, prefix } = await armed();
    const stale = `${prefix}.old.wake`;
    await writeFile(stale, '两天前那条');
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(stale, old, old);

    const { wakes, handler } = collector();
    inbox.start(handler);
    // The stale one is dropped…
    expect(await inbox.sweep()).toBe(0);
    expect(wakes).toHaveLength(0);
    // …and a fresh report written to a name of its own is untouched by that.
    await writeFile(`${prefix}.new.wake`, '刚跑完的');
    expect(await inbox.sweep()).toBe(1);
    expect(wakes[0]?.text).toBe('刚跑完的');
    await inbox.stop();
  });

  it('leaves no .taken behind on a clean dispatch', async () => {
    const { inbox, path } = await armed();
    const { handler } = collector();
    inbox.start(handler);
    await writeFile(path, '好了');

    await inbox.sweep();
    expect(await readdir(inbox.dir!)).not.toContain(`${path.split('/').pop()}.taken`);
    await inbox.stop();
  });

  it('keeps a legitimate replacement character at the very end', async () => {
    // Trimming U+FFFD from decoded text would eat a real one; only an
    // incomplete byte sequence should be cut.
    const { inbox, path } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(path, '结果里带了一个\uFFFD');

    await inbox.sweep();
    expect(wakes[0]?.text.endsWith('\uFFFD')).toBe(true);
    await inbox.stop();
  });

  it('cuts a truncated multi-byte character rather than showing it broken', async () => {
    const { inbox, path } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    // Each 汉 is 3 bytes; 8000 bytes lands mid-character.
    await writeFile(path, '汉'.repeat(4_000));

    await inbox.sweep();
    expect(wakes[0]?.text).not.toContain('\uFFFD');
    await inbox.stop();
  });

  it('retries the route write after one that failed', async () => {
    // A failed write leaves the route usable in memory but absent from disk.
    // Skipping the next attempt would mean a restart inside the hour finds
    // nothing and a running job's report has nowhere to go.
    const dir = await tmpDir();
    const inbox = new WakeInbox(dir);
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, 'not a directory');
    await inbox.arm(ROUTE);
    await rm(dir, { force: true });

    await inbox.arm(ROUTE);
    expect((await readdir(dir)).some((f) => f.endsWith('.route'))).toBe(true);
  });

  it('stops dispatching once stopped, without losing what it already read', async () => {
    const { inbox, prefix } = await armed();
    const seen: string[] = [];
    inbox.start((w) => {
      seen.push(w.text);
      // Shutting down mid-sweep must not strand the remaining files as
      // delivered-but-unseen: they were never consumed, so a later bridge
      // (or `sweepStale`) still decides their fate.
      void inbox.stop();
    });
    await writeFile(`${prefix}.1.wake`, 'A');
    await writeFile(`${prefix}.2.wake`, 'B');

    await inbox.sweep();
    expect(seen).toEqual(['A']);
    expect(await readdir(inbox.dir!)).toContain(`${prefix.split('/').pop()}.2.wake`);
  });

  it('stop() waits out a dispatch already in flight', async () => {
    // Shutdown drains the pending queue right after this returns. A handler
    // still mid-`channel.send()` would otherwise queue its wake after that
    // drain and start a run against a closing channel.
    const { inbox, path } = await armed();
    let finished = false;
    inbox.start(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
    });
    await writeFile(path, '慢慢发');

    const sweeping = inbox.sweep();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await inbox.stop();
    expect(finished).toBe(true);
    await sweeping;
  });

  it('recovers routing from disk after a restart', async () => {
    const dir = await tmpDir();
    const { path } = await armed(dir);
    // A job launched before the restart still holds the old path; the bridge
    // that comes back has nothing in memory.
    const restarted = new WakeInbox(dir);
    const { wakes, handler } = collector();
    restarted.start(handler);
    await writeFile(path, '重启后才跑完');

    expect(await restarted.sweep()).toBe(1);
    expect(wakes[0]?.route.scope).toBe('oc_chat');
    await restarted.stop();
  });

  it('rewrites the route file only when routing actually changed', async () => {
    // Every run arms. The write is an fsync'd atomic replace, so re-doing it
    // for an unchanged route would put a disk round-trip on the critical path
    // of every ordinary reply.
    const dir = await tmpDir();
    const inbox = new WakeInbox(dir);
    await inbox.arm(ROUTE);
    const routeFile = (await readdir(dir)).find((f) => f.endsWith('.route'));
    if (!routeFile) throw new Error('route not written');
    const first = (await stat(join(dir, routeFile))).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 15));
    await inbox.arm(ROUTE);
    expect((await stat(join(dir, routeFile))).mtimeMs).toBe(first);

    await inbox.arm({ ...ROUTE, anchorId: 'om_newer' });
    expect((await stat(join(dir, routeFile))).mtimeMs).not.toBe(first);
  });

  it('answers an old job against its own run, not the latest one', async () => {
    // A colleague using the chat while a job is still running must not end up
    // owning that job's report — it threads to the message that started it and
    // is attributed to whoever started it.
    const dir = await tmpDir();
    const { inbox, path } = await armed(dir);
    await inbox.arm({ ...ROUTE, anchorId: 'om_newer', senderId: 'ou_other' });
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(path, '我的任务跑完了');

    await inbox.sweep();
    expect(wakes[0]?.route.anchorId).toBe('om_anchor');
    expect(wakes[0]?.route.senderId).toBe('ou_user');
    await inbox.stop();
  });

  it('falls back to the newest run when an ancient one was pruned', async () => {
    // Better to land in the right conversation against a newer message than to
    // drop a report because its own run aged out of the record.
    const dir = await tmpDir();
    const { inbox, prefix } = await armed(dir);
    for (let i = 0; i < 25; i++) {
      await inbox.arm({ ...ROUTE, anchorId: `om_${i}`, senderId: `ou_${i}` });
    }
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(`${prefix}.late.wake`, '很久以前那个任务');

    await inbox.sweep();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.route.scope).toBe('oc_chat');
    await inbox.stop();
  });

  it('keeps a topic route threaded', async () => {
    const dir = await tmpDir();
    const inbox = new WakeInbox(dir);
    const route: WakeArm = {
      scope: 'oc_g:omt_1',
      chatId: 'oc_g',
      threadId: 'omt_1',
      mode: 'topic',
      anchorId: 'om_root',
      senderId: 'ou_user',
    };
    const prefix = await inbox.arm(route);
    const { wakes, handler } = collector();
    inbox.start(handler);
    await writeFile(`${prefix!}.zz1.wake`, '好了');

    await inbox.sweep();
    expect(wakes[0]?.route.threadId).toBe('omt_1');
    expect(wakes[0]?.route.mode).toBe('topic');
    await inbox.stop();
  });
});

describe('wholeUtf8End', () => {
  const cut = (...bytes: number[]): number => wholeUtf8End(Buffer.from(bytes));

  it('keeps a buffer that already ends on a character boundary', () => {
    expect(cut(0x61, 0x62)).toBe(2);
    expect(cut(0xe6, 0xb1, 0x89)).toBe(3); // 汉, complete
    expect(cut(0xf0, 0x9f, 0x98, 0x80)).toBe(4); // 😀, complete
    expect(wholeUtf8End(Buffer.alloc(0))).toBe(0);
  });

  it('cuts a sequence the byte limit split in half', () => {
    expect(cut(0x61, 0xe6, 0xb1)).toBe(1); // 2 of 汉's 3 bytes
    expect(cut(0x61, 0xf0)).toBe(1); // lead of a 4-byte character, alone
    expect(cut(0x61, 0xf0, 0x9f, 0x98)).toBe(1); // 3 of 😀's 4 bytes
  });

  it('leaves a byte that is not a lead byte at all', () => {
    // 0xc0/0xc1 and 0xf5–0xff never occur in well-formed UTF-8, so a trailing
    // one is content the file really contains — not a truncated sequence.
    for (const byte of [0xc0, 0xc1, 0xf5, 0xff]) {
      expect(cut(0x61, byte)).toBe(2);
    }
    // A tail of nothing but continuation bytes is malformed either way; do not
    // guess at it.
    expect(cut(0x80, 0x80, 0x80)).toBe(3);
  });
});

describe('WakeInbox rate limiting', () => {
  it('stops delivering past the hourly ceiling and says so once', async () => {
    const { inbox, path } = await armed();
    const { wakes, handler } = collector();
    inbox.start(handler);
    const base = path.slice(0, -'.wake'.length);
    // 30 is the ceiling; 32 writes means one notice and one silent drop.
    for (let i = 0; i < 32; i++) {
      await writeFile(`${base}.${String(i).padStart(3, '0')}.wake`, `第 ${i} 条`);
    }

    await inbox.sweep();
    const real = wakes.filter((w) => w.kind === 'wake');
    const notices = wakes.filter((w) => w.kind === 'notice');
    expect(real).toHaveLength(30);
    // The notice is posted but deliberately does not start a run — telling the
    // agent it is throttled would spend the thing being throttled.
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('限流');
    await inbox.stop();
  });
});

describe('WakeInbox startup housekeeping', () => {
  it('delivers a report written while the bridge was down', async () => {
    // The whole point of the channel: the job outlives the run, and sometimes
    // the bridge too. Clearing the inbox at startup would throw that away.
    const dir = await tmpDir();
    const { path } = await armed(dir);
    await writeFile(path, '重启期间跑完的');

    const restarted = new WakeInbox(dir);
    expect(await restarted.sweepStale(Date.now())).toBe(0);
    const { wakes, handler } = collector();
    restarted.start(handler);
    expect(await restarted.sweep()).toBe(1);
    expect(wakes[0]?.text).toBe('重启期间跑完的');
    await restarted.stop();
  });

  it('drops a report nobody collected for a day', async () => {
    // Aged out by the ordinary sweep, so the rule holds regardless of whether
    // startup housekeeping got there first.
    const dir = await tmpDir();
    const { path } = await armed(dir);
    await writeFile(path, '两天前的');
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(path, old, old);

    const inbox = new WakeInbox(dir);
    const { wakes, handler } = collector();
    inbox.start(handler);
    expect(await inbox.sweep()).toBe(0);
    expect(wakes).toHaveLength(0);
    expect(await readdir(dir)).not.toContain(path.split('/').pop());
    await inbox.stop();
  });

  it('refuses a route whose file name does not match the scope it claims', async () => {
    // A hand-written route could otherwise point a wake at any conversation,
    // and claim a scope of its own to sidestep the per-scope rate limit.
    const dir = await tmpDir();
    await writeFile(
      join(dir, 'deadbeefdeadbeef.route'),
      JSON.stringify({
        scope: 'oc_victim',
        chatId: 'oc_victim',
        mode: 'p2p',
        runs: { aa: { anchorId: 'om_x', senderId: 'ou_user', at: Date.now() } },
        updatedAt: Date.now(),
      }),
    );
    await writeFile(join(dir, 'deadbeefdeadbeef.aa.wake'), '注入');

    const inbox = new WakeInbox(dir);
    const { wakes, handler } = collector();
    inbox.start(handler);
    expect(await inbox.sweep()).toBe(0);
    expect(wakes).toHaveLength(0);
    await inbox.stop();
  });

  it('drops the mktemp file a job died before renaming', async () => {
    // `mktemp "<prefix>.XXXXXX"` leaves `<token>.aB3xQ1` — no `.tmp`, no
    // `.wake`. Matching on a suffix would let these pile up forever.
    const dir = await tmpDir();
    const { prefix } = await armed(dir);
    const orphan = `${prefix}.QQ1122`;
    await writeFile(orphan, '写了一半');

    const inbox = new WakeInbox(dir);
    // Hours old: a job blocked on a slow pipe is not an abandoned one, and
    // deleting its file makes the final `mv` fail with the report lost.
    expect(await inbox.sweepStale(Date.now() + 2 * 3_600_000)).toBe(0);
    expect(await inbox.sweepStale(Date.now() + 48 * 3_600_000)).toBe(1);
    expect(await readdir(dir)).not.toContain(orphan.split('/').pop());
  });

  it('hands back a report the previous bridge died while delivering', async () => {
    // A `.taken` was read but never posted. Dropping it would lose the report
    // at exactly the moment the channel is supposed to be most useful.
    const dir = await tmpDir();
    const { path } = await armed(dir);
    await writeFile(`${path}.taken`, '上一个进程没发出去的');

    const inbox = new WakeInbox(dir);
    await inbox.sweepStale(Date.now());
    const { wakes, handler } = collector();
    inbox.start(handler);
    expect(await inbox.sweep()).toBe(1);
    expect(wakes[0]?.text).toBe('上一个进程没发出去的');
    await inbox.stop();
  });

  it('hands back two crashed deliveries without one clobbering the other', async () => {
    const dir = await tmpDir();
    const { prefix } = await armed(dir);
    await writeFile(`${prefix}.a.wake.taken`, 'A');
    await writeFile(`${prefix}.b.wake.taken`, 'B');

    const inbox = new WakeInbox(dir);
    await inbox.sweepStale(Date.now());
    const { wakes, handler } = collector();
    inbox.start(handler);
    expect(await inbox.sweep()).toBe(2);
    expect(wakes.map((w) => w.text).sort()).toEqual(['A', 'B']);
    await inbox.stop();
  });

  it('keeps a route alive long enough for a job that runs for weeks', async () => {
    // Only a run re-arms a route. A job detached in January and still running
    // in March has nothing refreshing its path, and an expired route turns its
    // report into an undeliverable file.
    const dir = await tmpDir();
    await armed(dir);
    const threeWeeks = Date.now() + 21 * 24 * 3_600_000;
    expect(await new WakeInbox(dir).sweepStale(threeWeeks)).toBe(0);
  });

  it('keeps a fresh route but drops a long-dead one', async () => {
    const dir = await tmpDir();
    await armed(dir);
    const before = await readdir(dir);
    expect(before.some((f) => f.endsWith('.route'))).toBe(true);

    const inbox = new WakeInbox(dir);
    expect(await inbox.sweepStale(Date.now())).toBe(0);
    // Long enough that nothing plausibly still holds this path.
    const longAfter = Date.now() + 100 * 24 * 3_600_000;
    expect(await inbox.sweepStale(longAfter)).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });
});
