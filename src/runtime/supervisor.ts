import pkg from '../../package.json';
import { startChannel as realStartChannel, type BridgeChannel } from '../bot/channel';
import type { Controls } from '../commands';
import type { AppPaths } from '../config/app-paths';
import { isComplete, type AppConfig } from '../config/schema';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentRun,
  AgentRunOptions,
} from '../agent/types';
import { log } from '../core/logger';
import { refreshOwnerControls } from '../policy/owner';
import { resolveWorkingDirectory } from '../policy/workspace';
import { SessionStore } from '../session/store';
import { SessionCatalog } from '../session/catalog';
import { WorkspaceStore } from '../workspace/store';
import { preFlightChecks } from '../cli/preflight';
import {
  assertReconnectAgentKindUnchanged,
  checkRuntimeAgentAvailability,
  createRuntimeAgent,
  releaseRuntimeLocks,
} from './agent-runtime';
import {
  acquireAppRuntimeLock,
  acquireProfileRuntimeLock,
  type AcquiredRuntimeLock,
} from './locks';
import { resolveProfileRuntime } from './profile-runtime';
import {
  register,
  unregister,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from './registry';

type StartChannelFn = typeof realStartChannel;
type CreateRuntimeAgentFn = typeof createRuntimeAgent;

async function warmupAgent(
  profile: string,
  profileConfig: ProfileConfig,
  agent: AgentAdapter,
): Promise<void> {
  if (!agent.warmup) return;
  const defaultWorkspace = profileConfig.workspaces.default;
  if (!defaultWorkspace) {
    throw new Error(`profile「${profile}」缺少 workspaces.default，无法预热 agent`);
  }
  const workspace = await resolveWorkingDirectory(defaultWorkspace);
  if (!workspace.ok) {
    throw new Error(
      `profile「${profile}」的 workspaces.default 无效，无法预热 agent：${workspace.userVisible}`,
    );
  }
  await agent.warmup(workspace.cwdRealpath);
}

class ProfileStartCancelledError extends Error {
  constructor(profile: string) {
    super(`profile start cancelled: ${profile}`);
    this.name = 'ProfileStartCancelledError';
  }
}

/**
 * A newly connected channel may receive an event before startChannel() returns
 * its disconnect handle. Keep its adapter behind this gate until the supervisor
 * atomically adopts the generation. Cancellation releases blocked submitters
 * with an error without ever invoking the underlying adapter.
 */
class GenerationAgentGate implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  private state: 'pending' | 'active' | 'cancelled' = 'pending';
  private readonly ready: Promise<void>;
  private releaseReady!: () => void;

  constructor(private readonly delegate: AgentAdapter) {
    this.id = delegate.id;
    this.displayName = delegate.displayName;
    this.ready = new Promise<void>((resolve) => {
      this.releaseReady = resolve;
    });
  }

  activate(): void {
    if (this.state !== 'pending') return;
    this.state = 'active';
    this.releaseReady();
  }

  cancel(): void {
    if (this.state === 'cancelled') return;
    this.state = 'cancelled';
    this.releaseReady();
  }

  isAvailable(): Promise<boolean> {
    return this.delegate.isAvailable();
  }

  async prepareRun(opts: AgentRunOptions): Promise<void> {
    await this.ready;
    this.assertActive();
    await this.delegate.prepareRun?.(opts);
    this.assertActive();
  }

  run(opts: AgentRunOptions): AgentRun {
    this.assertActive();
    return this.delegate.run(opts);
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.delegate.setBotIdentity?.(identity);
  }

  private assertActive(): void {
    if (this.state !== 'active') {
      throw new Error('agent generation is not active');
    }
  }
}

interface PendingStart {
  cancelled: boolean;
  appId?: string;
  managed?: ManagedProfile;
  task?: Promise<void>;
  cancel?: () => void;
}

export interface SupervisorOptions {
  /** Root config path (config.json). */
  configPath: string;
  /** LARK_CHANNEL_HOME root; undefined = default. */
  rootDir?: string;
  /** Injectable for tests (defaults to the real startChannel). */
  startChannelFn?: StartChannelFn;
  /** Injectable for deterministic lifecycle tests. */
  createAgentFn?: CreateRuntimeAgentFn;
  /** Run lark-cli preflight per profile (default true; tests pass false). */
  runPreflight?: boolean;
}

