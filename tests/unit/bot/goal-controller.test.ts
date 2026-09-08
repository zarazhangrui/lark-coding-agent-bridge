import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GoalController,
  goalStopText,
  prepareGoalSignal,
  readGoalSignal,
  type GoalState,
} from '../../../src/bot/goal.js';

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

let dir: string;
let controller: GoalController;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goal-test-'));
  controller = new GoalController(join(dir, 'goals.json'));
});

afterEach(async () => {
  await controller.flush();
  await rm(dir, { recursive: true, force: true });
});

/**
 * `advance` for the goal on `oc_1`, looking its id up first — every caller here
 * is the current goal asking for another round.
 */
function advance(reason: string, now: number, scope = 'oc_1') {
  const id = controller.getAny(scope)?.id ?? 'no-such-goal';
  return controller.advance(scope, id, reason, now);
}

function start(overrides: Partial<Parameters<GoalController['start']>[0]> = {}): GoalState {
  return controller.start({
    scope: 'oc_1',
    goal: '部署并跑出基线数字',
    chatId: 'oc_1',
    maxRounds: 5,
    maxHours: 4,
    now: T0,
    ...overrides,
  });
}

describe('GoalController', () => {
  it('runs another round when the agent asks for one', () => {
    start();
    const result = advance('等 make 收尾', T0 + 60_000);
    expect(result).toEqual({ ok: true, state: expect.objectContaining({ round: 1 }) });
    expect(controller.get('oc_1')?.lastReason).toBe('等 make 收尾');
  });

  it('stops at the round ceiling', () => {
    start({ maxRounds: 2 });
    expect(advance('a', T0)).toMatchObject({ ok: true });
    expect(advance('b', T0)).toMatchObject({ ok: false, stop: 'max-rounds' });
    // And the loop is gone, so a late signal can't revive it.
    expect(controller.get('oc_1')).toBeUndefined();
    expect(advance('c', T0)).toBeUndefined();
  });

  it('stops once the deadline passes', () => {
    start({ maxHours: 2 });
    expect(advance('a', T0 + HOUR)).toMatchObject({ ok: true });
    expect(advance('b', T0 + 2 * HOUR + 1)).toMatchObject({
      ok: false,
      stop: 'deadline',
    });
  });

  it('stops an agent that keeps repeating the same blocker', () => {
    // Distinct from making slow progress: three rounds that all say the same
    // thing are three rounds that produced nothing new to say.
    start();
    expect(advance('在等编译', T0)).toMatchObject({ ok: true });
    expect(advance('在等编译', T0)).toMatchObject({ ok: true });
    expect(advance('在等编译', T0)).toMatchObject({ ok: false, stop: 'stuck' });
  });

  it('treats a changed reason as progress', () => {
    start();
    advance('在等编译', T0);
    advance('在等编译', T0);
    expect(advance('编译完了,开始换二进制', T0)).toMatchObject({ ok: true });
    // The streak resets, so the next repeat starts counting from scratch.
    expect(advance('换完了,重启链路', T0)).toMatchObject({ ok: true });
  });

  it('clamps absurd limits instead of trusting them', () => {
    const state = start({ maxRounds: 10_000, maxHours: 10_000 });
    expect(state.maxRounds).toBe(200);
    expect(state.deadlineAt - state.startedAt).toBe(72 * HOUR);
  });

  it('survives a restart as an interrupted loop the user can resume', async () => {
    start();
    advance('等 make 收尾', T0);
    await controller.flush();

    const reloaded = new GoalController(join(dir, 'goals.json'));
    await reloaded.load();
    // Still active on disk — nothing has told it the process died yet.
    expect(reloaded.get('oc_1')?.round).toBe(1);

    const cut = reloaded.markInterrupted();
    expect(cut).toHaveLength(1);
    // Not active any more: a restart must never silently fire agent runs.
    expect(reloaded.get('oc_1')).toBeUndefined();
    expect(reloaded.getAny('oc_1')?.status).toBe('interrupted');

    const resumed = reloaded.resume('oc_1', T0 + HOUR, 4);
    expect(resumed).toMatchObject({ round: 1, goal: '部署并跑出基线数字', status: 'active' });
    expect(reloaded.get('oc_1')).toBeDefined();
    await reloaded.flush();
  });

  it('only resumes a loop that was actually interrupted', () => {
    start();
    expect(controller.resume('oc_1', T0, 4)).toBeUndefined();
    expect(controller.resume('unknown-scope', T0, 4)).toBeUndefined();
  });


  it('will not let a finished round act on the goal that replaced it', () => {
    // `/goal off` mid-round leaves the old round still running; a new goal
    // started right after would otherwise be advanced — or closed — by it.
    const first = start({ goal: '旧目标' });
    controller.end('oc_1', 'cancelled');
    const second = start({ goal: '新目标' });
    expect(second.id).not.toBe(first.id);

    expect(controller.advance('oc_1', first.id, '旧目标的下一步', T0)).toBeUndefined();
    expect(controller.end('oc_1', 'done', { expectId: first.id })).toBeUndefined();
    // The new goal is untouched: still active, still on round 0.
    expect(controller.get('oc_1')).toMatchObject({ goal: '新目标', round: 0 });
  });

  it('lets /stop end whatever goal is running, without knowing its id', () => {
    start();
    expect(controller.end('oc_1', 'cancelled')).toBeDefined();
    expect(controller.get('oc_1')).toBeUndefined();
  });

  it('counts the round that closed the goal', () => {
    // `round` otherwise only moves when another round is *requested*, so a goal
    // the agent closed on its first round would report "共 0 轮".
    start();
    const ended = controller.end('oc_1', 'done', { roundsRun: 1 });
    expect(ended?.round).toBe(1);
    expect(goalStopText('done', ended!)).toContain('共 1 轮');
  });

  it('reports a broken round as unfinished rather than achieved', () => {
    start();
    const failed = controller.end('oc_1', 'run-failed', { roundsRun: 2 });
    const text = goalStopText('run-failed', failed!);
    expect(text).toContain('目标未完成');
    expect(text).not.toContain('已达成');
  });

  it('keeps goals in different scopes independent', () => {
    start({ scope: 'oc_1' });
    start({ scope: 'oc_2:th_1', goal: '另一个目标' });
    controller.end('oc_1', 'cancelled');
    expect(controller.get('oc_1')).toBeUndefined();
    expect(controller.get('oc_2:th_1')?.goal).toBe('另一个目标');
  });

  it('persists to disk with owner-only permissions', async () => {
    start();
    await controller.flush();
    const text = await readFile(join(dir, 'goals.json'), 'utf8');
    expect(JSON.parse(text).entries.oc_1.goal).toBe('部署并跑出基线数字');
  });
});

