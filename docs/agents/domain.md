# 领域文档

## 探索前读取

- 根目录 `GLOSSARY.md`。
- `docs/adr/` 中与当前工作相关的 ADR。

文件不存在时继续探索；术语或决策确定后按需创建。

## 布局与维护

本仓库采用 single-context：根目录 `GLOSSARY.md` 与 `docs/adr/`。

- 术语表仅记录领域概念，使用 domain-modeling 的 `GLOSSARY-FORMAT.md` 格式。
- 输出使用术语表中的名称；含义冲突时明确指出并对齐。
- ADR 仅记录难以撤回、缺少背景会令人困惑且经过实际取舍的决策，使用 domain-modeling 的 `ADR-FORMAT.md` 格式。
- 与既有 ADR 冲突时明确标记，交由用户决定是否重新讨论。