export interface ManagedStatus {
  profile: string;
  agentKind: AgentKind;
  online: boolean;
  pid: number;
  startedAt?: string;
  botName?: string;
  appId?: string;
}

/**
 * One profile's live bridge inside the supervisor. Owns its locks, registry
 * entry, stores, channel and `controls`. `stop()` tears down ONLY this profile
 * (no process.exit) so the supervisor keeps hosting the others.
 */
class ManagedProfile {
  bridge!: BridgeChannel;
  controls!: Controls;
  locks: AcquiredRuntimeLock[] = [];
  entry!: ProcessEntry;
  startedAt = '';
  private restartTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private startCleanupTask: Promise<void> | undefined;
  private stopping = false;
  private activated = false;
  private activeAgentGate: GenerationAgentGate | undefined;
  private restartCandidateGate: GenerationAgentGate | undefined;
  private restartCandidateControls: Controls | undefined;
  private restartCandidateAgent: AgentAdapter | undefined;
  private readonly agentShutdownTasks = new WeakMap<AgentAdapter, Promise<void>>();

  constructor(
    readonly profile: string,
    private appPaths: AppPaths,
    private configPath: string,
    private cfg: AppConfig,
    private profileConfig: ProfileConfig,
    private agent: AgentAdapter,
    private sessions: SessionStore,
    private sessionCatalog: SessionCatalog,
    private workspaces: WorkspaceStore,
    private startChannelFn: StartChannelFn,
    private createAgentFn: CreateRuntimeAgentFn,
    private onExitCommand: (profile: string) => void,
  ) {}

  get appId(): string {
    return this.cfg.accounts.app.id;
  }

  get botName(): string | undefined {
    return this.bridge?.channel.botIdentity?.name;
  }

  async bringUp(nowIso: string): Promise<void> {
    this.startedAt = nowIso;
    // Acquire sequentially, pushing as we go: if the app lock throws (e.g. the
    // same app is running elsewhere) the already-held profile lock is still in
    // this.locks and gets released by the catch — otherwise it would leak and
    // a retry in the same process would fail to re-lock.
    this.locks = [];
    try {
      this.throwIfStopping();
      this.locks.push(await acquireProfileRuntimeLock(this.appPaths, this.profileConfig.agentKind));
      this.throwIfStopping();
      this.locks.push(
        await acquireAppRuntimeLock(this.appPaths, this.appId, this.profileConfig.agentKind),
      );
      this.throwIfStopping();
      await warmupAgent(this.profile, this.profileConfig, this.agent);
      this.throwIfStopping();
      this.entry = await register({
        appId: this.appId,
        tenant: this.cfg.accounts.app.tenant,
        profileName: this.appPaths.profile,
        agentKind: this.profileConfig.agentKind,
        configPath: this.configPath,
        version: pkg.version,
        registryFile: this.appPaths.userRegistryFile,
      });
      this.throwIfStopping();
      this.controls = this.makeControls(this.appPaths, this.cfg, this.profileConfig);
      this.activeAgentGate = new GenerationAgentGate(this.agent);
      this.bridge = await this.startChannelFn({
        cfg: this.cfg,
        agent: this.activeAgentGate,
        sessions: this.sessions,
        sessionCatalog: this.sessionCatalog,
        workspaces: this.workspaces,
        controls: this.controls,
        appPaths: this.appPaths,
      });
      this.throwIfStopping();
      const botName = this.bridge.channel.botIdentity?.name;
      if (botName) {
        await updateEntry(this.entry.id, { botName }, this.appPaths.userRegistryFile).catch((err) =>
          log.warn('registry', 'update-failed', { step: 'botName', err: String(err) }),
        );
      }
      this.throwIfStopping();
    } catch (err) {
      await this.cleanupFailedStart();
      throw err;
    }
  }

  activate(): void {
    this.throwIfStopping();
    if (this.controls.runtime) this.controls.runtime.intakeEnabled = true;
    this.activeAgentGate?.activate();
    this.activated = true;
  }

