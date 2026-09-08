import { createHash } from 'node:crypto';
import { open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatMode } from './chat-mode-cache';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * 后台回执 — how a detached job gets the agent's attention after its run ended.
 *
 * A headless run is one-shot. Work that outlives it (`nohup`, `setsid`) keeps
 * going, but the agent that started it is gone, so the only thing that job can
 * do is *speak* — and until now the only way it could speak was to send a
 * Feishu message. With the profile's lark-cli defaulting to user identity that
 * message went out **as the user**, which in a p2p chat came straight back to
 * the bridge as a fresh user message and started another run. That accident is
 * what made DMs look like they continued on their own; groups dropped the same
 * message at the @-mention gate, which is why they stopped instead.
 *
 * This replaces the accident with a channel that says what it means:
 *
 *   detached job ──writes──▶ <token>.wake ──sweeper──▶ bot posts it (as the bot)
 *                                                  └─▶ injects it into the scope
 *
 * Two properties the old path could not offer. The progress note is attributed
 * to the bot rather than impersonating the user, and the wake-up is routed by
 * scope rather than by chat type — so a group behaves exactly like a DM.
 *
 * Routing lives in a file rather than memory so a bridge restart doesn't
 * strand jobs that are still running: the path a job holds is derived from the
 * scope alone, so it stays valid across restarts and redeploys.
 *
 * Delivery is **at-least-once**, deliberately. A report is removed only after
 * it has been handed off, so a crash mid-delivery replays it on the next start
 * rather than swallowing it; the cost is that a delivery whose file could not
 * then be unlinked is seen twice. For a progress note that trade is the right
 * way round — a duplicate is noise, a loss is the silence this channel exists
 * to prevent.
 */

/** How often the inbox is swept. Wakes are human-scale; sub-second is pointless. */
const POLL_MS = 2_000;
const HOUR_MS = 3_600_000;
/** Wake text is echoed into a Feishu message and a prompt. Keep it a note. */
const TEXT_MAX_CHARS = 2_000;
/**
 * Hard cap on bytes read from a wake file.
 *
 * The prompt says this file is a note, not a log — but `cmd > "$WAKE"` is one
 * character away from the documented form, and reading a redirected build log
 * into memory to then throw all but 2000 characters of it away is a footgun
 * with no upside. Four bytes per character covers the widest UTF-8 sequence,
 * so the cap can never truncate below {@link TEXT_MAX_CHARS} of real text.
 */
const READ_MAX_BYTES = TEXT_MAX_CHARS * 4;
/**
 * How long a half-written report is kept. The documented write is `mktemp`
 * then `mv … .wake`, so a file still sitting under its `mktemp` name is a job
 * that died between the two.
 *
 * A day rather than an hour because the only thing distinguishing "abandoned"
 * from "still being written" is age, and a job blocked on a slow pipe is not
 * abandoned. Deleting its file makes the final `mv` fail and the report is
 * gone; keeping a dead one costs a few hundred bytes for another day.
 */
const TMP_TTL_MS = 24 * HOUR_MS;
/**
 * Per-scope wake ceiling over a rolling hour.
 *
 * The old accidental loop had no bound at all — a script in a retry loop could
 * start runs until someone noticed. This is the bound: generous enough for a
 * chatty pipeline reporting each of a few dozen steps, low enough that a stuck
 * job burns a rate-limit notice instead of a night of API calls.
 */
const MAX_WAKES_PER_HOUR = 30;
/** At most one "you hit the ceiling" notice per scope per hour. */
const THROTTLE_NOTICE_MS = HOUR_MS;
/**
 * Suffix a wake carries while it is being delivered.
 *
 * Every decision about a file — how old it is, what it says, whether to remove
 * it — is made *after* renaming it here, never against the name a job can
 * still write to. `stat` then `rm` on the original path is not safe: a report
 * landing between the two is deleted unread, and the atomic `mv` the protocol
 * asks for is exactly what makes that swap possible.
 */
