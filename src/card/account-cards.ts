import { t } from '../i18n';
import type { TenantBrand } from '../config/schema';

function maskAppId(id: string): string {
  if (id.length < 12) return id;
  return `${id.slice(0, 13)}****${id.slice(-2)}`;
}

export interface CurrentInfo {
  appId: string;
  botName?: string;
  tenant: TenantBrand;
}

export function accountCurrentCard(info: CurrentInfo): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('account.current.summary') } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            t('account.current.title'),
            '',
            `**App ID**: \`${maskAppId(info.appId)}\``,
            t('account.botNameLine', { name: info.botName ?? t('account.unknownBotName') }),
            `**Tenant**: ${info.tenant}`,
          ].join('\n'),
        },
        { tag: 'hr' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('account.button.change') },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { cmd: 'account.change' } }],
        },
      ],
    },
  };
}

export interface FormCardOpts {
  initialTenant?: TenantBrand;
  prefillAppId?: string;
  errorMessage?: string;
}

export function accountFormCard(opts: FormCardOpts = {}): object {
  const { initialTenant = 'feishu', prefillAppId, errorMessage } = opts;
  const bodyElements: object[] = [];
  if (errorMessage) {
    bodyElements.push({
      tag: 'markdown',
      content: t('account.form.validationError', { msg: errorMessage }),
    });
  }
  bodyElements.push({
    tag: 'form',
    name: 'account_form',
    elements: [
      {
        tag: 'input',
        name: 'app_id',
        label: { tag: 'plain_text', content: 'App ID' },
        placeholder: { tag: 'plain_text', content: 'cli_xxxxxxxxxxxx' },
        ...(prefillAppId ? { default_value: prefillAppId } : {}),
        required: true,
      },
      {
        tag: 'input',
        name: 'app_secret',
        label: { tag: 'plain_text', content: 'App Secret' },
        placeholder: { tag: 'plain_text', content: t('account.form.secretPlaceholder') },
        // Never prefill secret — even on validation retry. Pre-filled secrets
        // can leak into Lark's server-side card cache.
        required: true,
      },
      { tag: 'markdown', content: '**Tenant**' },
      {
        tag: 'select_static',
        name: 'tenant',
        initial_option: initialTenant,
        options: [
          { text: { tag: 'plain_text', content: t('account.form.tenantFeishu') }, value: 'feishu' },
          { text: { tag: 'plain_text', content: t('account.form.tenantLark') }, value: 'lark' },
        ],
      },
      {
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: 'small',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                name: 'submit_btn',
                text: { tag: 'plain_text', content: t('config.form.button.submit') },
                type: 'primary',
                form_action_type: 'submit',
                behaviors: [{ type: 'callback', value: { cmd: 'account.submit' } }],
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                name: 'cancel_btn',
                text: { tag: 'plain_text', content: t('config.form.button.cancel') },
                behaviors: [{ type: 'callback', value: { cmd: 'account.cancel' } }],
              },
            ],
          },
        ],
      },
    ],
  });

  return {
    schema: '2.0',
    config: { summary: { content: t('account.form.summary') } },
    body: { elements: bodyElements },
  };
}

export function accountValidatingCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('account.validating.summary') } },
    body: { elements: [{ tag: 'markdown', content: t('account.validating.body') }] },
  };
}

export function accountSuccessCard(info: CurrentInfo): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('account.success.summary') } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            t('account.success.title'),
            '',
            `**App ID**: \`${maskAppId(info.appId)}\``,
            info.botName ? t('account.botNameLine', { name: info.botName }) : '',
            `**Tenant**: ${info.tenant}`,
            '',
            t('account.success.reconnecting'),
            t('account.success.takeoverWarning'),
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    },
  };
}

export function accountFailureCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('account.failure.summary') } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: t('account.failure.body', { reason }),
        },
      ],
    },
  };
}

export function accountCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: t('account.cancelled.summary') } },
    body: { elements: [{ tag: 'markdown', content: t('account.cancelled.body') }] },
  };
}
