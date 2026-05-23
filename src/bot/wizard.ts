import { spawnSync } from 'node:child_process';
import { registerApp } from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';
import type { AppConfig, TenantBrand } from '../config/schema';

/**
 * Detect a claude-compatible wrapper on PATH and return its name to preset
 * `preferences.agent.binary`. Currently only `reclaude` is auto-detected;
 * other wrappers can be set manually in config.json.
 *
 * Why auto-detect: the most common deploy is "user already runs reclaude as
 * an Anthropic auth proxy, then installs this bridge". Skipping this step
 * leaves them with a bridge that spawns vanilla `claude` and fights with
 * reclaude's HTTPS_PROXY, which is exactly the pain this fork exists to
 * avoid. If reclaude isn't installed we silently skip — bridge falls back
 * to plain `claude` via ClaudeAdapter's default.
 */
function detectWrapperBinary(): string | undefined {
  const r = spawnSync('which', ['reclaude'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status === 0 && r.stdout && r.stdout.toString().trim().length > 0) {
    return 'reclaude';
  }
  return undefined;
}

export async function runRegistrationWizard(): Promise<AppConfig> {
  console.log('\n未检测到飞书应用配置，进入扫码创建向导。\n');

  const result = await registerApp({
    onQRCodeReady: (info) => {
      console.log('请用飞书 App 扫描以下二维码完成应用创建：\n');
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期：约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === 'domain_switched') {
        console.log('识别到国际版租户，已切换到 larksuite.com 域名。');
      } else if (info.status === 'slow_down') {
        console.log('轮询速度过快，已自动降速。');
      }
    },
  });

  const tenant: TenantBrand = result.user_info?.tenant_brand ?? 'feishu';
  const operatorOpenId = result.user_info?.open_id;

  console.log('\n✓ 应用创建成功');
  console.log(`  App ID:  ${result.client_id}`);
  console.log(`  Tenant:  ${tenant}`);

  const cfg: AppConfig = {
    accounts: {
      app: {
        id: result.client_id,
        secret: result.client_secret,
        tenant,
      },
    },
  };

  // Bootstrap the QR scanner as the initial admin. Without this seed the
  // /config gate stays open to everyone in any chat the bot joins, making
  // it awkward to ever tighten things (the operator would need to hand-edit
  // config.json to set the first admin).
  //
  // `allowedUsers` and `allowedChats` stay empty (unrestricted) by default
  // so the bot remains inviteable and responds anywhere it's invited; the
  // operator can tighten via /config later.
  if (operatorOpenId) {
    cfg.preferences = {
      access: { admins: [operatorOpenId] },
    };
    console.log(`  Admin:   ${operatorOpenId} (你自己，已自动加入管理员名单)`);
  } else {
    console.log(
      '  ⚠️ 未拿到扫码用户的 open_id；管理员列表留空 = 所有用户都能跑敏感命令。' +
        '\n     你可以稍后在飞书发 /config 手动设置管理员。',
    );
  }

  const wrapper = detectWrapperBinary();
  if (wrapper) {
    cfg.preferences = {
      ...(cfg.preferences ?? {}),
      agent: { binary: wrapper },
    };
    console.log(`  Wrapper: 检测到 ${wrapper}，已预设 preferences.agent.binary（绕过 HTTPS_PROXY/CA 死结）`);
  }

  console.log('');
  return cfg;
}