const TAKEN_SUFFIX = '.taken';
/**
 * Splits a wake file's token into `<scopeToken>` and `<runId>`. Not a dot:
 * the token is everything before the *first* dot, so the two halves have to
 * live inside it.
 */
const RUN_SEPARATOR = '-';
/**
 * When a route for a scope nobody has talked to since is dropped at startup.
 *
 * Long, on purpose. A route is ~200 bytes and there is one per conversation
 * the bot has ever run in, so accumulation is not the pressure here — losing
 * one is. Only a run re-arms a route, so a job detached in January and still
 * running in March has nothing refreshing its path: expire the route and its
 * report arrives to a bridge that no longer knows where to put it. The TTL
 * exists only so a bridge that has seen thousands of chats eventually forgets
 * the ones it will never hear from again.
 */
const ROUTE_TTL_MS = 90 * 24 * HOUR_MS;
/**
 * How many runs of one scope keep a resolvable identity.
 *
 * A wake's prefix names the run that launched the job, so a report always
 * threads back to *its own* message and is attributed to whoever started it —
 * not to whoever happened to speak in the chat last. Only distinct identities
 * take a slot, so a chat with one person in it uses exactly one no matter how
 * many runs it has. Past the cap the oldest are forgotten and a very old job's
 * report falls back to the scope's latest run, which is still the right
 * conversation.
 */
const RUNS_PER_SCOPE = 20;
/**
 * How long an undelivered wake stays deliverable.
 *
 * A job finishing while the bridge is down is the *ordinary* case — that is
 * the situation this whole channel exists for — so a restart delivers what it
 * finds rather than clearing it. Past a day, though, the report is stale
 * enough that surfacing it would confuse more than it informs.
 */
const WAKE_TTL_MS = 24 * HOUR_MS;

/** Who a run belonged to, and what its replies thread to. */
export interface WakeRun {
  /** Message replies are threaded to — the run's first message. */
  anchorId: string;
  /**
   * Who started the run this inbox was armed for. A wake re-enters the same
   * access checks as an ordinary message, so it has to be attributed to
   * somebody, and it is the person whose run launched the job — which is why
   * identity is recorded per run rather than per conversation.
   */
  senderId: string;
  at: number;
}

/** Where a wake goes: which conversation, and what to thread the reply to. */
export interface WakeRoute extends WakeRun {
  scope: string;
  chatId: string;
  threadId?: string;
  mode: ChatMode;
  updatedAt: number;
}

/** What a run tells the inbox about itself. See {@link WakeInbox.arm}. */
export interface WakeArm {
  scope: string;
  chatId: string;
  threadId?: string;
  mode: ChatMode;
  anchorId: string;
  senderId: string;
}

/** One scope's routing, plus the runs whose jobs may still report back. */
interface ScopeRoute {
  scope: string;
  chatId: string;
  threadId?: string;
  mode: ChatMode;
  /** Keyed by run id — the second half of a wake file's token. */
  runs: Record<string, WakeRun>;
  updatedAt: number;
}

export interface Wake {
  route: WakeRoute;
  text: string;
  /**
   * `wake` is a real report from a job: post it *and* give the agent a round.
   * `notice` is the bridge talking about the channel itself (rate limiting) —
   * post it, but starting a run to tell the agent it is being throttled would
   * spend exactly the resource the throttle exists to protect.
   */
  kind: 'wake' | 'notice';
}

export type WakeHandler = (wake: Wake) => Promise<void> | void;

/** Told to the user when a scope trips {@link MAX_WAKES_PER_HOUR}. */
export function wakeThrottledText(perHour: number): string {
  return (
    `⚠️ 后台回执被限流:这个会话一小时内已经收到 ${perHour} 条,后面的先丢掉了。\n\n` +
    '通常意味着某个后台任务在循环里反复回执。去看一眼它的日志;确认没问题的话,等一小时自动恢复。'
  );
}

interface ScopeCounter {
  /** Timestamps of accepted wakes inside the rolling window. */
  hits: number[];
  /** When the throttle notice was last emitted, so it isn't repeated. */
  noticedAt?: number;
}

