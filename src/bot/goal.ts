import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * `/goal` — keep running rounds until the goal is actually closed.
 *
 * A headless `claude -p` / `codex exec` run is one-shot: when the turn ends the
 * process is gone, and anything it promised to do "afterwards" never happens.
 * A detached `nohup` job survives, but it can only *notify* — it cannot think,
 * check the result, or decide what to do next.
 *
 * This closes that gap on the bridge side: when a round ends, the bridge asks
 * the agent whether the goal is closed. If not, it starts another round on the
 * same session, so the agent picks up with full context. The work spans as many
 * runs as it needs while staying one continuous conversation.
 *
 * The signalling protocol is deliberately opt-out rather than opt-in:
 * **silence ends the loop**. The agent has to actively write a reason to keep
 * going, so a confused, crashed, or interrupted agent stops — the failure mode
 * costs one "继续" from the user instead of an unbounded run of API calls.
 */

/** Hard ceilings, independent of the configured ones — a bug can't outrun these. */
const ROUND_CEILING = 200;
const HOURS_CEILING = 72;
/** Consecutive identical continuation reasons before we call it stuck. */
const STUCK_REPEATS = 3;
/** Continuation reasons are echoed into prompts and cards; keep them short. */
const REASON_MAX_CHARS = 500;
/**
 * How old an orphaned signal must be before startup housekeeping removes it.
 *
 * Startup means no round of *this* bridge is in flight, but a second process
 * sharing the profile could have written one moments ago. Anything younger is
 * left for the next startup — the point is bounding accumulation, not
 * reclaiming a few bytes promptly.
 */
const SIGNAL_ORPHAN_GRACE_MS = 3_600_000;

export interface GoalState {
  /**
   * Identifies this goal, not this scope. A round that finishes after its goal
   * was cancelled must not be able to act on whatever goal replaced it, and
   * scope alone cannot tell the two apart.
   */
  id: string;
  scope: string;
  /** What the user asked for, verbatim — re-stated to the agent every round. */
  goal: string;
  /** Rounds already completed. The run in flight is round `round + 1`. */
  round: number;
  startedAt: number;
  deadlineAt: number;
  maxRounds: number;
  chatId: string;
  threadId?: string;
  /** Why the agent said it wasn't done yet, from the last round. */
  lastReason?: string;
  /** How many rounds in a row gave that same reason. */
  sameReasonStreak: number;
  /** `interrupted` survives a bridge restart so the user can `/goal resume`. */
  status: 'active' | 'interrupted';
}

export type GoalStop =
  | 'done'
  | 'max-rounds'
  | 'deadline'
  | 'stuck'
  | 'cancelled'
  | 'run-failed'
  | 'silent';

export interface GoalStartInput {
  scope: string;
  goal: string;
  chatId: string;
  threadId?: string;
  maxRounds: number;
  maxHours: number;
  now: number;
}

type StopByLimit = Extract<GoalStop, 'max-rounds' | 'deadline' | 'stuck'>;

export type GoalAdvance =
  | { ok: true; state: GoalState }
  | { ok: false; stop: StopByLimit; state: GoalState };

interface GoalData {
  entries: Record<string, GoalState>;
}

export class GoalController {
  private data: GoalData = { entries: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string | undefined;
  /**
   * Where continuation signals are written.
   *
   * Next to the goal file rather than in `os.tmpdir()`: a tmp cleaner removing
   * a signal between the agent writing it and the bridge reading it is
   * indistinguishable from the agent never writing one, and that reads as
   * "goal achieved". Memory-only controllers (tests) have nowhere better.
   */
  readonly signalDir: string;

  /**
   * `path` is the profile's goal file. Omitting it makes the controller
   * memory-only — deliberate rather than defaulting to a shared location: goal
   * state is per-profile, and a file shared between processes would let a goal
   * started in one bridge turn up as an interrupted goal in another.
   */
  constructor(path?: string) {
    this.path = path;
    this.signalDir = path
      ? join(dirname(path), 'goal-signals')
      : join(tmpdir(), 'lark-channel-goal');
  }

  /** This round's signal file. See {@link signalDir} and {@link GoalState.id}. */
  signalPath(goalId: string, round: number): string {
    return join(this.signalDir, `${goalId}.${round}.continue`);
  }

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<GoalData>;
      this.data = { entries: adoptEntries(parsed.entries) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('goal', 'load-failed', { err: String(err) });
    }
  }

