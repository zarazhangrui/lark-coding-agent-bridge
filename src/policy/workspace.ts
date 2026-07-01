import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export type WorkingDirectoryRejectReason =
  | 'empty-requested-cwd'
  | 'path-inaccessible'
  | 'not-directory'
  | 'filesystem-root'
  | 'home-root'
  | 'user-root'
  | 'system-root'
  | 'temp-root'
  | 'broad-user-folder'
  | 'volume-root';

export type WorkingDirectoryResolveResult =
  | { ok: true; requestedCwd: string; cwdRealpath: string }
  | {
      ok: false;
      reason: WorkingDirectoryRejectReason;
      requestedCwd: string;
      userVisible: string;
    };

export async function resolveWorkingDirectory(
  requestedCwd: string,
): Promise<WorkingDirectoryResolveResult> {
  const trimmed = requestedCwd.trim();
  if (!trimmed) {
    return reject('empty-requested-cwd', requestedCwd, '未指定工作目录。');
  }

  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch {
    return reject('path-inaccessible', requestedCwd, `工作目录不存在或不可访问：${requestedCwd}`);
  }

  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) {
    return reject('not-directory', requestedCwd, `路径不是目录：${resolved}`);
  }

  const tempRealpath = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const homeRealpath = await realpath(homedir()).catch(() => resolve(homedir()));
  const broad = classifyHighRiskWorkingDirectory(resolved, requestedCwd, tempRealpath, homeRealpath);
  if (broad) return broad;

  return {
    ok: true,
    requestedCwd,
    cwdRealpath: resolved,
  };
}

function reject(
  reason: WorkingDirectoryRejectReason,
  requestedCwd: string,
  userVisible: string,
): WorkingDirectoryResolveResult {
  return { ok: false, reason, requestedCwd, userVisible };
}

function classifyHighRiskWorkingDirectory(
  real: string,
  requestedCwd: string,
  tempRealpath: string,
  homeRealpath: string,
): WorkingDirectoryResolveResult | undefined {
  if (real === dirname(real)) {
    return reject('filesystem-root', requestedCwd, '不能把文件系统根目录设为工作目录。');
  }

  const home = homeRealpath;
  if (real === home) {
    return reject('home-root', requestedCwd, '不能把 Home 根目录设为工作目录，请选择更具体的子目录。');
  }
  if (real === dirname(home)) {
    return reject('user-root', requestedCwd, '不能把用户目录根设为工作目录，请选择更具体的子目录。');
  }

  if (dirname(real) === home && new Set(['Desktop', 'Downloads']).has(basename(real))) {
    return reject('broad-user-folder', requestedCwd, '这个目录范围过大，请选择更具体的子目录。');
  }

  const temp = resolve(tmpdir());
  if (real === temp || real === tempRealpath || real === '/tmp' || real === '/private/tmp') {
    return reject('temp-root', requestedCwd, '不能把临时目录根设为工作目录，请选择更具体的子目录。');
  }

  const systemRoots = new Set([
    '/Applications',
    '/bin',
    '/etc',
    '/Library',
    '/private',
    '/sbin',
    '/System',
    '/usr',
    '/var',
  ]);
  if (systemRoots.has(real)) {
    return reject('system-root', requestedCwd, '不能把系统目录设为工作目录。');
  }

  if (real === '/Volumes' || dirname(real) === '/Volumes') {
    return reject('volume-root', requestedCwd, '不能把磁盘卷根目录设为工作目录，请选择更具体的子目录。');
  }

  return undefined;
}