export class WakeInbox {
  /** `undefined` disables the channel entirely — see the constructor. */
  readonly dir: string | undefined;
  /** Keyed by scope token — the first half of a wake file's name. */
  private readonly routes = new Map<string, ScopeRoute>();
  private readonly counters = new Map<string, ScopeCounter>();
  /**
   * Routes whose file is known to be on disk, and when it was written. Held
   * apart from {@link routes} because a failed write still leaves the route
   * usable *in this process* — but a restart would find nothing, so the next
   * run has to try again rather than see an in-memory route and skip.
   */
  private readonly persisted = new Map<string, { route: ScopeRoute; at: number }>();
  private timer?: NodeJS.Timeout;
  private handler?: WakeHandler;
  /** The sweep currently in flight, so `stop()` can wait it out. */
  private sweeping: Promise<number> | undefined;
  private stopped = false;

  /**
   * `dir` is the profile's wake directory. Omitting it turns the channel off
   * rather than falling back to a shared location: two bridges (or two tests)
   * pointed at one directory would deliver each other's wakes, and a tmp
   * cleaner removing a file between the job writing it and the bridge reading
   * it would silently swallow a completion notice. Production always has a
   * profile directory; nothing else should get a working inbox by accident.
   */
  constructor(dir?: string) {
    this.dir = dir;
  }

  get enabled(): boolean {
    return this.dir !== undefined;
  }

  private routePath(scope: string): string | undefined {
    return this.dir ? join(this.dir, `${tokenFor(scope)}.route`) : undefined;
  }

  /**
   * Record where this run's wakes should go, and return the path prefix its
   * detached jobs write under — `undefined` when the channel is off.
   *
   * A prefix rather than one fixed file because two jobs finishing inside the
   * same sweep interval would otherwise overwrite each other: the documented
   * form is `mktemp "<prefix>.XXXXXX"` then `mv` it to `....wake`, so every
   * report gets its own name and nothing is lost to a race.
   *
   * The prefix names the *run*, not just the conversation. A job launched from
   * A's run reports back against A's message even if B has since used the same
   * chat — routing by scope alone would hand A's result to B's thread and
   * attribute it to B.
   */
  async arm(input: WakeArm): Promise<string | undefined> {
    const path = this.routePath(input.scope);
    if (!path) return undefined;
    const token = tokenFor(input.scope);
    const runId = runIdFor(input.anchorId, input.senderId);
    const prefix = join(this.dir as string, `${token}${RUN_SEPARATOR}${runId}`);
    const now = Date.now();
    const prior = this.routes.get(token);
    const next: ScopeRoute = {
      scope: input.scope,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      mode: input.mode,
      runs: pruneRuns({
        ...(prior?.runs ?? {}),
        [runId]: { anchorId: input.anchorId, senderId: input.senderId, at: now },
      }),
      updatedAt: now,
    };
    this.routes.set(token, next);
    // Every run arms, but most runs change nothing about the routing — the run
    // id is derived from the identity, so a chat with one person in it keeps
    // producing the same one. The write is an fsync'd atomic replace, so
    // skipping the no-op case keeps it off the critical path of an ordinary
    // reply. Rewritten anyway once an hour, so an active scope's file keeps a
    // recent mtime and never drifts toward {@link ROUTE_TTL_MS}.
    const written = this.persisted.get(token);
    if (written && sameRouting(written.route, next) && now - written.at < HOUR_MS) return prefix;
    try {
      await writeFileAtomic(path, JSON.stringify(next));
      this.persisted.set(token, { route: next, at: now });
    } catch (err) {
      // In-memory routing still works for this process; only restart recovery
      // is lost. Not worth failing a run over — but the next run must retry,
      // which it will, because nothing was recorded as persisted.
      log.warn('wake', 'arm-failed', { scope: input.scope, err: String(err) });
    }
    return prefix;
  }

