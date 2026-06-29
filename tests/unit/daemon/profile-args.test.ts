import { describe, expect, it } from 'vitest';
import { buildPlist } from '../../../src/daemon/launchd';
import {
  daemonStderrPath,
  daemonStdoutPath,
  launchAgentLabel,
  serviceProfileId,
  systemdUnitName,
  windowsTaskName,
} from '../../../src/daemon/paths';
import { buildLauncherCmd } from '../../../src/daemon/schtasks';
import { buildUnit } from '../../../src/daemon/systemd';
import { collectProxyEnv } from '../../../src/daemon/proxy-env';

describe('profile-scoped daemon paths and arguments', () => {
  it('sanitizes service ids and gives each profile distinct service names and logs', () => {
    expect(() => serviceProfileId('codex dev')).toThrow(/invalid profile name/i);
    expect(serviceProfileId('codex_dev')).toBe('codex_dev');
    expect(launchAgentLabel('codex-dev')).toContain('codex-dev');
    expect(systemdUnitName('claude')).not.toBe(systemdUnitName('codex-dev'));
    expect(windowsTaskName('claude')).not.toBe(windowsTaskName('codex-dev'));
    expect(daemonStdoutPath('claude')).not.toBe(daemonStdoutPath('codex-dev'));
    expect(daemonStderrPath('codex-dev').replace(/\\/g, '/')).toContain(
      '/profiles/codex-dev/logs/daemon/',
    );
  });

  it('pins launchd, systemd, and schtasks launch commands to run --profile', () => {
    const inputs = {
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'codex-dev',
      channelHome: '/tmp/lark-channel-home',
    };

    expect(buildPlist(inputs)).toContain('<string>--profile</string>\n        <string>codex-dev</string>');
    expect(buildPlist(inputs)).toContain('<key>LARK_CHANNEL_HOME</key>\n        <string>/tmp/lark-channel-home</string>');
    expect(buildUnit(inputs)).toContain('run --profile "codex-dev"');
    expect(buildUnit(inputs)).toContain('Environment="LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
    expect(buildLauncherCmd(inputs)).toContain('run --profile "codex-dev"');
    expect(buildLauncherCmd(inputs)).toContain('set "LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
  });

  it('omits proxy env entirely when none is configured', () => {
    const inputs = {
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'claude',
      channelHome: '/tmp/lark-channel-home',
    };
    expect(buildPlist(inputs)).not.toContain('HTTPS_PROXY');
    expect(buildUnit(inputs)).not.toContain('HTTPS_PROXY');
    expect(buildLauncherCmd(inputs)).not.toContain('HTTPS_PROXY');
  });

  it('bakes captured proxy vars into every service definition', () => {
    const inputs = {
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'claude',
      channelHome: '/tmp/lark-channel-home',
      proxyEnv: [
        { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:1082' },
        { key: 'ALL_PROXY', value: 'socks5://127.0.0.1:1082' },
        { key: 'NO_PROXY', value: 'localhost,.feishu.cn' },
      ],
    };

    const plist = buildPlist(inputs);
    expect(plist).toContain('<key>HTTPS_PROXY</key>\n        <string>http://127.0.0.1:1082</string>');
    expect(plist).toContain('<key>NO_PROXY</key>\n        <string>localhost,.feishu.cn</string>');

    const unit = buildUnit(inputs);
    expect(unit).toContain('Environment="HTTPS_PROXY=http://127.0.0.1:1082"');
    expect(unit).toContain('Environment="ALL_PROXY=socks5://127.0.0.1:1082"');

    const cmd = buildLauncherCmd(inputs);
    expect(cmd).toContain('set "HTTPS_PROXY=http://127.0.0.1:1082"');
  });

  it('escapes platform-special characters in proxy values', () => {
    // Proxy URL with percent-encoded credentials + an XML-special ampersand.
    const inputs = {
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'claude',
      channelHome: '/tmp/lark-channel-home',
      proxyEnv: [{ key: 'HTTPS_PROXY', value: 'http://u:p%40ss@host:8080/?a=1&b=2' }],
    };

    // plist: XML entities; raw `&` / `%` must not leak through.
    const plist = buildPlist(inputs);
    expect(plist).toContain('<string>http://u:p%40ss@host:8080/?a=1&amp;b=2</string>');

    // systemd: `%` doubled to survive specifier expansion.
    const unit = buildUnit(inputs);
    expect(unit).toContain('Environment="HTTPS_PROXY=http://u:p%%40ss@host:8080/?a=1&b=2"');

    // cmd: `%` doubled so cmd.exe doesn't expand it.
    const cmd = buildLauncherCmd(inputs);
    expect(cmd).toContain('set "HTTPS_PROXY=http://u:p%%40ss@host:8080/?a=1&b=2"');
  });

  it('strips CR/LF from cmd values so a proxy value cannot inject script lines', () => {
    const cmd = buildLauncherCmd({
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'claude',
      channelHome: '/tmp/lark-channel-home',
      proxyEnv: [{ key: 'HTTPS_PROXY', value: 'http://host\r\ndel /q *' }],
    });
    expect(cmd).toContain('set "HTTPS_PROXY=http://hostdel /q *"');
    expect(cmd).not.toMatch(/\r\ndel \/q/);
  });
});

describe('collectProxyEnv', () => {
  it('keeps only the canonical proxy vars, in canonical order, skipping empty/unset', () => {
    const got = collectProxyEnv({
      PATH: '/usr/bin',
      EDITOR: 'vim',
      https_proxy: 'http://127.0.0.1:1082',
      HTTP_PROXY: 'http://127.0.0.1:1082',
      NO_PROXY: '',
      ALL_PROXY: 'socks5://127.0.0.1:1082',
    });
    expect(got).toEqual([
      { key: 'HTTP_PROXY', value: 'http://127.0.0.1:1082' },
      { key: 'https_proxy', value: 'http://127.0.0.1:1082' },
      { key: 'ALL_PROXY', value: 'socks5://127.0.0.1:1082' },
    ]);
  });

  it('returns [] when no proxy vars are set', () => {
    expect(collectProxyEnv({ PATH: '/usr/bin' })).toEqual([]);
  });
});
