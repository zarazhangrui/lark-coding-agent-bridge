# Bug: bridge 把非本人消息的 reaction event 路由给了 bot

## 现象

飞书群聊中，用户对**云上小C（另一个 bot）发送的消息**点了 👍，但**小C（本 bot）收到了这个 reaction event**，并当成发给自己的消息做了响应。

## 复现场景

1. 群 `oc_57e5b6b2fd95db8baa0c292f1ca198f0`，包含两个 bot：
   - 小C：`ou_4b837d4ce946a78d47fb3157858136c3`
   - 云上小C：`ou_7dc90b2f1ae6eb6a76be07a3e8d0ce97`
2. 用户 `ou_1a2cc00c28618df27bff1377ae244a41` 对云上小C 的消息（`om_x100b6dac3f0b64a8b392690a7e5bac0`）点了 👍（Get）
3. bridge 将反应事件透传给小C：

```json
<bridge_context>
{
  "chatId": "oc_57e5b6b2fd95db8baa0c292f1ca198f0",
  "chatType": "group",
  "senderId": "ou_1a2cc00c28618df27bff1377ae244a41",
  "senderType": "user",
  "botOpenId": "ou_4b837d4ce946a78d47fb3157858136c3",
  "mentions": [
    {
      "openId": "ou_4b837d4ce946a78d47fb3157858136c3",
      "name": "小C",
      "isBot": true
    }
  ],
  "messageIds": ["om_x100b6dac3f0b64a8b392690a7e5bac0"],
  "source": "im"
}
</bridge_context>

<user_input>
{"text":"[reaction-added] Get (on msg a7e5bac0)"}
</user_input>
```

4. 目标消息 `om_x100b6dac3f0b64a8b392690a7e5bac0` 的发送者是**云上小C**，不是小C
5. 结果：小C 做出了无意义的"👍"响应

## 预期行为

bot 只应收到**自己发送的消息**上的 reaction event。用户给其他 bot 的消息点 reaction 时，bridge 不应把 event 转发给本 bot。

## 推测根因

bridge 在消费 IM reaction event 时，未校验 `reaction.target_message.sender_id` 是否等于 `bridge_context.botOpenId`。应加校验：reaction 目标消息的 sender == bot 自己的 open_id 才转发。

## 另一种可能

`bridge_context.mentions` 中的 `messageIds` 字段包含了被 reaction 的消息 id，但 bridge 可能错误地将"消息上发生了 reaction"等同于"我被 @ 了"，导致 event 被路由给了当前 bot。实际上 reaction event 与 @mention 是独立的概念，应分别判断。

## 关键 ID

| 实体 | ID |
|------|----|
| 当前 bot（小C） | `ou_4b837d4ce946a78d47fb3157858136c3` |
| 另一个 bot（云上小C） | `ou_7dc90b2f1ae6eb6a76be07a3e8d0ce97` |
| 用户 | `ou_1a2cc00c28618df27bff1377ae244a41` |
| 群 | `oc_57e5b6b2fd95db8baa0c292f1ca198f0` |
| 被 reaction 的消息 | `om_x100b6dac3f0b64a8b392690a7e5bac0` |

## Event 格式

bridge 透传的 reaction event：
```
[reaction-added] <emoji_name> (on msg <message_short_id>)
```

其中 `message_short_id` 是被 reaction 的消息 id 的截断形式，`messageIds` 数组包含完整 id。