  get(scope: string): GoalState | undefined {
    const state = this.data.entries[scope];
    return state?.status === 'active' ? state : undefined;
  }

  /** Includes goals a restart cut short — the ones `/goal resume` can pick up. */
  getAny(scope: string): GoalState | undefined {
    return this.data.entries[scope];
  }

  start(input: GoalStartInput): GoalState {
    const maxRounds = clamp(input.maxRounds, 1, ROUND_CEILING);
    const maxHours = clamp(input.maxHours, 1, HOURS_CEILING);
    const state: GoalState = {
      id: randomUUID(),
      scope: input.scope,
      goal: input.goal,
      round: 0,
      startedAt: input.now,
      deadlineAt: input.now + maxHours * 3_600_000,
      maxRounds,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      sameReasonStreak: 0,
      status: 'active',
    };
    this.data.entries[input.scope] = state;
    this.schedulePersist();
    log.info('goal', 'start', { scope: input.scope, maxRounds, maxHours });
    return state;
  }

  /**
   * The agent asked for another round. Returns whether it gets one — every
   * limit is checked here so there is exactly one place a goal can be extended.
   */
  advance(scope: string, id: string, reason: string, now: number): GoalAdvance | undefined {
    const state = this.get(scope);
    if (!state || state.id !== id) return undefined;
    const trimmed = reason.trim().slice(0, REASON_MAX_CHARS);
    const next: GoalState = {
      ...state,
      round: state.round + 1,
      lastReason: trimmed,
      sameReasonStreak: trimmed && trimmed === state.lastReason ? state.sameReasonStreak + 1 : 0,
    };
    this.data.entries[scope] = next;
    this.schedulePersist();

    if (next.round >= next.maxRounds) return this.stopWith(scope, next, 'max-rounds');
    if (now >= next.deadlineAt) return this.stopWith(scope, next, 'deadline');
    // Same reason N rounds running means the agent is restating a blocker it
    // cannot clear, not making progress toward it.
    if (next.sameReasonStreak + 1 >= STUCK_REPEATS) return this.stopWith(scope, next, 'stuck');
    return { ok: true, state: next };
  }

  private stopWith(scope: string, state: GoalState, stop: StopByLimit): GoalAdvance {
    delete this.data.entries[scope];
    this.schedulePersist();
    log.info('goal', 'stop', { scope, stop, round: state.round });
    return { ok: false, stop, state };
  }

  /**
   * The agent finished, the round failed, or the user cancelled.
   *
   * `expectId` is how a finishing round proves it is still the current goal —
   * without it a round that outlived a `/goal off` would close whatever goal
   * was started next. `/stop` passes none: it ends whatever is running.
   *
   * `roundsRun` records the round that just finished. `round` otherwise only
   * advances when another round is *requested*, so a goal closed on its first
   * round would report "共 0 轮".
   */
  end(
    scope: string,
    stop: Extract<GoalStop, 'done' | 'cancelled' | 'run-failed' | 'silent'>,
    opts: { expectId?: string; roundsRun?: number } = {},
  ): GoalState | undefined {
    const state = this.data.entries[scope];
    if (!state) return undefined;
    if (opts.expectId !== undefined && state.id !== opts.expectId) return undefined;
    delete this.data.entries[scope];
    const ended =
      opts.roundsRun !== undefined ? { ...state, round: opts.roundsRun } : state;
    this.schedulePersist();
    log.info('goal', 'stop', { scope, stop, round: ended.round });
    return ended;
  }