  start(handler: WakeHandler): void {
    if (this.timer || !this.dir) return;
    this.stopped = false;
    this.handler = handler;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => log.warn('wake', 'sweep-failed', { err: String(err) }));
    }, POLL_MS);
    // Never hold the process open for a poll: the bridge's lifetime is the
    // channel's, not this timer's.
    this.timer.unref?.();
  }

  /**
   * Stop sweeping, and wait out a sweep already in flight.
   *
   * Both halves matter on shutdown. The in-flight sweep must be allowed to
   * finish the file it has *already consumed* — it was deleted before dispatch,
   * so abandoning it loses the report outright — and the caller must not get
   * back control until it has, or a wake lands in the pending queue after that
   * queue was drained and starts a run against a channel that is closing.
   *
   * Not re-entrant: calling it *from* a handler would await the sweep that is
   * calling it. Handlers that want to stop the inbox should not await this.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.sweeping?.catch(() => undefined);
  }

  /**
   * One pass over the inbox. Exposed for tests, which need it to run on demand
   * rather than on a timer.
   */
  async sweep(): Promise<number> {
    // Overlapping sweeps would dispatch the same file twice — the delete and
    // the read are not one operation.
    if (this.sweeping || !this.dir) return 0;
    const run = this.sweepOnce();
    this.sweeping = run;
    try {
      return await run;
    } finally {
      this.sweeping = undefined;
    }
  }

  private async sweepOnce(): Promise<number> {
    const dir = this.dir;
    if (!dir) return 0;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      // ENOENT just means no run has armed a route yet.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('wake', 'readdir-failed', { err: String(err) });
      }
      return 0;
    }

    const wakes = entries.filter((name) => name.endsWith('.wake'));
    if (wakes.length === 0) return 0;

    // Oldest first: a job that reported "打包完成" then "上传完成" should reach
    // the agent in that order even when both land inside one poll interval.
    // This `stat` only orders them; every decision is made after the rename
    // below, against the file actually held.
    const dated: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of wakes) {
      try {
        dated.push({ name, mtimeMs: (await stat(join(dir, name))).mtimeMs });
      } catch {
        dated.push({ name, mtimeMs: 0 });
      }
    }
    dated.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let dispatched = 0;
    for (const { name } of dated) {
      // Checked before taking anything: a wake still under its original name
      // is untouched, so shutting down here leaves it for the next bridge.
      if (this.stopped) break;
      const path = join(dir, name) + TAKEN_SUFFIX;
      try {
        await rename(join(dir, name), path);
      } catch (err) {
        // Already taken by nobody else (sweeps do not overlap) — so it was
        // removed out from under us. Nothing to deliver.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('wake', 'take-failed', { file: name, err: String(err) });
        }
        continue;
      }
      // From here the file is ours: no job can write to this name, so age and
      // content describe the same bytes and removing it removes what we read.
      const now = Date.now();
      let age = 0;
      try {
        age = now - (await stat(path)).mtimeMs;
      } catch {
        // Unreadable mtime — treat as fresh rather than discard a report.
      }
      if (age > WAKE_TTL_MS) {
        log.info('wake', 'skip-stale', { file: name, ageMs: age });
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      let text: string;
      try {
        text = await readHead(path);
      } catch (err) {
        log.warn('wake', 'read-failed', { file: name, err: String(err) });
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      // Removed only once delivery is done — see the `finally`. Removing it
      // first would make a crash between the two lose the report outright,
      // and the `.taken` name already keeps it out of the next sweep, so
      // there is no re-delivery loop to guard against.
      let keepForRetry = false;
      try {
        const trimmed = text.trim();
        if (!trimmed) {
          log.info('wake', 'skip-empty', { file: name });
          continue;
        }
        const route = await this.routeFor(tokenOf(name));
        if (!route) {
          log.warn('wake', 'skip-unknown-route', { file: name });
          continue;
        }
        const allowed = this.admit(route.scope, Date.now());
        if (allowed === 'throttled') {
          log.warn('wake', 'throttled', { scope: route.scope });
          continue;
        }
        const payload =
          trimmed.length > TEXT_MAX_CHARS
            ? `${trimmed.slice(0, TEXT_MAX_CHARS)}\n…(已截断)`
            : trimmed;
        log.info('wake', 'dispatch', {
          scope: route.scope,
          chars: payload.length,
          ...(allowed === 'throttle-notice' ? { throttleNotice: true } : {}),
        });
        try {
          if (allowed === 'throttle-notice') {
            await this.handler?.({
              route,
              text: wakeThrottledText(MAX_WAKES_PER_HOUR),
              kind: 'notice',
            });
            continue;
          }
          await this.handler?.({ route, text: payload, kind: 'wake' });
          dispatched++;
        } catch (err) {
          // Left behind on purpose: a delivery that threw gets one more chance
          // at the next startup, when `sweepStale` hands `.taken` files back.
          keepForRetry = true;
          log.warn('wake', 'dispatch-failed', { scope: route.scope, err: String(err) });
          continue;
        }
      } finally {
        // `stopped` counts as "keep" too: shutdown drains the pending queue
        // right after this, so a wake that just queued is about to be dropped.
        // Leaving the file lets the next start deliver it for real.
        if (!keepForRetry && !this.stopped) {
          await rm(path, { force: true }).catch((err) =>
            log.warn('wake', 'unlink-failed', { file: name, err: String(err) }),
          );
        }
      }
    }
    return dispatched;
  }

  /** Rolling-window admission. See {@link MAX_WAKES_PER_HOUR}. */
  private admit(scope: string, now: number): 'ok' | 'throttled' | 'throttle-notice' {
    const counter = this.counters.get(scope) ?? { hits: [] };
    counter.hits = counter.hits.filter((at) => now - at < HOUR_MS);
    if (counter.hits.length >= MAX_WAKES_PER_HOUR) {
      const shouldNotice =
        counter.noticedAt === undefined || now - counter.noticedAt >= THROTTLE_NOTICE_MS;
      if (shouldNotice) counter.noticedAt = now;
      this.counters.set(scope, counter);
      return shouldNotice ? 'throttle-notice' : 'throttled';
    }
    counter.hits.push(now);
    this.counters.set(scope, counter);
    return 'ok';
  }

  /**
   * Resolve a wake file's token — `<scopeToken>-<runId>` — into a full route.
   *
   * A run id that is no longer recorded (pruned after many distinct speakers,
   * or a route file rewritten by an older build) falls back to the scope's
   * most recent run. That still lands in the right conversation, which beats
   * discarding a report because its anchor aged out.
   */
  private async routeFor(token: string): Promise<WakeRoute | undefined> {
    const sep = token.indexOf(RUN_SEPARATOR);
    const scopeToken = sep === -1 ? token : token.slice(0, sep);
    const runId = sep === -1 ? undefined : token.slice(sep + 1);
    const scopeRoute = this.routes.get(scopeToken) ?? (await this.loadScopeRoute(scopeToken));
    if (!scopeRoute) return undefined;
    const run = (runId ? scopeRoute.runs[runId] : undefined) ?? newestRun(scopeRoute);
    if (!run) return undefined;
    if (runId && !scopeRoute.runs[runId]) {
      log.info('wake', 'run-fell-back', { scope: scopeRoute.scope });
    }
    return {
      scope: scopeRoute.scope,
      chatId: scopeRoute.chatId,
      ...(scopeRoute.threadId ? { threadId: scopeRoute.threadId } : {}),
      mode: scopeRoute.mode,
      anchorId: run.anchorId,
      senderId: run.senderId,
      at: run.at,
      updatedAt: scopeRoute.updatedAt,
    };
  }

  /** Read a scope's route back from disk — the path after a restart. */
  private async loadScopeRoute(scopeToken: string): Promise<ScopeRoute | undefined> {
    if (!this.dir) return undefined;
    try {
      const parsed = JSON.parse(
        await readFile(join(this.dir, `${scopeToken}.route`), 'utf8'),
      ) as Partial<ScopeRoute>;
      if (!parsed.scope || !parsed.chatId || !parsed.runs) return undefined;
      // The file name is derived from the scope, so a route claiming a scope it
      // does not hash to was not written by this bridge. Refusing it keeps a
      // hand-made file from routing wakes into a conversation that never armed
      // one — and from getting its own rate-limit budget under a made-up scope.
      if (tokenFor(parsed.scope) !== scopeToken) {
        log.warn('wake', 'route-token-mismatch', { token: scopeToken });
        return undefined;
      }
      const runs: Record<string, WakeRun> = {};
      for (const [id, run] of Object.entries(parsed.runs)) {
        if (!run || typeof run.anchorId !== 'string' || typeof run.senderId !== 'string') continue;
        runs[id] = {
          anchorId: run.anchorId,
          senderId: run.senderId,
          at: typeof run.at === 'number' ? run.at : 0,
        };
      }
      if (Object.keys(runs).length === 0) return undefined;
      const route: ScopeRoute = {
        scope: parsed.scope,
        chatId: parsed.chatId,
        ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
        mode: parsed.mode === 'topic' || parsed.mode === 'group' ? parsed.mode : 'p2p',
        runs,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      };
      this.routes.set(scopeToken, route);
      return route;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('wake', 'route-read-failed', { token: scopeToken, err: String(err) });
      }
      return undefined;
    }
  }

  /**
   * Startup housekeeping. Drops routes for scopes that have gone quiet and
   * half-written reports left by a job that died before its rename.
   *
   * Deliberately leaves `.wake` alone: a job that finished while the bridge
   * was restarting is exactly the case this channel is for, and the ordinary
   * sweep both delivers those and ages out the stale ones.
   */
  async sweepStale(now: number): Promise<number> {
    const dir = this.dir;
    if (!dir) return 0;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    let recovered = 0;
    for (const name of entries) {
      const path = join(dir, name);
      // A `.taken` is a report this bridge's predecessor died in the middle of
      // delivering. It was read but never posted, so hand it back to the
      // normal sweep rather than dropping it.
      if (name.endsWith(TAKEN_SUFFIX)) {
        // Named off `now` as well as a counter: two housekeeping passes must
        // not hand back two different reports under one name.
        const stem = name.slice(0, -TAKEN_SUFFIX.length).replace(/\.wake$/, '');
        const back = join(dir, `${stem}.r${now}-${recovered++}.wake`);
        await rename(path, back).catch((err) =>
          log.warn('wake', 'recover-failed', { file: name, err: String(err) }),
        );
        continue;
      }
      // `.wake` is deliberately absent: the normal sweep both delivers and
      // ages those out, so touching them here would only race it.
      if (name.endsWith('.wake')) continue;
      // Everything that is not a route is a half-written report — the
      // `mktemp` name before its `mv`, or `writeFileAtomic`'s own scratch
      // file. Neither ends in a predictable suffix, so age is the only signal.
      const ttl = name.endsWith('.route') ? ROUTE_TTL_MS : TMP_TTL_MS;
      try {
        const info = await stat(path);
        if (now - info.mtimeMs < ttl) continue;
      } catch {
        continue;
      }
      await rm(path, { force: true }).catch(() => undefined);
      removed++;
    }
    if (removed > 0 || recovered > 0) {
      log.info('wake', 'stale-swept', { removed, recovered });
    }
    return removed;
  }
}