describe('loop signal file', () => {
  it('reads the reason once and then forgets it', async () => {
    const path = controller.signalPath('goal-a', 1);
    await prepareGoalSignal(path);
    await writeFile(path, '  等 make 收尾\n');
    expect(await readGoalSignal(path)).toEqual({ kind: 'continue', reason: '等 make 收尾' });
    // Consumed: a second read must not extend the goal again.
    expect(await readGoalSignal(path)).toEqual({ kind: 'none' });
  });

  it('reports no signal when the agent wrote nothing', async () => {
    const path = controller.signalPath('goal-a', 2);
    await prepareGoalSignal(path);
    expect(await readGoalSignal(path)).toEqual({ kind: 'none' });
  });

  it('treats an empty write as "done", not as a reason to continue', async () => {
    const path = controller.signalPath('goal-a', 3);
    await prepareGoalSignal(path);
    await writeFile(path, '   \n\n');
    expect(await readGoalSignal(path)).toEqual({ kind: 'none' });
  });

  it('gives every round its own path so a stale file cannot re-trigger', async () => {
    const first = controller.signalPath('goal-a', 1);
    expect(controller.signalPath('goal-a', 2)).not.toBe(first);
    expect(controller.signalPath('goal-b', 1)).not.toBe(first);
    // Two goals in the same scope both start at round 1; keying by goal id is
    // what stops the second from consuming the first's leftover signal.
    expect(controller.signalPath('goal-b', 1)).not.toBe(controller.signalPath('goal-a', 1));
  });

  it('clears a leftover file before the round starts', async () => {
    const path = controller.signalPath('goal-a', 4);
    await prepareGoalSignal(path);
    await writeFile(path, 'stale');
    await prepareGoalSignal(path);
    expect(await readGoalSignal(path)).toEqual({ kind: 'none' });
  });

  it('never reports "no signal" when it simply could not read one', async () => {
    // A directory where a file is expected stands in for any unreadable path
    // (a read-only /tmp, a broken mount). Collapsing this into "none" would let
    // a broken signal channel report every goal as achieved.
    const path = controller.signalPath('goal-a', 9);
    await prepareGoalSignal(path);
    await mkdir(path, { recursive: true });
    const signal = await readGoalSignal(path);
    expect(signal.kind).toBe('unreadable');
    await rm(path, { recursive: true, force: true });
  });

  it('fails loudly when the signal file cannot be prepared', async () => {
    // Starting a round whose signal can never be written would end the goal as
    // "achieved" the moment that round finished.
    const blocked = new GoalController(join(dir, 'blocked', 'goals.json'));
    await writeFile(join(dir, 'blocked'), 'not a directory');
    await expect(prepareGoalSignal(blocked.signalPath('goal-a', 1))).rejects.toThrow();
  });
});

