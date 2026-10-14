# Issue tracker：GitHub

需求与 specs 存放在 `wuye2325/lark-coding-agent-bridge` 的 GitHub Issues。
所有 `gh issue` 与 `gh pr` 命令显式指定 `--repo wuye2325/lark-coding-agent-bridge`，避免默认解析到 upstream。

## 操作约定

- 读取需求：`gh issue view <number> --repo wuye2325/lark-coding-agent-bridge --comments`。
- 列出需求：`gh issue list --repo wuye2325/lark-coding-agent-bridge --state open --json number,title,body,labels`。
- 发布到 issue tracker：创建该 fork 的 GitHub issue。
- 多行正文写入临时文件，通过 `--body-file` 提交，完成后清理临时文件。
- 评论、标签、关闭等写操作遵循用户授权范围。

## Upstream

`zarazhangrui/lark-coding-agent-bridge` 用于查找与评估可复用实现；查询时显式指定该仓库。

## PRs 作为需求入口

**PRs as a request surface: no.**
