# FusionBridge 八助手统一管理

本文档定义四台设备、八个 Feishu/FusionBridge 助手的统一代码源、清单、巡检方式和后台看板接入方式。

## 代码源

主仓库：

```bash
https://github.com/zarazhangrui/lark-coding-agent-bridge
```

本仓库是唯一代码源。Mac1、Win3、Win4 不应再各自维护一套 fork；远端机器只安装本仓库发布或本地构建出的 `lark-channel-bridge` 包。

本次盘点结果：

| 机器 | 结果 |
| --- | --- |
| Mac2 | 发现主仓库 `/Users/jay520/ClaudeCode/lark-coding-agent-bridge`，绑定 GitHub origin。 |
| Mac1 | 未发现 bridge 源码仓库，当前通过全局安装包运行。 |
| Win3 | 发现 `D:\CloudCode\feishu-bridge` 和 `D:\CloudCode\feishu-event-bridge`，均非 Git 仓库，且包含 `.env` 与历史 inbox 文件；只作为旧实验资产记录，不直接迁入主仓库。 |
| Win4 | 未发现 bridge 源码仓库，当前通过全局安装包运行。 |

## Canonical Fleet Manifest

标准清单在：

```bash
fleet/fusionbridge.assistants.json
```

当前八助手：

| 机器 | Agent | Profile | Bot Name | App ID | SSH |
| --- | --- | --- | --- | --- | --- |
| Mac1 | Claude Code | `claude` | `Mac1CC Assistant` | `cli_aaae6528f3789bc2` | `air` |
| Mac1 | Codex | `codex` | `Mac1CD Assistant` | `cli_aaae56d7e7b8dbd8` | `air` |
| Mac2 | Claude Code | `claude` | `Mac2CC Assistant` | `cli_aaae6faf9ef85bb3` | `mac2` |
| Mac2 | Codex | `codex` | `Mac2CD Assistant` | `cli_aaae56b4cb799be9` | `mac2` |
| Win3 | Claude Code | `claude` | `Win3CC Assistant` | `cli_aaae215338f8dbe0` | `win3` |
| Win3 | Codex | `win3-codex` | `Win3CD Assistant` | `cli_aaae67257ff89bc0` | `win3` |
| Win4 | Claude Code | `claude` | `Win4CC Assistant` | `cli_aaae69a63678dbe1` | `win4` |
| Win4 | Codex | `codex` | `Win4CD Assistant` | `cli_aaae56a869385bcd` | `win4` |

每个 assistant 记录 `machineId`、`agentKind`、`profileName`、`botName`、`appId`、`tenant`、`sshHost`、`feishuLabel`。后台看板应以 `appId` 作为稳定主键，以 `botName` 作为展示名。

## CLI

查看标准清单：

```bash
lark-channel-bridge fleet manifest
lark-channel-bridge fleet manifest --json
```

导出当前机器状态：

```bash
lark-channel-bridge fleet snapshot --json
```

输出包含：

- `host`: hostname、platform、arch、release、username
- `profiles`: profile、agentKind、appId、tenant、defaultWorkspace
- `processes`: registry entries plus `alive`
- `bridgeVersion` 和 `capturedAt`

不会输出 app secret、token、`.env`、历史消息、附件内容。

比对当前机器状态：

```bash
lark-channel-bridge fleet status
lark-channel-bridge fleet status --json
```

比对多机器 snapshot：

```bash
mkdir -p ~/.lark-channel/fleet-snapshots
ssh air  'lark-channel-bridge fleet snapshot --json' > ~/.lark-channel/fleet-snapshots/mac1.json
ssh mac2 'lark-channel-bridge fleet snapshot --json' > ~/.lark-channel/fleet-snapshots/mac2.json
ssh win3 'lark-channel-bridge fleet snapshot --json' > ~/.lark-channel/fleet-snapshots/win3.json
ssh win4 'lark-channel-bridge fleet snapshot --json' > ~/.lark-channel/fleet-snapshots/win4.json
lark-channel-bridge fleet status --snapshots-dir ~/.lark-channel/fleet-snapshots --json
```

Windows 远端要求全局 `lark-channel-bridge` 已更新到包含 `fleet` 命令的版本。未更新前，可先通过 SSH 执行原有 `lark-channel-bridge ps` 或读取 `~/.lark-channel/registry/processes.json` 临时巡检。

## 后台看板接入

第一版建议后台只消费 `fleet status --json`：

```json
{
  "schemaVersion": 1,
  "fleetName": "FusionBridge",
  "totalAssistants": 8,
  "onlineAssistants": 8,
  "snapshots": [
    {
      "hostname": "Mac2.local",
      "capturedAt": "2026-06-07T19:00:00.000Z",
      "processCount": 2,
      "onlineProcessCount": 2
    }
  ],
  "assistants": [
    {
      "id": "mac2-cc",
      "machineId": "mac2",
      "agentKind": "claude",
      "botName": "Mac2CC Assistant",
      "appId": "cli_aaae6faf9ef85bb3",
      "configured": true,
      "online": true,
      "status": "online",
      "pid": 94107
    }
  ]
}
```

看板状态规则：

| status | 含义 |
| --- | --- |
| `online` | manifest 中的 appId 在 snapshot 里有 live process。 |
| `configured_offline` | profile 存在，但没有 live bridge process。 |
| `missing_profile` | 当前收集到的 snapshot 里没有对应 appId。可能是机器未上报、未安装或配置漂移。 |

## 定期维护

建议节奏：

| 频率 | 动作 |
| --- | --- |
| 每 1-5 分钟 | 四台机器生成 snapshot，后台聚合 `fleet status --json`。 |
| 每天 | 检查 `onlineAssistants == totalAssistants`，异常时重启对应 profile。 |
| 每周 | 对照 `fleet/fusionbridge.assistants.json` 检查 Feishu bot 名称、群聊成员、标签是否漂移。 |
| 每次更新 bridge | 在主仓库测试、构建、发布后，再分发到 Mac1/Mac2/Win3/Win4。 |

macOS 可用 launchd，Windows 可用 Task Scheduler。定时任务只需要运行 `lark-channel-bridge fleet snapshot --json` 并写到后台指定目录或 HTTP ingest endpoint。

## Feishu 群聊和 Label

标准群：

- `总作战室`
- `Claude Code 分指挥室`
- `Codex 分指挥室`

标准 label：

- Claude Code 助手和群聊：`Claude Code`
- Codex 助手和群聊：`Codex`

Feishu 客户端里的聊天 label 属于用户侧 UI 分类能力，OpenAPI 是否能直接设置取决于 Feishu 当前开放能力。代码层面先在 manifest 里保留 `feishuLabel`，后台看板和任何浏览器自动化任务都以该字段为准。

## 安全边界

- 不提交 `.env`、app secret、token、历史消息、附件缓存。
- 旧 Win3 项目只做 inventory，不迁入 Git。
- 后台看板使用 `appId` 和 profile 状态，不需要读取用户个人授权信息。
- 外部协作者只应看到授权任务和助手在线状态，不应拿到 bridge state 目录读权限。