describe('signal housekeeping', () => {
  it('removes signals whose goal no longer exists', async () => {
    // A bridge killed between the agent writing a signal and the round reading
    // it leaves the file behind; if the user then starts a *new* goal instead
    // of resuming, nothing ever looks at that path again.
    const orphan = controller.signalPath('long-gone-goal', 3);
    await prepareGoalSignal(orphan);
    await writeFile(orphan, '半路挂了');

    expect(await controller.sweepSignals(Date.now() + 2 * HOUR)).toBe(1);
    expect(await readGoalSignal(orphan)).toEqual({ kind: 'none' });
  });

  it('leaves a live goal signal alone', async () => {
    const state = start();
    const live = controller.signalPath(state.id, 1);
    await prepareGoalSignal(live);
    await writeFile(live, '还在跑');

    expect(await controller.sweepSignals(Date.now() + 2 * HOUR)).toBe(0);
    expect(await readGoalSignal(live)).toEqual({ kind: 'continue', reason: '还在跑' });
  });

  it('leaves a just-written orphan for the next startup', async () => {
    // Another process sharing this profile could have written it moments ago.
    const fresh = controller.signalPath('someone-elses-goal', 1);
    await prepareGoalSignal(fresh);
    await writeFile(fresh, '别人的');

    expect(await controller.sweepSignals(Date.now())).toBe(0);
  });

  it('does nothing when there is no signal directory yet', async () => {
    const virgin = new GoalController(join(dir, 'never-used', 'goals.json'));
    expect(await virgin.sweepSignals(Date.now())).toBe(0);
  });
});

describe('loading goals written by an older bridge', () => {
  it('mints an id for a record that has none', async () => {
    // Without an id `expectId` checks are skipped and every such goal shares
    // the signal path `undefined.<round>.continue`.
    const path = join(dir, 'legacy.json');
    await writeFile(
      path,
      JSON.stringify({
        entries: {
          oc_1: {
            scope: 'oc_1',
            goal: '旧目标',
            round: 2,
            startedAt: T0,
            deadlineAt: T0 + HOUR,
            maxRounds: 20,
            chatId: 'oc_1',
            sameReasonStreak: 0,
            status: 'active',
          },
        },
      }),
    );
    const loaded = new GoalController(path);
    await loaded.load();
    const state = loaded.get('oc_1');
    expect(state?.id).toMatch(/[0-9a-f-]{36}/);
    expect(state?.goal).toBe('旧目标');
    expect(loaded.signalPath(state!.id, 1)).not.toContain('undefined');
  });
});

describe('goalStopText', () => {
  const state: GoalState = {
    id: 'goal-1',
    scope: 'oc_1',
    goal: 'g',
    round: 7,
    startedAt: T0,
    deadlineAt: T0 + HOUR,
    maxRounds: 20,
    chatId: 'oc_1',
    lastReason: '在等编译',
    sameReasonStreak: 2,
    status: 'active',
  };

  it('says why it stopped, and whether the goal was reached', () => {
    expect(goalStopText('done', state)).toContain('目标已达成');
    expect(goalStopText('max-rounds', state)).toContain('20');
    expect(goalStopText('max-rounds', state)).toContain('目标未确认完成');
    expect(goalStopText('deadline', state)).toContain('时间上限');
    expect(goalStopText('stuck', state)).toContain('在等编译');
    expect(goalStopText('cancelled', state)).toContain('取消');
  });

  it('always reports how many rounds were spent', () => {
    for (const stop of ['done', 'cancelled', 'max-rounds', 'deadline', 'stuck'] as const) {
      expect(goalStopText(stop, state)).toContain('共 7 轮');
    }
  });
});
