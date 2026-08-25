---
name: figma
description: 连接 Figma Desktop 画布，读取设计、实现界面、分析选区或维护组件映射。
---

# Figma

把用户当前的 Figma 画布、节点链接或选区作为可信设计来源，并根据任务选择最合适的工作方式。

- 先确认当前 Turn 的工具列表包含 Figma MCP 工具。SugarCode 会在用户显式选择 `$figma` 时尝试激活已配置的 Figma Desktop 服务；失败时只报告实际连接问题，不要根据链接臆造节点内容。
- 用户要求读取、解释或核对选区时，加载 `figma-selection-context` Skill，再获取目标节点的设计上下文；需要视觉基准时获取截图。
- 用户要求把设计实现为代码时，加载 `figma-design-to-code` Skill，再读取设计上下文并在当前代码库中完成实现。
- 用户要求建立或维护设计组件与代码组件映射时，加载 `figma-code-connect` Skill，再检查 Figma 组件和代码库中的真实组件。
- 用户只输入 `$figma` 而没有具体任务时，询问希望分析当前选区、实现设计还是处理 Code Connect，不要擅自修改文件。
- 始终以用户指定的 Figma 链接为优先；没有链接时才使用 Figma Desktop 当前选区。只处理用户授权的范围。
- 只调用当前工具列表中的真实名称。设计读取工具通常以 `get_design_context`、`get_screenshot`、`get_variable_defs` 或 `get_metadata` 结尾，具体 MCP 前缀以当前会话为准；不要猜测其他工具名或建议安装 Figma CLI。