  cancelStart(): void {
    this.stopping = true;
    if (this.controls?.runtime) this.controls.runtime.intakeEnabled = false;
    if (this.restartCandidateControls?.runtime) {
      this.restartCandidateControls.runtime.intakeEnabled = false;
    }
    this.activeAgentGate?.cancel();
    this.restartCandidateGate?.cancel();
    if (!this.activated) void this.shutdownAgent(this.agent, 'agent-shutdown-failed');
    if (this.restartCandidateAgent) {
      void this.shutdownAgent(this.restartCandidateAgent, 'agent-shutdown-failed');
    }
  }

  abortStart(): Promise<void> {
    this.cancelStart();
    return this.cleanupFailedStart();
  }

  private throwIfStopping(): void {
    if (this.stopping) throw new ProfileStartCancelledError(this.profile);
  }

  private cleanupFailedStart(): Promise<void> {
    if (this.startCleanupTask) return this.startCleanupTask;
    const task = this.performFailedStartCleanup();
    this.startCleanupTask = task;
    return task;
  }

  private async performFailedStartCleanup(): Promise<void> {
    this.activeAgentGate?.cancel();
    try {
      await this.bridge?.disconnect();
    } catch (err) {
      log.warn('supervisor', 'disconnect-failed', { profile: this.profile, err: String(err) });
    }
    await this.shutdownAgent(this.agent, 'agent-shutdown-failed');
    if (this.entry) {
      await unregister(this.entry.id, this.appPaths.userRegistryFile).catch(() =>
        unregisterSync(this.entry.id, this.appPaths.userRegistryFile),
      );
    }
    await releaseRuntimeLocks(this.locks);
    this.locks = [];
  }

  private shutdownAgent(agent: AgentAdapter, event: string): Promise<void> {
    const existing = this.agentShutdownTasks.get(agent);
    if (existing) return existing;
    const task = (async () => {
      await agent.shutdown?.();
    })().catch((err) => {
      log.warn('supervisor', event, { profile: this.profile, err: String(err) });
    });
    this.agentShutdownTasks.set(agent, task);
    return task;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.cancelStart();

    // disconnect() synchronously pauses new runs before its first await. Invoke
    // it as soon as stop is requested instead of leaving the active bridge live
    // while an in-flight restart warms up or connects its candidate.
    const activeTeardown = this.teardownActiveGeneration(this.bridge, this.agent);
    const task = this.finishStop(activeTeardown);
    this.stopTask = task;
    return task;
  }

  private async teardownActiveGeneration(
    bridge: BridgeChannel,
    agent: AgentAdapter,
  ): Promise<void> {
    try {
      await bridge.disconnect();
    } catch (err) {
      log.warn('supervisor', 'disconnect-failed', { profile: this.profile, err: String(err) });
    }
    await this.shutdownAgent(agent, 'agent-shutdown-failed');
  }

  private async finishStop(activeTeardown: Promise<void>): Promise<void> {
    await activeTeardown;
    // A restart that was already in flight owns its candidate generation. Wait
    // for it to observe `stopping` and tear that pair down before releasing the
    // shared runtime bookkeeping and locks.
    await this.restartTask?.catch(() => undefined);
    if (this.entry) {
      await unregister(this.entry.id, this.appPaths.userRegistryFile).catch(() =>
        unregisterSync(this.entry.id, this.appPaths.userRegistryFile),
      );
    }
    await releaseRuntimeLocks(this.locks);
    this.locks = [];
  }

  /** Best-effort sync unregister for the process 'exit' hook. */
  unregisterSelfSync(): void {
    if (this.entry) unregisterSync(this.entry.id, this.appPaths.userRegistryFile);
  }

  status(pid: number): ManagedStatus {
    return {
      profile: this.profile,
      agentKind: this.profileConfig.agentKind,
      online: true,
      pid,
      startedAt: this.startedAt,
      botName: this.botName,
      appId: this.appId,
    };
  }

  private makeControls(
    currentPaths: AppPaths,
    currentCfg: AppConfig,
    currentProfileConfig: ProfileConfig,
  ): Controls {
    const self = this;
    const currentControls: Controls = {
      profile: currentPaths.profile,
      profileConfig: currentProfileConfig,
      runtime: { intakeEnabled: false },
      ownerRefreshState: 'unknown',
      knownChats: [],
      async refreshOwner(channelOverride) {
        const target = channelOverride ?? self.bridge?.channel;
        if (!target) return;
        await refreshOwnerControls(currentControls, target, currentControls.cfg.accounts.app.id);
      },
      configPath: self.configPath,
      cfg: currentCfg,
      processId: self.entry.id,
      async exit() {
        // `/exit` from chat stops THIS profile's channel; the supervisor lives on.
        self.onExitCommand(self.profile);
      },
      async restart() {
        await self.restart();
      },
    };
    return currentControls;
  }

