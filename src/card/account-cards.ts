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
    config: { summary: { content: 'Current app' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '📋 **Current app**',
            '',
            `**App ID**: \`${maskAppId(info.appId)}\``,
            `**Bot name**: ${info.botName ?? '(unknown)'}`,
            `**Tenant**: ${info.tenant}`,
          ].join('\n'),
        },
        { tag: 'hr' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Change credentials' },
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
      content: `❌ **Validation failed**: ${errorMessage}`,
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
        placeholder: { tag: 'plain_text', content: '32-character string' },
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
          { text: { tag: 'plain_text', content: 'Feishu (China)' }, value: 'feishu' },
          { text: { tag: 'plain_text', content: 'Lark (overseas)' }, value: 'lark' },
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
                text: { tag: 'plain_text', content: 'Submit' },
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
                text: { tag: 'plain_text', content: 'Cancel' },
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
    config: { summary: { content: 'Change credentials' } },
    body: { elements: bodyElements },
  };
}

export function accountValidatingCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Validating…' } },
    body: { elements: [{ tag: 'markdown', content: '⏳ **Validating credentials…**' }] },
  };
}

export function accountSuccessCard(info: CurrentInfo): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Saved' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '✅ **Credentials saved**',
            '',
            `**App ID**: \`${maskAppId(info.appId)}\``,
            info.botName ? `**Bot name**: ${info.botName}` : '',
            `**Tenant**: ${info.tenant}`,
            '',
            'Reconnecting WebSocket with the new credentials…',
            '⚠️ If the new bot isn\'t a member of this chat, subsequent messages will be handled by the new bot — the old bot will no longer reply.',
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
    config: { summary: { content: 'Validation failed' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `❌ **Validation failed**\n\n\`${reason}\`\n\nCheck that the App ID and Secret are correct, then re-send \`/account change\` to retry.`,
        },
      ],
    },
  };
}

export function accountCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Cancelled' } },
    body: { elements: [{ tag: 'markdown', content: 'Cancelled — no changes saved.' }] },
  };
}