/**
 * The synthetic user turn a wake opens.
 *
 * `posted` is whether the report itself reached the chat. It has to be told:
 * if the post failed, the user has seen nothing, and an agent that believes
 * otherwise replies "收到,已完成" over a result nobody ever read.
 */
export function wakeTurn(text: string, opts: { posted: boolean }): string {
  return [
    '[后台回执]',
    '',
    text,
    '',
    opts.posted
      ? '这是你之前 detach 出去的后台任务发回来的。用户已经看到这条原文了,不用复述。'
      : '这是你之前 detach 出去的后台任务发回来的。**这条原文没能发给用户**(飞书发送失败),' +
        '所以用户还不知道结果——请在回复里把关键内容讲清楚。',
    '按它说的情况接着处理;如果这就是全部收尾,给一句简短确认即可。',
  ].join('\n');
}

/** How a wake is shown in the chat, so it reads as the job talking, not the bot. */
export function wakeNoticeText(text: string): string {
  return `🔔 **后台回执**\n\n${text}`;
}

/**
 * Read at most {@link READ_MAX_BYTES} from the head of a file. See that
 * constant for why a plain `readFile` is not good enough here.
 */
async function readHead(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(READ_MAX_BYTES);
    const { bytesRead } = await handle.read(buf, 0, READ_MAX_BYTES, 0);
    const bytes = buf.subarray(0, bytesRead);
    // Cutting at a byte count can split the last multi-byte character. Trim
    // the incomplete sequence itself rather than stripping U+FFFD from the
    // decoded text — a report is free to end with a literal replacement
    // character, and that one should survive.
    return bytes.subarray(0, bytesRead === READ_MAX_BYTES ? wholeUtf8End(bytes) : bytesRead)
      .toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Where to cut `bytes` so it ends on a complete UTF-8 character.
 *
 * Returns the full length unless the tail is a lead byte plus fewer
 * continuation bytes than it announces — the only case a byte-count cut can
 * create, and the only one worth trimming.
 *
 * Exported only so it can be tested directly. Its behaviour is invisible
 * through {@link readHead}: any file long enough to reach the byte cap also
 * exceeds the character cap, so the character-level truncation downstream
 * hides whatever this function did to the last few bytes.
 */
export function wholeUtf8End(bytes: Buffer): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back] as number;
    if (byte >= 0x80 && byte <= 0xbf) continue; // continuation byte — keep looking
    // Only a *valid* lead byte can start a sequence the cut split in half.
    // 0xc0/0xc1 and 0xf5–0xff never appear in well-formed UTF-8, so a trailing
    // one is content the file really contains, not a sequence to trim.
    const needed =
      byte <= 0x7f ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2
        : byte >= 0xe0 && byte <= 0xef ? 3
          : byte >= 0xf0 && byte <= 0xf4 ? 4
            : 0;
    if (needed === 0) return bytes.length;
    return needed > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/** Routing equality, ignoring timestamps. See {@link WakeInbox.arm}. */
