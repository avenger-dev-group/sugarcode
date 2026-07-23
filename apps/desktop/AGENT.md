# SugarCode UI 规范

本文件是 SugarCode 的强制 UI 设计规范。新增或修改界面时，必须优先复用项目主题 token。

## 颜色

中性文字只能使用以下四档语义色：

| 语义 | 浅色模式 | 深色模式 | Tailwind 类 |
|---|---|---|---|
| 主文字 / 主题色 | `#1A1C1F` | `#FFFFFF` | `text-primary` / `text-foreground` |
| 次级文字 | `primary` 70% | `primary` 70% | `text-secondary` |
| 对话过程、弱化正文 | `primary` 60% | `primary` 60% | `text-process` |
| 辅助文字 | `primary` 50% | `primary` 50% | `text-tertiary` / `text-muted-foreground` |
| 页面背景 | `#FFFFFF` | `#181818` | `bg-background` |

使用规则：

- 标题、正文、当前选中项使用主文字。
- 说明文字、分组标题、非当前导航项使用次级文字。
- Agent 思考过程、任务过程、弱化正文使用过程文字。
- 时间、数量、路径、占位符、图标和低优先级元数据使用辅助文字。
- 70%/60%/50% 语义变量必须通过相对 `rgb()` 从当前 `--primary` 动态计算，不得固定复制某个主题的 RGB 通道。
- 禁止使用 `text-foreground/60`、`text-white/50` 或硬编码 RGBA 绕过语义变量。
- `--primary` 是主文字和主题前景色的唯一源值；`--foreground` 只是兼容现有组件的别名，必须引用 `--primary`，不得另建 `--text-primary`。
- 状态色仅用于成功、警告、错误和正在执行等明确状态。
- 禁用态可以在正确语义色的基础上使用组件级 `disabled:opacity-*`。语法高亮、终端、遮罩和状态色可按各自功能使用专用颜色。

对应 CSS token：

```css
--primary
--secondary
--process
--tertiary
--background
```

## 排版

- UI 字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`。
- 普通正文：`14px / 1.5 / 500`，优先使用 `text-sm font-normal leading-normal`。
- 局部对话或输入区需要更松的行高时可使用 `22px`，不要随意增加其他行高。
- 标题、按钮、强调标签：`500`，使用 `font-medium`。
- `font-semibold` 固定为 `600`，只用于确实需要更强层级的标题或状态。
- Markdown `**加粗**`：`700`，使用 `font-bold`。
- 代码正文：`12px / 400`，使用项目的 `font-mono`。代码标签和紧凑元数据可更小，但不得改变代码正文基线。
- 导航项和普通列表项默认 `14px / 500`；不要靠普遍加粗制造层级，应优先使用语义色、背景和间距。
- 禁止使用不存在或含义不明确的字号类，例如 `text-md`。14px 使用 `text-sm`。

## 新 UI 检查清单

- 是否只使用了上述四档中性文字语义，而不是硬编码灰色或任意透明度？
- 浅色和深色下是否分别保持 `#1A1C1F` / 白色的正确层级？
- 正文是否为 `14px / 1.5 / 500`？
- 普通导航项是否保持正常字重，当前项是否主要通过背景和主文字区分？
- 说明文字是否使用次级色，元数据和占位符是否使用辅助色？
- Agent 过程内容是否使用过程色？
- Markdown 粗体和代码是否符合各自字重、字号规范？
- 是否在浅色和深色主题中检查了截断、对比度和布局溢出？