  /**
   * Called once at startup: a bridge restart kills every in-flight run, so any
   * goal still marked active was cut off mid-flight. Park them as `interrupted`
   * rather than resuming automatically — a restart is usually a deploy, and
   * silently firing agent runs at boot is not something the user asked for.
   */
  markInterrupted(): GoalState[] {
    const cut: GoalState[] = [];
    for (const [scope, state] of Object.entries(this.data.entries)) {
      if (state.status !== 'active') continue;
      const next: GoalState = { ...state, status: 'interrupted' };
      this.data.entries[scope] = next;
      cut.push(next);
    }
    if (cut.length > 0) {
      this.schedulePersist();
      log.info('goal', 'interrupted-by-restart', { count: cut.length });
    }
    return cut;
  }

  /** Re-arm a goal a restart cut short, keeping its text and round count. */
  resume(scope: string, now: number, maxHours: number): GoalState | undefined {
    const state = this.data.entries[scope];
    if (!state || state.status !== 'interrupted') return undefined;
    const next: GoalState = {
      ...state,
      status: 'active',
      deadlineAt: now + clamp(maxHours, 1, HOURS_CEILING) * 3_600_000,
      sameReasonStreak: 0,
    };
    this.data.entries[scope] = next;
    this.schedulePersist();
    log.info('goal', 'resume', { scope, round: next.round });
    return next;
  }

  /**
   * Delete continuation signals no goal can ever read again.
   *
   * A signal is consumed when its round is read; a bridge killed between the
   * agent writing one and the round reading it leaves the file behind, and if
   * that goal is then replaced rather than resumed, nothing ever looks at its
   * path again. Called at startup, where no round can be in flight by
   * definition — but still restricted to unknown goal ids and week-old files,
   * so a second process sharing the profile cannot lose a live round's signal.
   */
  async sweepSignals(now: number): Promise<number> {
    const live = new Set(Object.values(this.data.entries).map((state) => state.id));
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(this.signalDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const id = name.split('.')[0];
      if (id && live.has(id)) continue;
      const path = join(this.signalDir, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs < SIGNAL_ORPHAN_GRACE_MS) continue;
        await rm(path, { force: true });
        removed++;
      } catch {
        // Raced with something else removing it, or unreadable — either way
        // this is best-effort housekeeping and must never fail a startup.
      }
    }
    if (removed > 0) log.info('goal', 'signals-swept', { removed });
    return removed;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    const path = this.path;
    if (!path) return;
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      })
      .catch((err: unknown) => log.fail('goal', err, { step: 'persist' }));
  }
}

/**
 * Give every loaded goal an id.
 *
 * `id` is what stops a finished round from acting on a different goal, and what
 * keeps two goals' signal files apart. A record written before ids existed — or
 * one hand-edited — would silently disable both: `expectId: undefined` skips
 * the identity check, and every such goal shares the signal path
 * `undefined.<round>.continue`. Minting one on load restores both guarantees,
 * and costs nothing for records that already have one.
 */