function sameRouting(a: ScopeRoute, b: ScopeRoute): boolean {
  if (
    a.scope !== b.scope ||
    a.chatId !== b.chatId ||
    a.threadId !== b.threadId ||
    a.mode !== b.mode
  ) {
    return false;
  }
  const ids = Object.keys(b.runs);
  if (ids.length !== Object.keys(a.runs).length) return false;
  return ids.every((id) => {
    const before = a.runs[id];
    const after = b.runs[id];
    return before !== undefined && after !== undefined && before.anchorId === after.anchorId
      && before.senderId === after.senderId;
  });
}

/** Newest first, capped — see {@link RUNS_PER_SCOPE}. */
function pruneRuns(runs: Record<string, WakeRun>): Record<string, WakeRun> {
  const entries = Object.entries(runs);
  if (entries.length <= RUNS_PER_SCOPE) return runs;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, RUNS_PER_SCOPE));
}

function newestRun(route: ScopeRoute): WakeRun | undefined {
  let best: WakeRun | undefined;
  for (const run of Object.values(route.runs)) {
    if (!best || run.at > best.at) best = run;
  }
  return best;
}

/**
 * Identifies a run by what makes its routing different, not by when it ran —
 * so a conversation with one person in it keeps producing the same id and its
 * route file is written once rather than every turn.
 */
function runIdFor(anchorId: string, senderId: string): string {
  return createHash('sha256').update(`${anchorId}\u0000${senderId}`).digest('hex').slice(0, 8);
}

function tokenFor(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 16);
}

/** `abc123.wake` and `abc123.2.wake` both belong to token `abc123`. */
function tokenOf(fileName: string): string {
  const dot = fileName.indexOf('.');
  return dot === -1 ? fileName : fileName.slice(0, dot);
}

/** Where the wake directory lives inside a profile's state directory. */
export function wakeDirIn(profileDir: string): string {
  return join(profileDir, 'wake');
}

/** Same directory, addressed by the profile's goal file. */
export function wakeDirFor(goalsPath: string): string {
  return wakeDirIn(dirname(goalsPath));
}
