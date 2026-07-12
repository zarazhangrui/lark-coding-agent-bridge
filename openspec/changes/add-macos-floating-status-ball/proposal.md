## Why

`lark-coding-agent-bridge` 以后台 bot 方式运行时，用户缺少一个无需切回终端或飞书即可判断 bot 当前状态的桌面入口。macOS 用户尤其需要一个轻量、可拖动、始终可见的状态指示器，快速确认 bot 是否在线、是否正在处理任务、是否发生重连或错误。

## What Changes

- 在 macOS 桌面新增默认开启的可视化悬浮球，用于指示当前 bridge / bot 运行状态。
- 悬浮球支持拖动，并持久化用户最后放置的位置。
- 多 profile 同时运行时聚合为一个悬浮球，而不是为每个 profile 创建独立悬浮球。
- 鼠标移动到悬浮球上时，悬浮球 SHALL 左右展开，展示所有正在运行或最近可见的 profile 状态。
- macOS 以外平台不启用悬浮球，也不影响现有 Linux / Windows 后台服务。
- 默认开启该能力，同时提供 CLI 参数 `--no-floating-ball` 和配置项关闭。
- 状态展示以 bridge 进程内的连接状态、队列状态、active run 状态与 agent stream 状态为准，不依赖桌面 helper 猜测进程。
- 不在 v1 中提供完整偏好设置界面、系统菜单栏 App、通知中心提醒或跨设备状态同步。

## Capabilities

### New Capabilities

- `desktop-status-indicator`: 定义 macOS 桌面悬浮球的状态展示、拖动、多 profile 聚合、hover 展开、默认开启与关闭规则。

### Modified Capabilities

<!-- 无 -->

## Impact

- **Platform**: 新增 macOS-only 桌面 helper 或等价原生桌面组件；非 macOS 平台保持无行为变化。
- **Runtime**: bridge 运行时需要发布 profile 级状态快照，包括连接、排队、运行、工具执行、输出、重连、错误等状态。
- **CLI**: `start` / service 启动路径新增 `--no-floating-ball` 参数，并读取配置项决定是否启动悬浮球。
- **Config**: profile 或 root 配置新增悬浮球开关，默认值为开启；显式关闭后不启动桌面 UI。
- **State Storage**: 新增本地状态快照与悬浮球位置持久化文件，避免泄露消息正文、prompt、工具输入输出等敏感内容。
- **UX**: 提供常驻桌面状态反馈、hover 展开 profile 列表、错误/重连可见提示与拖动交互。
- **Tests**: 覆盖状态快照映射、配置开关优先级、macOS 平台 gating、多 profile 聚合与悬浮球位置持久化。
