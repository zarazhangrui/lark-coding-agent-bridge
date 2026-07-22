## Context

`lark-coding-agent-bridge` 是 Node.js / TypeScript CLI 与后台服务。当前 macOS 后台运行由 launchd 适配层管理，Linux 使用 systemd，Windows 使用 Task Scheduler。bridge 运行时已经具备多层状态来源：

- `runStart` 注册进程到本地 registry，并在 WS 握手成功后回填 `botName`。
- `startChannel` 维护 WS 连接、重连、消息 intake、pending queue 与 active run。
- `RunExecutor` 负责提交 agent run、注册 `ActiveRuns`、分发 agent event，并记录 started / completed / failed。
- `processAgentStream` 将 agent event reduce 为 `RunState`，区分 `thinking`、`tool_running`、`streaming`、`done`、`interrupted`、`error`、`idle_timeout`。

当前用户需要 macOS 桌面可见的状态反馈：默认开启、可拖动、多 profile 聚合为一个悬浮球，鼠标 hover 时左右展开所有 profile。

## Goals / Non-Goals

**Goals:**

- 在 macOS 上提供默认开启的桌面悬浮球，用颜色、动效或简短标签展示 bridge 当前聚合状态。
- 同一用户同时运行多个 profile 时仅显示一个悬浮球，hover 时左右展开 profile 列表。
- 悬浮球可拖动，并持久化最后位置。
- CLI 支持 `--no-floating-ball`，配置支持永久关闭。
- bridge 进程发布不含敏感正文的状态快照，桌面 helper 只消费状态，不反向控制 bot。
- 非 macOS 平台不启动悬浮球，不改变现有 service 行为。

**Non-Goals:**

- 不实现 Electron 桌面应用。
- 不做完整偏好设置窗口、菜单栏 App 或通知中心提醒。
- 不展示 prompt、消息正文、工具输入输出、文件路径等敏感内容。
- 不支持从悬浮球停止 run、发送命令或切换 profile。
- 不做跨设备同步，不依赖远端服务保存状态。

## Decisions

### 1. macOS 使用轻量原生 helper，而不是 Electron

悬浮球是一个很小的桌面常驻 UI，核心能力是无边框置顶窗口、拖动、hover 展开和读取本地状态文件。macOS 原生 AppKit / Swift helper 可以低资源实现这些能力，并可由 CLI 或 launchd 启动。

备选方案：Electron。优点是实现快、可复用 Web 技术；缺点是体积和资源占用过高，对一个 CLI bridge 的状态指示器显得笨重。

备选方案：AppleScript / JXA。优点是无需编译复杂工程；缺点是窗口交互、动画、长期维护和签名分发都脆弱。

### 2. bridge 写状态快照，helper 只读快照

bridge 进程内已经知道真实状态。新增 `DesktopStatusReporter` 或等价模块，将 profile 级状态写入本地 JSON 快照：

```text
~/.lark-channel/desktop-status.json
  ├─ updatedAt
  ├─ aggregateStatus
  └─ profiles[]
       ├─ profile
       ├─ botName
       ├─ appIdSuffix
       ├─ agent
       ├─ status
       ├─ activeRunCount
       ├─ queuedMessageCount
       └─ lastErrorKind
```

快照 SHALL 使用原子写入，避免 helper 读到半截 JSON。helper 使用文件监听加兜底轮询读取该快照，不直接 import bridge 内部模块，不探测 agent 子进程。

状态优先级建议：

```text
error > reconnecting > tool_running > streaming > thinking > queued > idle > connecting > offline
```

聚合状态取所有 profile 中最高优先级状态。hover 展开列表展示每个 profile 自身状态。

### 3. 多 profile 聚合为单一悬浮球

桌面上永远只出现一个悬浮球，避免多个 profile 同时运行时产生 UI 噪声。bridge 各 profile 进程写入同一个全局快照，由文件锁或原子读改写维护 `profiles[]`。

helper 本身也应单实例运行。启动时通过 PID 文件、NSWorkspace bundle identifier 检查或 lockfile 避免重复 helper；若已有 helper 运行，新启动只更新状态快照并退出或 no-op。

hover 行为：

```text
        idle
         ●

hover:

  claude-prod  ● idle      ● thinking  codex-dev
  ops-bot      ● error     ● queued    test-bot
```

