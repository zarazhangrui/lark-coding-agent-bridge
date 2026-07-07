import { describe, expect, it } from 'vitest';
import * as channelModule from '../../../src/bot/channel.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';

describe('Lark SDK logger noise filtering', () => {
  it('suppresses optional wiki-node permission failures that fall back to the original file token', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        [
          {
            message: 'Request failed with status code 400',
            config: {
              method: 'get',
              url: 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
            },
            response: {
              data: {
                code: 99991672,
                msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
              },
            },
          },
          {
            code: 99991672,
            msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
          },
        ],
      ]),
    ).toBe(true);
  });

  it('keeps unrelated permission failures visible', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        {
          message: 'Request failed with status code 400',
          config: {
            method: 'post',
            url: 'https://open.feishu.cn/open-apis/im/v1/messages',
          },
          response: {
            data: {
              code: 99991672,
              msg: 'Access denied.',
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe('group mention policy', () => {
  it('keeps regular groups mention-only while allowing configured auto-reply chats', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      access: {
        autoReplyChats: ['oc-solo-agent'],
      },
    });

    expect(
      channelModule.shouldRequireMentionForGroupMessage(profile, profile, 'oc-large-group'),
    ).toBe(true);
    expect(
      channelModule.shouldRequireMentionForGroupMessage(profile, profile, 'oc-solo-agent'),
    ).toBe(false);
  });
});