function adoptEntries(entries: Record<string, GoalState> | undefined): Record<string, GoalState> {
  const out: Record<string, GoalState> = {};
  for (const [scope, state] of Object.entries(entries ?? {})) {
    if (!state || typeof state !== 'object') continue;
    out[scope] = typeof state.id === 'string' && state.id ? state : { ...state, id: randomUUID() };
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

/**
 * What this round's signal file said.
 *
 * `unreadable` exists because "the agent chose not to continue" and "we could
 * not find out" look identical on disk, and collapsing them means a broken
 * signal channel silently reports every goal as achieved.
 */
export type GoalSignal =
  | { kind: 'none' }
  | { kind: 'continue'; reason: string }
  | { kind: 'unreadable'; error: string };

/** Read this round's signal and consume it, so it can only ever count once. */
export async function readGoalSignal(path: string): Promise<GoalSignal> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // Absent is the normal "done" case. Anything else — permissions, a broken
    // mount, an I/O error — means the answer is unknown, not "no".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unreadable', error: String(err) };
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
  const reason = raw.trim().slice(0, REASON_MAX_CHARS);
  return reason ? { kind: 'continue', reason } : { kind: 'none' };
}

/**
 * Make sure a stale file can't be read as this round's, and that the directory
 * exists. Throws if it cannot: starting a round whose signal can never be
 * written would end the goal as "achieved" the moment the round finished.
 */
export async function prepareGoalSignal(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
}

/**
 * The protocol, restated every round because the path changes every round.
 *
 * Deliberately framed around "写文件 = 还没完" rather than a done-marker: the
 * agent has to take an action to extend it, so every way of failing —
 * crashing, being interrupted, forgetting — lands on "stop".
 */
export function goalProtocolInstruction(input: {
  goal: string;
  round: number;
  maxRounds: number;
  signalPath: string;
  deadlineAt: number;
  now: number;
}): string {
  const hoursLeft = Math.max(0, Math.round((input.deadlineAt - input.now) / 360_000) / 10);
  return [
    `## 闭环模式(第 ${input.round}/${input.maxRounds} 轮,剩余 ${hoursLeft} 小时)`,
    '',
    `总目标:${input.goal}`,
    '',
    '你在一个会自动续跑的循环里。本轮结束后,bridge 会检查一个信号文件来决定要不要再给你一轮:',
    '',
    '- **目标还没闭环** —— 在本轮结束前把"下一步要做什么"写进这个文件:',
    '  ```bash',
    `  echo '<下一步要做什么,一句话>' > ${JSON.stringify(input.signalPath)}`,
    '  ```',
    '  bridge 会用同一个 session 再起一轮,你的上下文全部保留。',
    '- **目标已经闭环** —— 什么都不用做,不要写那个文件。循环结束。',
    '',
    '要点:',
    '',
    '- 这个文件是**本轮专用**的,路径每轮都变;不要复用、不要提前写。',
    '- 不确定算不算闭环时,**倾向于停**。用户说一句"继续"就能再开,比空转一晚上便宜。',
    '- 别为了"续上"而写文件——没有实质进展就直说卡在哪,连续几轮同样的理由会被判定为卡死并终止。',
    '- 每一轮都要给用户一句人话进度,别只写信号文件。',
    '- 长任务照常**前台阻塞**着跑;续跑解决的是"一轮装不下",不是"可以 detach 了"。',
  ].join('\n');
}

/** The synthetic user turn that opens a continuation round. */
export function goalContinuationTurn(input: { round: number; goal: string; reason: string }): string {
  return [
    `[闭环续跑 · 第 ${input.round} 轮]`,
    '',
    `目标:${input.goal}`,
    `上一轮你写下的下一步:${input.reason}`,
    '',
    '接着干。完成了就正常收尾,别再写信号文件。',
  ].join('\n');
}

export function goalStopText(stop: GoalStop, state: GoalState): string {
  const rounds = `共 ${state.round} 轮`;
  if (stop === 'done') return `✅ 闭环模式结束(${rounds}):agent 判定目标已达成。`;
  if (stop === 'cancelled') return `⏹ 闭环模式已取消(${rounds})。`;
  if (stop === 'silent') {
    return (
      `⚠️ 闭环模式已停(${rounds}):agent 连续两轮一个字都没输出,也没写信号。**目标未完成** —— ` +
      '这不是它判定做完了,是它很可能根本没看到这一轮的输入(headless run 被上一轮遗留的' +
      '后台任务通知吃掉时会这样,零成本返回)。用 `/goal <目标>` 重开一般就好了。'
    );
  }
  if (stop === 'run-failed') {
    return (
      `⚠️ 闭环模式已停(${rounds}):本轮运行出错,没跑完。**目标未完成** —— ` +
      '这不是 agent 说它做好了,是这一轮断了。看日志查原因,确认后用 `/goal <目标>` 重开。'
    );
  }
  if (stop === 'max-rounds') {
    return `⏹ 闭环模式已停(${rounds}):达到轮数上限 ${state.maxRounds}。目标未确认完成,用 \`/goal <目标>\` 可以再开一轮。`;
  }
  if (stop === 'deadline') {
    return `⏹ 闭环模式已停(${rounds}):超过时间上限。目标未确认完成。`;
  }
  return `⏹ 闭环模式已停(${rounds}):连续 ${STUCK_REPEATS} 轮给出同样的理由「${state.lastReason ?? ''}」,判定为卡住而不是在推进。`;
}