左右展开时以悬浮球为中心，空间不足时向可用方向偏移，保证不超出当前屏幕 visible frame。

### 4. 配置优先级：CLI 参数高于配置项，默认开启

macOS 下 `start` 和 service start 默认尝试启动或唤醒 helper。关闭来源：

1. `--no-floating-ball`：当前启动命令禁用悬浮球。
2. profile 或 root 配置项：永久禁用悬浮球。
3. 非 macOS：强制禁用，即使配置为开启。

配置建议：

```json
{
  "desktop": {
    "floatingBall": {
      "enabled": true
    }
  }
}
```

若配置缺省，macOS 视为 `enabled: true`，其他平台视为不可用。

### 5. 状态事件挂接点

状态 reporter 在以下位置更新快照：

- `runStart` 注册进程后：写入 `connecting`。
- `channel.connect()` 成功后：写入 `idle`，补充 `botName`。
- `reconnecting` / `reconnected` 事件：写入 `reconnecting` 或恢复到当前 run / queue 状态。
- pending queue push / block / unblock：写入 `queued` 或恢复状态。
- `RunExecutor.submit` 成功后：写入 `thinking`，记录 `runId` 与 scope 计数。
- `processAgentStream` 状态变化：映射 `footer` 到 `thinking` / `tool_running` / `streaming`。
- terminal 状态：根据 `done` / `interrupted` / `idle_timeout` / `error` 恢复 `idle` 或写入短暂错误状态。
- disconnect / process exit：移除该 profile 或标记 `offline`。

### 6. 隐私与安全边界

快照只包含展示状态所需的低敏字段。不得写入：

- 用户消息正文、prompt、assistant 输出。
- 工具输入输出、命令参数、文件路径。
- sessionId、threadId、chatId、senderId。
- app secret、token、完整 appId。

profile 识别可使用 profile 名、botName、agent 类型与 appId 后 6 位。状态文件权限使用 `0600`，位置偏好同样写入用户目录。

### 7. 失败处理

helper 启动失败不应阻断 bridge 启动。bridge SHALL 记录 warning，并继续正常接收消息。状态写入失败也只记录 warning，不影响 agent run。

如果 helper 崩溃，后续 `start` / service restart 可再次启动；已经运行的 bridge 可继续写快照，用户也可通过 CLI 命令重新唤起 helper（若实现额外命令）。

## Risks / Trade-offs

- **[Risk] 多进程同时写全局状态快照产生竞争** → 使用 lockfile 或写入 profile 独立文件再由 helper 聚合；若采用全局文件，必须原子读改写。
- **[Risk] helper 被 launchd 和多个 profile 重复启动** → helper 必须单实例化，新启动检测已有实例后退出。
- **[Risk] 默认开启可能打扰用户** → 提供 `--no-floating-ball` 和配置项；首次出现保持小尺寸、无声音、无通知。
- **[Risk] 状态快照泄露敏感信息** → 明确字段白名单，测试中断言不包含 message / prompt / tool payload。
- **[Risk] helper 构建分发增加复杂度** → 将 helper 作为 macOS-only 子项目，非 macOS 构建路径跳过；CI 可拆出 macOS job。
- **[Trade-off] 文件快照不是内存级实时** → 可接受，桌面状态指示对 100-500ms 延迟不敏感；实现简单、进程解耦。

## Migration Plan

1. 新增桌面状态 schema、状态 reporter 与原子写入工具。
2. 在 bridge 生命周期、WS 事件、pending queue、RunExecutor 和 processAgentStream 挂接状态更新。
3. 新增 macOS helper，实现悬浮球、拖动、hover 展开、单实例和位置持久化。
4. 在 CLI / service start 中按配置与 `--no-floating-ball` 决定是否启动 helper。
5. 添加单元测试覆盖状态映射、配置优先级、隐私字段与平台 gating。
6. macOS 手动验证单 profile、多 profile、hover 展开、拖动持久化、重连、错误和关闭配置。

回滚时可关闭配置项或移除 helper 启动调用；bridge 核心消息处理不依赖悬浮球。

## Open Questions

- helper 打包方式待实现时根据仓库现有发布流程确认：可选 SwiftPM 可执行、Xcode 子项目或预编译二进制随 npm 包发布。
- 悬浮球视觉细节（颜色、尺寸、动画时长）可在实现阶段以最小可用版本确定，但不得改变本 change 的行为契约。