  /** Connect-before-disconnect reconnect for this profile (e.g. after /account). */
  private restart(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.restartTask) return this.restartTask;
    const task = this.performRestart();
    this.restartTask = task;
    void task.finally(() => {
      if (this.restartTask === task) this.restartTask = undefined;
    }).catch(() => undefined);
    return task;
  }

  private async performRestart(): Promise<void> {
    const oldBridge = this.bridge;
    const oldAgent = this.agent;
    const oldAgentGate = this.activeAgentGate;
    const oldControls = this.controls;
    let nextAppLock: AcquiredRuntimeLock | undefined;
    let nextAgent: AgentAdapter | undefined;
    let nextAgentGate: GenerationAgentGate | undefined;
    let nextControls: Controls | undefined;
    let nextBridge: BridgeChannel | undefined;
    let nextAgentAdopted = false;
    try {
      const nextRuntime = await resolveProfileRuntime({
        config: this.configPath,
        profile: this.appPaths.profile,
        allowBootstrap: false,
      });
      const next = nextRuntime.cfg;
      if (!isComplete(next)) throw new Error('config incomplete after change');
      assertReconnectAgentKindUnchanged(this.profileConfig.agentKind, nextRuntime.profileConfig.agentKind);
      if (this.stopping) return;

      nextAgent = this.createAgentFn(nextRuntime.profileConfig, {
        ...nextRuntime.appPaths,
        configPath: nextRuntime.configPath,
      });
      this.restartCandidateAgent = nextAgent;
      const availability = await checkRuntimeAgentAvailability(nextAgent);
      if (!availability.ok) throw availability.error;
      if (this.stopping) return;
      await warmupAgent(this.profile, nextRuntime.profileConfig, nextAgent);
      if (this.stopping) return;

      const appChanged = next.accounts.app.id !== this.cfg.accounts.app.id;
      if (appChanged) {
        nextAppLock = await acquireAppRuntimeLock(
          nextRuntime.appPaths,
          next.accounts.app.id,
          nextRuntime.profileConfig.agentKind,
        );
      }
      if (this.stopping) return;
      nextControls = this.makeControls(nextRuntime.appPaths, next, nextRuntime.profileConfig);
      this.restartCandidateControls = nextControls;
      nextAgentGate = new GenerationAgentGate(nextAgent);
      this.restartCandidateGate = nextAgentGate;
      nextBridge = await this.startChannelFn({
        cfg: next,
        agent: nextAgentGate,
        sessions: this.sessions,
        sessionCatalog: this.sessionCatalog,
        workspaces: this.workspaces,
        controls: nextControls,
        appPaths: nextRuntime.appPaths,
      });
      if (this.stopping) return;

      // Adopt the complete generation atomically (no await in this block), so
      // stop() can only ever capture an old pair or a new pair, never a mix.
      if (oldControls.runtime) oldControls.runtime.intakeEnabled = false;
      this.bridge = nextBridge;
      this.agent = nextAgent;
      this.controls = nextControls;
      this.cfg = next;
      this.profileConfig = nextRuntime.profileConfig;
      this.activeAgentGate = nextAgentGate;
      nextAgentAdopted = true;
      if (this.restartCandidateAgent === nextAgent) this.restartCandidateAgent = undefined;
      if (nextControls.runtime) nextControls.runtime.intakeEnabled = true;
      nextAgentGate.activate();
      oldAgentGate?.cancel();
      try {
        await oldBridge.disconnect();
      } catch (err) {
        log.warn('supervisor', 'old-disconnect-failed', { profile: this.profile, err: String(err) });
      }
      await this.shutdownAgent(oldAgent, 'old-agent-shutdown-failed');
      await updateEntry(
        this.entry.id,
        {
          appId: next.accounts.app.id,
          tenant: next.accounts.app.tenant,
          configPath: this.configPath,
          botName: nextBridge.channel.botIdentity?.name,
        },
        this.appPaths.userRegistryFile,
      ).catch((err) => log.warn('registry', 'update-failed', { err: String(err) }));
      if (nextAppLock) {
        const oldAppLock = this.locks.find((l) => l.kind === 'app');
        this.locks = [...this.locks.filter((l) => l.kind !== 'app'), nextAppLock];
        nextAppLock = undefined;
        await oldAppLock?.release().catch(() => undefined);
      }
    } finally {
      if (nextAgent && !nextAgentAdopted) {
        nextAgentGate?.cancel();
        await nextBridge?.disconnect().catch(() => undefined);
        await this.shutdownAgent(nextAgent, 'agent-shutdown-failed');
      }
      if (this.restartCandidateAgent === nextAgent) this.restartCandidateAgent = undefined;
      if (this.restartCandidateGate === nextAgentGate) this.restartCandidateGate = undefined;
      if (nextControls && this.restartCandidateControls === nextControls) {
        this.restartCandidateControls = undefined;
      }
      if (nextAppLock) await nextAppLock.release().catch(() => undefined);
    }
  }
}

