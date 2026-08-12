import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../../../src/agent/types';
import type { BridgeChannel } from '../../../src/bot/channel';
import type { Controls } from '../../../src/commands';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { Supervisor, type SupervisorOptions } from '../../../src/runtime/supervisor';
import { checkRuntimeLock } from '../../../src/runtime/locks';
import { readAndPrune } from '../../../src/runtime/registry';

const roots: string[] = [];
const started: string[] = [];
const disconnected: string[] = [];
let root: string;
let configPath: string;
let sup: Supervisor;

function app(id: string) {
  return { id, secret: '${APP_SECRET}', tenant: 'feishu' as const };
}

// Stub startChannel — no network, records lifecycle, returns a minimal bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubStartChannel: any = async (deps: any) => {
  started.push(deps.appPaths.profile);
  return {
    channel: { botIdentity: { name: `bot-${deps.appPaths.profile}` } },
    disconnect: async () => {
      disconnected.push(deps.appPaths.profile);
    },
  };
};

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function testAgent(
  name: string,
  events: string[],
  warmup: (cwd: string) => Promise<void> = async () => undefined,
  onShutdown?: () => void,
): AgentAdapter {
  return {
    id: 'claude',
    displayName: name,
    isAvailable: async () => true,
    warmup,
    run() {
      throw new Error('run is not used by supervisor lifecycle tests');
    },
    shutdown: async () => {
      events.push(`shutdown:${name}`);
      onShutdown?.();
    },
  };
}

function testBridge(
  name: string,
  events: string[],
  disconnectGate?: Promise<void>,
  onDisconnect?: () => void,
): BridgeChannel {
  return {
    channel: { botIdentity: { name } } as BridgeChannel['channel'],
    disconnect: async () => {
      events.push(`disconnect:${name}`);
      onDisconnect?.();
      await disconnectGate;
    },
  };
}

function useLifecycleSupervisor(
  createAgentFn: NonNullable<SupervisorOptions['createAgentFn']>,
  startChannelFn: NonNullable<SupervisorOptions['startChannelFn']>,
): void {
  sup = new Supervisor({
    configPath,
    rootDir: root,
    runPreflight: false,
    createAgentFn,
    startChannelFn,
  });
}

beforeEach(async () => {
  started.length = 0;
  disconnected.length = 0;
  root = await mkdtemp(join(tmpdir(), 'bridge-sup-'));
  roots.push(root);
  configPath = join(root, 'config.json');

  // claude (cli_a), work (cli_b), dup (cli_b — same app as work).
  await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app('cli_a') } })),
    configPath,
  );
  const rc = (await loadRootConfig(configPath))!;
  for (const [name, id] of [['work', 'cli_b'], ['dup', 'cli_b']] as const) {
    await mkdir(join(root, 'profiles', name), { recursive: true });
    rc.profiles[name] = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app(id) } });
  }
  await saveRootConfig(rc, configPath);

  sup = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel });
});

