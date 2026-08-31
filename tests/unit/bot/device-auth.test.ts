import { describe, expect, it } from 'vitest';
import { deviceAuthForwardMessage, extractDeviceAuthUrl } from '../../../src/bot/device-auth.js';

describe('extractDeviceAuthUrl', () => {
  it('extracts verification_url from a real lark-cli --no-wait --json envelope', () => {
    const output = JSON.stringify({
      device_code: 'ODd-9vze31MFmDdHmR9tECbkM-FUeUOCGROOOOOOOOOO-yHUGROOOOOt.Vg1',
      expires_in: 600,
      hint: 'MUST generate QR code AND display it ...',
      verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=Odeadbeef',
    });
    expect(extractDeviceAuthUrl(output)).toBe(
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=Odeadbeef',
    );
  });

  it('prefers verification_uri_complete when present', () => {
    const output = JSON.stringify({
      device_code: 'abc',
      verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify',
      verification_uri_complete:
        'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=xyz&user_code=AB12',
    });
    expect(extractDeviceAuthUrl(output)).toBe(
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=xyz&user_code=AB12',
    );
  });

  it('matches a larksuite (international) device URL', () => {
    const output = JSON.stringify({
      device_code: 'abc',
      verification_url: 'https://accounts.larksuite.com/oauth/v1/device/verify?flow_id=intl',
    });
    expect(extractDeviceAuthUrl(output)).toBe(
      'https://accounts.larksuite.com/oauth/v1/device/verify?flow_id=intl',
    );
  });

  it('finds the URL even when JSON is wrapped in surrounding log lines', () => {
    const output = [
      'Starting device authorization...',
      JSON.stringify({
        device_code: 'abc',
        verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=wrapped',
      }),
      'waiting for authorization',
    ].join('\n');
    expect(extractDeviceAuthUrl(output)).toBe(
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=wrapped',
    );
  });

  it('falls back to the device verify URL in plain (non-JSON) text', () => {
    const output =
      'Open this link to authorize: https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=plain then come back';
    expect(extractDeviceAuthUrl(output)).toBe(
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=plain',
    );
  });

  it('ignores a JSON envelope without a device_code (not a device flow)', () => {
    const output = JSON.stringify({
      verification_url: 'https://accounts.feishu.cn/some/other/path',
    });
    expect(extractDeviceAuthUrl(output)).toBeUndefined();
  });

  it('ignores unrelated feishu URLs', () => {
    const output =
      '{"ok":true,"data":{"url":"https://example.feishu.cn/docx/abcdef","title":"notes"}}';
    expect(extractDeviceAuthUrl(output)).toBeUndefined();
  });

  it('ignores a successful auth token result with no verification URL', () => {
    const output = JSON.stringify({ ok: true, identity: 'user', message: 'login success' });
    expect(extractDeviceAuthUrl(output)).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(extractDeviceAuthUrl('')).toBeUndefined();
  });
});

describe('deviceAuthForwardMessage', () => {
  const url = 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc';

  it('includes the verification URL in a p2p chat', () => {
    const forward = deviceAuthForwardMessage('p2p', url);
    expect(forward.includesUrl).toBe(true);
    expect(forward.markdown).toContain(url);
  });

  it('never leaks the URL in a group chat and steers the user to DM', () => {
    for (const chatType of ['group', 'topic']) {
      const forward = deviceAuthForwardMessage(chatType, url);
      expect(forward.includesUrl).toBe(false);
      expect(forward.markdown).not.toContain(url);
      expect(forward.markdown).toContain('私信');
    }
  });
});