/**
 * The single control-plane process: hosts every profile's bridge in one Node
 * process and lets the web console start/stop/restart/configure each in-memory.
 * No `process.exit` here — the CLI entry owns process lifecycle.
 */
export class Supervisor {
  private managed = new Map<string, ManagedProfile>();
  private pendingStarts = new Map<string, PendingStart>();
  private shuttingDown = false;

  constructor(private opts: SupervisorOptions) {}

  private get startChannelFn(): StartChannelFn {
    return this.opts.startChannelFn ?? realStartChannel;
  }

  private get createAgentFn(): CreateRuntimeAgentFn {
    return this.opts.createAgentFn ?? createRuntimeAgent;
  }

  isOnline(profile: string): boolean {
    return this.managed.has(profile);
  }

  controlsFor(profile: string): Controls | undefined {
    return this.managed.get(profile)?.controls;
  }

  channelFor(profile: string) {
    return this.managed.get(profile)?.bridge.channel;
  }

  list(): ManagedStatus[] {
    return [...this.managed.values()].map((m) => m.status(process.pid));
  }

  /** Bring a profile online inside this process. Throws on lock/app conflict. */
  startProfile(profile: string): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('supervisor is shutting down'));
    if (this.managed.has(profile)) return Promise.resolve();
    const existing = this.pendingStarts.get(profile);
    if (existing?.task) return existing.task;

    // Reserve the profile synchronously, before the first config/preflight
    // await, so stopProfile() and shutdown() can always observe and cancel it.
    const pending: PendingStart = { cancelled: false };
    const task = this.performStartProfile(profile, pending);
    pending.task = task;
    this.pendingStarts.set(profile, pending);
    void task
      .finally(() => {
        if (this.pendingStarts.get(profile) === pending) this.pendingStarts.delete(profile);
      })
      .catch(() => undefined);
    return task;
  }

  private async performStartProfile(profile: string, pending: PendingStart): Promise<void> {
    let agent: AgentAdapter | undefined;
    let managed: ManagedProfile | undefined;
    let pendingAgentShutdownTask: Promise<void> | undefined;
    const shutdownPendingAgent = (): Promise<void> => {
      if (pendingAgentShutdownTask) return pendingAgentShutdownTask;
      if (!agent) return Promise.resolve();
      pendingAgentShutdownTask = (async () => {
        await agent?.shutdown?.();
      })().catch((shutdownErr) => {
        log.warn('supervisor', 'agent-shutdown-failed', {
          profile,
          err: String(shutdownErr),
        });
      });
      return pendingAgentShutdownTask;
    };
    try {
      const runtime = await resolveProfileRuntime({
        config: this.opts.configPath,
        profile,
        allowBootstrap: false,
      });
      this.assertStartNotCancelled(profile, pending);
      const { cfg, appPaths, profileConfig, configPath } = runtime;
      if (!isComplete(cfg)) throw new Error(`profile 配置不完整：${profile}`);
      pending.appId = cfg.accounts.app.id;

      // Dedupe by app id — including other starts that have resolved config but
      // have not finished connecting yet.
      for (const m of this.managed.values()) {
        if (m.appId === cfg.accounts.app.id) {
          throw new Error(`该飞书应用已被 profile「${m.profile}」连接，不能重复上线`);
        }
      }
      for (const [otherProfile, other] of this.pendingStarts) {
        if (other !== pending && !other.cancelled && other.appId === cfg.accounts.app.id) {
          throw new Error(`该飞书应用已被 profile「${otherProfile}」连接，不能重复上线`);
        }
      }

      if (this.opts.runPreflight !== false) {
        await preFlightChecks({
          bridgeConfig: cfg,
          profileConfig,
          appPaths,
          larkChannel: {
            profile: appPaths.profile,
            rootDir: appPaths.rootDir,
            configPath,
            larkCliConfigDir: appPaths.larkCliConfigDir,
            larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
          },
        });
        this.assertStartNotCancelled(profile, pending);
      }

      agent = this.createAgentFn(profileConfig, { ...appPaths, configPath });
      pending.cancel = () => {
        void shutdownPendingAgent();
      };
      if (this.opts.runPreflight !== false) {
        const availability = await checkRuntimeAgentAvailability(agent);
        if (!availability.ok) throw availability.error;
        this.assertStartNotCancelled(profile, pending);
      }

      const sessions = new SessionStore(appPaths.sessionsFile);
      await sessions.load();
      this.assertStartNotCancelled(profile, pending);
      const sessionCatalog = new SessionCatalog(`${appPaths.sessionsFile}.catalog.json`);
      await sessionCatalog.load();
      this.assertStartNotCancelled(profile, pending);
      const workspaces = new WorkspaceStore(appPaths.workspacesFile);
      await workspaces.load();
      this.assertStartNotCancelled(profile, pending);

      managed = new ManagedProfile(
        appPaths.profile,
        appPaths,
        configPath,
        cfg,
        profileConfig,
        agent,
        sessions,
        sessionCatalog,
        workspaces,
        this.startChannelFn,
        this.createAgentFn,
        (p) => void this.stopProfile(p).catch(() => undefined),
      );
      pending.managed = managed;
      pending.cancel = () => managed?.cancelStart();
      if (pending.cancelled || this.shuttingDown) managed.cancelStart();
      await managed.bringUp(new Date().toISOString());
      this.assertStartNotCancelled(profile, pending);

      // Publish and activate without an await between them. A concurrent stop
      // therefore sees either the pending start or the complete live profile.
      this.managed.set(appPaths.profile, managed);
      this.pendingStarts.delete(profile);
      managed.activate();
      log.info('supervisor', 'profile-online', { profile: appPaths.profile, appId: cfg.accounts.app.id });
    } catch (err) {
      if (managed) {
        if (this.managed.get(profile) === managed) this.managed.delete(profile);
        await managed.abortStart();
      } else if (agent) {
        await shutdownPendingAgent();
      }
      throw err;
    }
  }

  private assertStartNotCancelled(profile: string, pending: PendingStart): void {
    if (pending.cancelled || this.shuttingDown) throw new ProfileStartCancelledError(profile);
  }

  /** Take a profile offline (in-process). The supervisor keeps running. */
  async stopProfile(profile: string): Promise<void> {
    const pending = this.pendingStarts.get(profile);
    if (pending) {
      pending.cancelled = true;
      pending.cancel?.();
      await pending.task?.catch(() => undefined);
      log.info('supervisor', 'profile-offline', { profile });
      return;
    }
    const managed = this.managed.get(profile);
    if (!managed) return;
    this.managed.delete(profile);
    await managed.stop();
    log.info('supervisor', 'profile-offline', { profile });
  }

  async restartProfile(profile: string): Promise<void> {
    const managed = this.managed.get(profile);
    if (!managed) throw new Error(`profile 未在运行：${profile}`);
    await managed.controls.restart();
  }

  /** Stop every profile — for process shutdown. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = [...this.pendingStarts.values()];
    for (const start of pending) {
      start.cancelled = true;
      start.cancel?.();
    }
    const all = [...this.managed.values()];
    this.managed.clear();
    await Promise.allSettled([
      ...all.map((m) => m.stop()),
      ...pending.flatMap((start) => (start.task ? [start.task] : [])),
    ]);
  }

  /** Sync best-effort unregister of all entries (for the process 'exit' hook). */
  unregisterAllSync(): void {
    for (const m of this.managed.values()) m.unregisterSelfSync();
    for (const start of this.pendingStarts.values()) start.managed?.unregisterSelfSync();
  }
}
