import { registerApp } from '@larksuite/channel';
import qrcode from 'qrcode-terminal';
import { t } from '../i18n';
import type { AppConfig, TenantBrand } from '../config/schema';

export interface ScopeGrantLink {
  /** Authorization URL — opening it lands on the confirm page with the new
   * scopes pre-filled as a diff against the existing app. */
  url: string;
  /** Seconds until the link expires. */
  expireIn: number;
  /** Resolves once the user finishes re-authorizing; rejects on
   * expiry/abort/error. Detached callers can await this to confirm success. */
  completion: Promise<void>;
}

/**
 * Build an incremental-scope authorization link for an EXISTING app via
 * `registerApp({ appId, addons })`. Unlike {@link runRegistrationWizard}
 * (terminal QR for first-time creation), this is for the in-chat `/config`
 * flow: we surface the URL the moment it's ready and push it to the user.
 *
 * The returned `completion` promise resolves only after the user authorizes,
 * so callers can `void`-await it to send a follow-up confirmation.
 *
 * Domain is intentionally left unset — `registerApp` defaults to the Feishu
 * auth host and auto-switches to Lark for international tenants (same as
 * {@link runRegistrationWizard}), so callers don't pass a tenant.
 */
export async function requestScopeGrantLink(opts: {
  appId: string;
  /** App-identity (tenant) scopes to request, e.g. `['im:message.group_msg']`. */
  tenantScopes: string[];
  signal?: AbortSignal;
}): Promise<ScopeGrantLink> {
  return new Promise<ScopeGrantLink>((resolve, reject) => {
    let urlDelivered = false;
    // registerApp returns synchronously and fires onQRCodeReady later, so
    // `completion` is assigned before the callback can reference it.
    const completion = registerApp({
      source: 'lark-channel-bridge',
      appId: opts.appId,
      addons: { scopes: { tenant: opts.tenantScopes } },
      ...(opts.signal ? { signal: opts.signal } : {}),
      onQRCodeReady: (info) => {
        urlDelivered = true;
        resolve({ url: info.url, expireIn: info.expireIn, completion });
      },
    }).then(() => undefined);
    // If registerApp rejects before ever delivering a URL (e.g. the initial
    // `begin` request fails), surface that failure to the caller.
    completion.catch((err) => {
      if (!urlDelivered) reject(err);
    });
  });
}

export async function runRegistrationWizard(): Promise<AppConfig> {
  console.log(t('wizard.start'));

  const result = await registerApp({
    source: 'lark-channel-bridge',
    onQRCodeReady: (info) => {
      console.log(t('wizard.scanQr'));
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(t('wizard.qrExpiry', { mins }));
      console.log(t('wizard.openInBrowser', { url: info.url }));
    },
    onStatusChange: (info) => {
      if (info.status === 'domain_switched') {
        console.log(t('wizard.domainSwitched'));
      } else if (info.status === 'slow_down') {
        console.log(t('wizard.slowDown'));
      }
    },
  });

  const tenant: TenantBrand = result.user_info?.tenant_brand ?? 'feishu';
  const operatorOpenId = result.user_info?.open_id;

  console.log(t('wizard.appCreated'));
  console.log(`  App ID:  ${result.client_id}`);
  console.log(`  Tenant:  ${tenant}`);
  if (operatorOpenId) {
    console.log(t('wizard.creatorLine', { openId: operatorOpenId }));
  } else {
    console.log(t('wizard.noOpenId'));
  }

  // No access fields are seeded here. The bot creator is resolved at
  // runtime from the Lark application API (`application/v6/applications`),
  // and the QR scanner is naturally the app's owner, so they'll get
  // unconditional bypass on the very first message — no config edit needed.
  // `allowedUsers` / `allowedChats` / `admins` stay empty (= nobody outside
  // the creator) until the operator tightens via `/config`.
  if (operatorOpenId) {
    console.log(t('wizard.creatorLineAll', { openId: operatorOpenId }));
  } else {
    console.log(t('wizard.noOpenIdFirstStart'));
  }

  const cfg: AppConfig = {
    accounts: {
      app: {
        id: result.client_id,
        secret: result.client_secret,
        tenant,
      },
    },
  };

  console.log('');
  return cfg;
}
