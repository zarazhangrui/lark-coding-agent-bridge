# Bridge Reaction Event Handler 补丁

## 背景

飞书 bot 可以通过 `im.message.reaction.created_v1` 和 `im.message.reaction.deleted_v1` 事件接收用户对消息的表情回复（reaction），但 `lark-channel-bridge` (v0.2.2 / v0.3.0) 没有注册对应的事件处理器，导致所有 reaction 事件被静默丢弃。

## 根因

- SDK (`@larksuiteoapi/node-sdk`) 已完整支持 reaction 事件的接收、归一化和去重处理
- SDK 的 `EventMap` 中包含 `reaction: (evt: ReactionEvent) => void`
- 但 bridge 的 `channel.on()` 只注册了 `message`、`reject`、`cardAction`、`comment`、`reconnecting`、`reconnected`、`error`，缺少 `reaction`
- SDK 把事件交给 `this.handlers.reaction` 时发现为空，事件丢失

## Normalized ReactionEvent 结构

```typescript
interface ReactionEvent {
  messageId: string;        // 被点表情的消息 ID (om_xxx)
  operator: {
    openId: string;         // 谁点的
    userId?: string;
  };
  emojiType: string;        // 表情类型 (THUMBSUP, HEART, 自定义表情名等)
  action: 'added' | 'removed';  // 添加 or 移除
  actionTime?: number;      // 毫秒时间戳
  raw?: unknown;            // 原始飞书事件
}
```

## 修改内容

### 本地补丁

文件：`/opt/homebrew/lib/node_modules/lark-channel-bridge/dist/cli.js`

在 `channel.on({...})` 中 `comment` 和 `reconnecting` 之间插入：

```js
reaction: async (evt) => {
  await withTrace({ chatId: evt.messageId }, async () => {
    try {
      const r = await channel.rawClient.im.v1.message.get({
        path: { message_id: evt.messageId }
      });
      const item = r?.data?.items?.[0];
      const chatId = item?.chat_id;
      if (!chatId) {
        log.warn("reaction", "no-chatId", { messageId: evt.messageId });
        return;
      }
      const chatMode = await chatModeCache.resolve(channel, chatId);
      const threadId = item?.thread_id;
      const scope = chatMode === "topic" && threadId ? `${chatId}:${threadId}` : chatId;
      const chatType = chatMode === "p2p" ? "p2p" : "group";
      const synthetic = {
        messageId: evt.messageId,
        chatId,
        chatType,
        threadId,
        senderId: evt.operator.openId,
        content: `[reaction-${evt.action}] ${evt.emojiType} (on msg ${evt.messageId.slice(-8)})`,
        rawContentType: "reaction",
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: evt.actionTime || Date.now()
      };
      pending.push(scope, synthetic);
      log.info("reaction", "enqueued", { scope, emojiType: evt.emojiType, action: evt.action });
    } catch (err) {
      log.fail("reaction", err);
    }
  }).catch((err) => log.fail("reaction", err));
},
```

### TypeScript 源码

文件：`src/bot/channel.ts`（+43 行）

逻辑完全一致，类型安全版本。

## 所需权限 (Scope)

在飞书开发者后台：

| Scope | 用途 |
|-------|------|
| `im:message:readonly` | 读取消息信息以解析 chatId |
| `im:message.reactions:read` | 接收 reaction 事件 |

## 事件订阅

在飞书开发者后台 → 事件订阅，需添加：
- `im.message.reaction.created_v1`
- `im.message.reaction.deleted_v1`

## 效果

用户对 bot 消息点表情 → bridge 收到事件 → 生成合成消息 `[reaction-added] THUMBSUP (on msg xxxxxxxx)` → agent 收到并可响应。

典型用例：
- 用户点 YES 表情 = 同意
- 用户点 NO 表情 = 拒绝
- 无需打字即可快速反馈

## 部署步骤

```bash
# 1. 修改 dist/cli.js（或等新版 npm 包发布后 npm update -g lark-channel-bridge）
# 2. 重启 bridge
lark-channel-bridge restart --profile claude
lark-channel-bridge restart --profile codex
```

## 上游 PR

- **PR**: [zarazhangrui/lark-coding-agent-bridge#102](https://github.com/zarazhangrui/lark-coding-agent-bridge/pull/102)
- **Branch**: `feat/reaction-handler`
- **仓库**: https://github.com/zarazhangrui/feishu-claude-code-bridge

## 注意事项

- npm update 会覆盖本地补丁，需要重新应用
- 同一 app 只能有一个 WebSocket 连接，消费 reaction 事件不需要额外的 consume 进程
- `emojiType` 可以是标准表情（THUMBSUP、HEART）或自定义表情名
- 合成消息中的 `messageId` 后 8 位用于关联原始消息，避免 agent 混淆上下文