afterEach(async () => {
  await sup.shutdown();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('Supervisor', () => {
  it('starts a profile in-process and lists it online', async () => {
    await sup.startProfile('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(started).toContain('claude');
    const list = sup.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ profile: 'claude', online: true, pid: process.pid, botName: 'bot-claude' });
  });

  it('hosts multiple profiles at once', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    expect(sup.list().map((s) => s.profile).sort()).toEqual(['claude', 'work']);
  });

  it('stops one profile without affecting others or the process', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    await sup.stopProfile('claude');
    expect(sup.isOnline('claude')).toBe(false);
    expect(disconnected).toContain('claude');
    expect(sup.isOnline('work')).toBe(true); // supervisor + other profile still up
  });

  it('refuses to bring up two profiles sharing one app id', async () => {
    await sup.startProfile('work'); // cli_b
    await expect(sup.startProfile('dup')).rejects.toThrow(/已被 profile/);
    expect(sup.isOnline('dup')).toBe(false);
  });

  it('startProfile is idempotent', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('claude');
    expect(started.filter((p) => p === 'claude')).toHaveLength(1);
  });

  it('fails initial bring-up when an agent warmup has no default workspace', async () => {
    const events: string[] = [];
    let warmupCalls = 0;
    let channelStarts = 0;
    const agent = testAgent('missing-initial-workspace', events, async () => {
      warmupCalls++;
    });
    useLifecycleSupervisor(
      (profileConfig) => {
        delete profileConfig.workspaces.default;
        return agent;
      },
      async ({ agent: startingAgent }) => {
        channelStarts++;
        return testBridge(startingAgent.displayName, events);
      },
    );

    await expect(sup.startProfile('claude')).rejects.toThrow(
      'profile「claude」缺少 workspaces.default，无法预热 agent',
    );

    expect(warmupCalls).toBe(0);
    expect(channelStarts).toBe(0);
    expect(sup.isOnline('claude')).toBe(false);
    expect(events.filter((event) => event === 'shutdown:missing-initial-workspace')).toHaveLength(1);
  });

  it('rejects a broad initial warmup workspace before invoking the agent', async () => {
    const events: string[] = [];
    let warmupCalls = 0;
    let channelStarts = 0;
    const config = (await loadRootConfig(configPath))!;
    config.profiles.claude!.workspaces.default = '/';
    await saveRootConfig(config, configPath);
    const agent = testAgent('unsafe-initial-workspace', events, async () => {
      warmupCalls++;
    });
    useLifecycleSupervisor(
      () => agent,
      async ({ agent: startingAgent }) => {
        channelStarts++;
        return testBridge(startingAgent.displayName, events);
      },
    );

    await expect(sup.startProfile('claude')).rejects.toThrow(
      'profile「claude」的 workspaces.default 无效，无法预热 agent：不能把文件系统根目录设为工作目录。',
    );

    expect(warmupCalls).toBe(0);
    expect(channelStarts).toBe(0);
    expect(sup.isOnline('claude')).toBe(false);
    expect(events.filter((event) => event === 'shutdown:unsafe-initial-workspace')).toHaveLength(1);
  });

  it('cancels an in-flight start blocked in warmup and releases its locks', async () => {
    const events: string[] = [];
    const warmupStarted = deferred();
    const releaseWarmup = deferred();
    const agents = [
      testAgent(
        'cancelled-start',
        events,
        async () => {
          warmupStarted.resolve();
          await releaseWarmup.promise;
        },
        releaseWarmup.resolve,
      ),
      testAgent('retry', events, async () => {
        events.push('warmup:retry');
      }),
    ];
    useLifecycleSupervisor(
      () => {
        const agent = agents.shift();
        if (!agent) throw new Error('unexpected agent generation');
        return agent;
      },
      async ({ agent }) => testBridge(agent.displayName, events),
    );

    const startResult = sup.startProfile('claude').catch((err: unknown) => err);
    await warmupStarted.promise;
    const stopping = sup.stopProfile('claude');

    expect(sup.isOnline('claude')).toBe(false);
    await stopping;
    expect(await startResult).toBeInstanceOf(Error);
    expect(events.filter((event) => event === 'shutdown:cancelled-start')).toHaveLength(1);
    expect(events).not.toContain('disconnect:cancelled-start');

    // A clean retry proves the cancelled start released both runtime locks.
    await sup.startProfile('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(events).toContain('warmup:retry');
  });

  it('shutdown waits for an in-flight startChannel and removes its bridge, registry, and locks', async () => {
    const events: string[] = [];
    const startChannelCalled = deferred();
    const releaseStartChannel = deferred();
    const agent = testAgent('pending-start', events);
    let dispatchBuiltIn: (() => void) | undefined;
    let builtInEffects = 0;
    useLifecycleSupervisor(
      () => agent,
      async ({ controls }) => {
        dispatchBuiltIn = () => {
          if (controls.runtime?.intakeEnabled !== false) builtInEffects++;
        };
        startChannelCalled.resolve();
        await releaseStartChannel.promise;
        return testBridge('pending-start', events);
      },
    );

    const startResult = sup.startProfile('claude').catch((err: unknown) => err);
    await startChannelCalled.promise;
    dispatchBuiltIn?.();
    const shuttingDown = sup.shutdown();
    dispatchBuiltIn?.();

    expect(builtInEffects).toBe(0);
    expect(sup.isOnline('claude')).toBe(false);

    releaseStartChannel.resolve();
    await shuttingDown;
    expect(await startResult).toBeInstanceOf(Error);
    expect(events.filter((event) => event === 'disconnect:pending-start')).toHaveLength(1);
    expect(events.filter((event) => event === 'shutdown:pending-start')).toHaveLength(1);
    expect(readAndPrune(resolveAppPaths({ rootDir: root }).userRegistryFile)).toEqual([]);

    const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await expect(checkRuntimeLock(paths.profileLockFile)).resolves.toMatchObject({ locked: false });
    await expect(checkRuntimeLock(paths.appLockFile('cli_a'))).resolves.toMatchObject({ locked: false });
  });

  it('warms initial and restart agents in their configured workspaces before candidate intake', async () => {
    const events: string[] = [];
    const initialWorkspace = join(root, 'workspace-initial');
    const restartWorkspace = join(root, 'workspace-restart');
    const initialWorkspaceLink = join(root, 'workspace-initial-link');
    const restartWorkspaceLink = join(root, 'workspace-restart-link');
    await Promise.all([
      mkdir(initialWorkspace, { recursive: true }),
      mkdir(restartWorkspace, { recursive: true }),
    ]);
    await Promise.all([
      symlink(initialWorkspace, initialWorkspaceLink, 'dir'),
      symlink(restartWorkspace, restartWorkspaceLink, 'dir'),
    ]);
    const [initialWorkspaceRealpath, restartWorkspaceRealpath] = await Promise.all([
      realpath(initialWorkspace),
      realpath(restartWorkspace),
    ]);
    const initialConfig = (await loadRootConfig(configPath))!;
    initialConfig.profiles.claude!.workspaces.default = initialWorkspaceLink;
    await saveRootConfig(initialConfig, configPath);

    const candidateWarmupStarted = deferred();
    const releaseCandidateWarmup = deferred();
    const warmups: Array<{ agent: string; cwd: string }> = [];
    const agents = [
      testAgent('old', events, async (cwd) => {
        warmups.push({ agent: 'old', cwd });
      }),
      testAgent('candidate', events, async (cwd) => {
        warmups.push({ agent: 'candidate', cwd });
        candidateWarmupStarted.resolve();
        await releaseCandidateWarmup.promise;
      }),
    ];
    let candidateChannelStarts = 0;
    let candidateIntakeAtStart: boolean | undefined;
    let candidateControls: Controls | undefined;
    useLifecycleSupervisor(
      () => {
        const agent = agents.shift();
        if (!agent) throw new Error('unexpected agent generation');
        return agent;
      },
      async ({ agent, controls }) => {
        if (agent.displayName === 'candidate') {
          candidateChannelStarts++;
          candidateIntakeAtStart = controls.runtime?.intakeEnabled;
          candidateControls = controls;
        }
        return testBridge(agent.displayName, events);
      },
    );

    await sup.startProfile('claude');
    expect(warmups).toEqual([{ agent: 'old', cwd: initialWorkspaceRealpath }]);

    const restartConfig = (await loadRootConfig(configPath))!;
    restartConfig.profiles.claude!.workspaces.default = restartWorkspaceLink;
    await saveRootConfig(restartConfig, configPath);

    const restarting = sup.restartProfile('claude');
    await candidateWarmupStarted.promise;

    expect(warmups).toEqual([
      { agent: 'old', cwd: initialWorkspaceRealpath },
      { agent: 'candidate', cwd: restartWorkspaceRealpath },
    ]);
    expect(candidateChannelStarts).toBe(0);
    expect(candidateControls).toBeUndefined();

    releaseCandidateWarmup.resolve();
    await restarting;

    expect(candidateChannelStarts).toBe(1);
    expect(candidateIntakeAtStart).toBe(false);
    expect(candidateControls?.runtime?.intakeEnabled).toBe(true);
  });

  it('rejects a restart candidate warmup without a default workspace', async () => {
    const events: string[] = [];
    let candidateWarmupCalls = 0;
    let candidateChannelStarts = 0;
    const agents = [
      testAgent('old', events),
      testAgent('missing-restart-workspace', events, async () => {
        candidateWarmupCalls++;
      }),
    ];
    useLifecycleSupervisor(
      (profileConfig) => {
        const agent = agents.shift();
        if (!agent) throw new Error('unexpected agent generation');
        if (agent.displayName === 'missing-restart-workspace') {
          delete profileConfig.workspaces.default;
        }
        return agent;
      },
      async ({ agent }) => {
        if (agent.displayName === 'missing-restart-workspace') candidateChannelStarts++;
        return testBridge(agent.displayName, events);
      },
    );
    await sup.startProfile('claude');

    await expect(sup.restartProfile('claude')).rejects.toThrow(
      'profile「claude」缺少 workspaces.default，无法预热 agent',
    );

    expect(candidateWarmupCalls).toBe(0);
    expect(candidateChannelStarts).toBe(0);
    expect(events.filter((event) => event === 'shutdown:missing-restart-workspace')).toHaveLength(1);
    expect(events).not.toContain('disconnect:old');
    expect(events).not.toContain('shutdown:old');
    expect(sup.isOnline('claude')).toBe(true);
  });

  it('rejects an inaccessible restart warmup workspace and preserves the active generation', async () => {
    const events: string[] = [];
    let candidateWarmupCalls = 0;
    let candidateChannelStarts = 0;
    const agents = [
      testAgent('old', events),
      testAgent('invalid-restart-workspace', events, async () => {
        candidateWarmupCalls++;
      }),
    ];
    useLifecycleSupervisor(
      () => {
        const agent = agents.shift();
        if (!agent) throw new Error('unexpected agent generation');
        return agent;
      },
      async ({ agent }) => {
        if (agent.displayName === 'invalid-restart-workspace') candidateChannelStarts++;
        return testBridge(agent.displayName, events);
      },
    );
    await sup.startProfile('claude');

    const restartConfig = (await loadRootConfig(configPath))!;
    restartConfig.profiles.claude!.workspaces.default = join(root, 'missing-restart-workspace');
    await saveRootConfig(restartConfig, configPath);

    await expect(sup.restartProfile('claude')).rejects.toThrow(
      /workspaces\.default 无效.*工作目录不存在或不可访问/,
    );

    expect(candidateWarmupCalls).toBe(0);
    expect(candidateChannelStarts).toBe(0);
    expect(events.filter((event) => event === 'shutdown:invalid-restart-workspace')).toHaveLength(1);
    expect(events).not.toContain('disconnect:old');
    expect(events).not.toContain('shutdown:old');
    expect(sup.isOnline('claude')).toBe(true);
  });

  it('disconnects the active bridge immediately while restart warmup is blocked', async () => {
    const events: string[] = [];
    const warmupStarted = deferred();
    const releaseWarmup = deferred();
    const agents = [
      testAgent('old', events),
      testAgent(
        'candidate',
        events,
        async () => {
          events.push('warmup:candidate');
          warmupStarted.resolve();
          await releaseWarmup.promise;
        },
        releaseWarmup.resolve,
      ),
    ];
    useLifecycleSupervisor(
      () => {
        const agent = agents.shift();
        if (!agent) throw new Error('unexpected agent generation');
        return agent;
      },
      async ({ agent }) => testBridge(agent.displayName, events),
    );
    await sup.startProfile('claude');

    const restarting = sup.restartProfile('claude');
    await warmupStarted.promise;
    const stopping = sup.stopProfile('claude');

    expect(events).toContain('disconnect:old');
    expect(events).not.toContain('disconnect:candidate');

    await Promise.all([restarting, stopping]);

    expect(events.filter((event) => event === 'shutdown:old')).toHaveLength(1);
    expect(events.filter((event) => event === 'shutdown:candidate')).toHaveLength(1);
    expect(events).not.toContain('disconnect:candidate');
  });

  it('tears down a restart candidate that finishes connecting after stop', async () => {
    const events: string[] = [];
    const candidateStartCalled = deferred();
    const releaseCandidateStart = deferred();
    const agents = [testAgent('old', events), testAgent('candidate', events)];
    let dispatchCandidateCommand: (() => void) | undefined;
    let commandEffects = 0;
    useLifecycleSupervisor(
      () => {
        const agent = agents.shift();
        if (!agent) throw new Error('unexpected agent generation');
        return agent;
      },
      async ({ agent, controls }) => {
        if (agent.displayName === 'candidate') {
          dispatchCandidateCommand = () => {
            if (controls.runtime?.intakeEnabled !== false) commandEffects++;
          };
          candidateStartCalled.resolve();
          await releaseCandidateStart.promise;
        }
        return testBridge(agent.displayName, events);
      },
    );
    await sup.startProfile('claude');

    const restarting = sup.restartProfile('claude');
    await candidateStartCalled.promise;
    dispatchCandidateCommand?.();
    const stopping = sup.stopProfile('claude');
    dispatchCandidateCommand?.();

    expect(events).toContain('disconnect:old');
    expect(commandEffects).toBe(0);

    releaseCandidateStart.resolve();
    await Promise.all([restarting, stopping]);

    expect(events.filter((event) => event === 'shutdown:old')).toHaveLength(1);
    expect(events.filter((event) => event === 'disconnect:candidate')).toHaveLength(1);
    expect(events.filter((event) => event === 'shutdown:candidate')).toHaveLength(1);
  });

  it('pairs bridge and agent teardown when stop lands after restart adoption', async () => {
    const events: string[] = [];
    const oldDisconnectStarted = deferred();
    const releaseOldDisconnect = deferred();
    const newShutdownStarted = deferred();
    const agents = [
      testAgent('old', events),
      testAgent('new', events, async () => undefined, newShutdownStarted.resolve),
    ];
    useLifecycleSupervisor(
      () => {
        const agent = agents.shift();
        if (!agent) throw new Error('unexpected agent generation');
        return agent;
      },
      async ({ agent }) =>
        testBridge(
          agent.displayName,
          events,
          agent.displayName === 'old' ? releaseOldDisconnect.promise : undefined,
          agent.displayName === 'old' ? oldDisconnectStarted.resolve : undefined,
        ),
    );
    await sup.startProfile('claude');

    const restarting = sup.restartProfile('claude');
    await oldDisconnectStarted.promise;
    const stopping = sup.stopProfile('claude');
    await newShutdownStarted.promise;

    expect(events).toContain('disconnect:new');
    expect(events).toContain('shutdown:new');
    expect(events).not.toContain('shutdown:old');

    releaseOldDisconnect.resolve();
    await Promise.all([restarting, stopping]);

    expect(events.filter((event) => event === 'disconnect:old')).toHaveLength(1);
    expect(events.filter((event) => event === 'shutdown:old')).toHaveLength(1);
    expect(events.filter((event) => event === 'disconnect:new')).toHaveLength(1);
    expect(events.filter((event) => event === 'shutdown:new')).toHaveLength(1);
  });

  it('shuts down the candidate agent when restart startChannel fails', async () => {
    const events: string[] = [];
    const agents = [testAgent('old', events), testAgent('candidate', events)];
    useLifecycleSupervisor(
      () => {
        const agent = agents.shift();
        if (!agent) throw new Error('unexpected agent generation');
        return agent;
      },
      async ({ agent }) => {
        if (agent.displayName === 'candidate') throw new Error('candidate connect failed');
        return testBridge(agent.displayName, events);
      },
    );
    await sup.startProfile('claude');

    await expect(sup.restartProfile('claude')).rejects.toThrow('candidate connect failed');

    expect(events.filter((event) => event === 'shutdown:candidate')).toHaveLength(1);
    expect(events).not.toContain('disconnect:old');
    expect(events).not.toContain('shutdown:old');
    expect(sup.isOnline('claude')).toBe(true);
  });
});
