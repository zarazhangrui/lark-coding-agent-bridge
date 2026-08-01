import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_SERVER_PROCESS_GROUP_ENABLED,
  readAppServerFeatureInventory,
  terminateAndReapChild,
} from '../../src/agent/codex/app-server-process';
import { writeFileAtomic } from '../../src/platform/atomic-write';
import { spawnProcess } from '../../src/platform/spawn';

describe('Codex App Server process probes', () => {
  const cleanup: string[] = [];
  const childPids: number[] = [];
  const processGroupPids: number[] = [];

  afterEach(async () => {
    for (const pid of processGroupPids.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already reaped by the code under test, or process groups are unavailable.
      }
    }
    for (const pid of childPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already reaped by the code under test.
      }
    }
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('reports a hung feature probe timeout independently of process startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-feature-probe-timeout-'));
    cleanup.push(dir);
    const binary = join(dir, 'fake-codex.mjs');
    await writeFileAtomic(binary, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    await chmod(binary, 0o755);

    await expect(readAppServerFeatureInventory({
      binary,
      cwd: dir,
      env: process.env,
      featureListTimeoutMs: 100,
      shutdownGraceMs: 100,
    })).rejects.toThrow(/codex features list timed out after 100ms/);
  });

  it('reaps a started wrapper and its POSIX process group after escalation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-feature-probe-reap-'));
    cleanup.push(dir);
    const wrapper = join(dir, 'wrapper.mjs');
    const readyFile = join(dir, 'ready.json');
    await writeFileAtomic(wrapper, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
)}], { stdio: 'ignore' });
grandchild.once('spawn', () => {
  writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({
    wrapperPid: process.pid,
    grandchildPid: grandchild.pid,
  }));
});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);

    const child = spawnProcess(process.execPath, [wrapper], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: APP_SERVER_PROCESS_GROUP_ENABLED,
    });
    if (!child.pid) throw new Error('wrapper spawn returned no pid');
    childPids.push(child.pid);
    if (APP_SERVER_PROCESS_GROUP_ENABLED) processGroupPids.push(child.pid);
    child.stdout?.resume();
    child.stderr?.resume();
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const ready = await waitForReadyFile(readyFile);
    childPids.push(ready.grandchildPid);

    expect(ready.wrapperPid).toBe(child.pid);
    expect(isProcessAlive(ready.wrapperPid)).toBe(true);
    expect(isProcessAlive(ready.grandchildPid)).toBe(true);

    await expect(terminateAndReapChild(child, closed, {
      eofGraceMs: 0,
      terminateGraceMs: 100,
      killGraceMs: 1000,
    })).resolves.toBe(true);

    await waitForProcessExit(ready.wrapperPid);
    expect(isProcessAlive(ready.wrapperPid)).toBe(false);
    if (APP_SERVER_PROCESS_GROUP_ENABLED) {
      await waitForProcessExit(ready.grandchildPid);
      expect(isProcessAlive(ready.grandchildPid)).toBe(false);
    }
    // Windows intentionally guarantees only direct-child termination; the
    // afterEach PID cleanup owns any surviving wrapper grandchild there.
  });

  it.skipIf(!APP_SERVER_PROCESS_GROUP_ENABLED)(
    'reaps a surviving POSIX process group after the direct child closes early',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'codex-feature-probe-early-close-'));
      cleanup.push(dir);
      const wrapper = join(dir, 'wrapper.mjs');
      const readyFile = join(dir, 'ready.json');
      await writeFileAtomic(wrapper, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
)}], { stdio: 'ignore' });
grandchild.once('spawn', () => {
  writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({
    wrapperPid: process.pid,
    grandchildPid: grandchild.pid,
  }));
  process.exit(0);
});
`);

      const child = spawnProcess(process.execPath, [wrapper], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      if (!child.pid) throw new Error('wrapper spawn returned no pid');
      childPids.push(child.pid);
      processGroupPids.push(child.pid);
      child.stdout?.resume();
      child.stderr?.resume();
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const ready = await waitForReadyFile(readyFile);
      childPids.push(ready.grandchildPid);

      await closed;
      expect(isProcessAlive(ready.wrapperPid)).toBe(false);
      expect(isProcessAlive(ready.grandchildPid)).toBe(true);

      await expect(terminateAndReapChild(child, closed, {
        eofGraceMs: 0,
        terminateGraceMs: 100,
        killGraceMs: 1000,
      })).resolves.toBe(true);

      await waitForProcessExit(ready.grandchildPid);
      expect(isProcessAlive(ready.grandchildPid)).toBe(false);
    },
  );
});

async function waitForReadyFile(
  path: string,
): Promise<{ wrapperPid: number; grandchildPid: number }> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        wrapperPid?: unknown;
        grandchildPid?: unknown;
      };
      if (typeof parsed.wrapperPid === 'number' && typeof parsed.grandchildPid === 'number') {
        return { wrapperPid: parsed.wrapperPid, grandchildPid: parsed.grandchildPid };
      }
    } catch {
      // The wrapper has not completed its startup handshake yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for wrapper startup handshake');
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} did not exit`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
