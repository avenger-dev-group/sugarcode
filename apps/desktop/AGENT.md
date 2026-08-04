# SugarCode UI 规范

本文件是 SugarCode 的强制 UI 设计规范。新增或修改界面时，必须优先复用项目主题 token。

## 技术栈与组件选择

- Renderer 使用 React、TypeScript、Tailwind CSS v4 和 shadcn。
- shadcn 是 SugarCode 的源码级基础组件方案，不是产品视觉规范。生成到仓库中的组件由 SugarCode 维护，必须适配本文件的 token、排版和交互规则。
- 默认采用 shadcn 官方组件。组件选择顺序固定为：
  1. 复用项目中已经存在的 SugarCode 组件；
  2. 添加或复用 shadcn 官方基础组件；
  3. 组合多个 shadcn 基础组件实现产品组件；
  4. 仅在前三项无法满足需求时实现自定义基础组件，并在变更中说明原因。
- 已有 shadcn 对应实现时，不得重复实现 Button、Input、Textarea、Select、Checkbox、Dialog、Dropdown、Popover、Tooltip、Tabs、ScrollArea 等通用基础组件。
- shadcn Blocks 和示例页面只能作为结构参考，不得直接决定 SugarCode 的信息架构、视觉语言或页面布局。
- 新增 shadcn 组件时必须审查生成的源码和依赖差异；不得在自动化流程中无审查地跟随浮动的 `latest` 输出。
- shadcn 基础组件和 SugarCode React 组件统一归属 `apps/desktop/src/renderer/components`。

## Renderer 目录边界

```text
src/renderer/
├── main.tsx
├── app.tsx
├── components/
│   ├── ui/          # shadcn 基础组件，不包含领域逻辑
│   ├── agent/       # Agent 消息、过程和工具活动
│   ├── thread/      # Thread、Turn 和历史记录
│   └── workspace/   # 文件、Diff、终端和预览
├── hooks/
├── pages/
├── services/
├── stores/
├── utils/
└── styles/
    └── globals.css
```

- 目录按当前切片逐步创建，不得为了匹配目标结构添加空占位文件。
- `components/ui` 只能包含无业务含义的基础组件和样式变体，不得访问 Store、App Server 或 Electron preload API。
- 领域组件不得直接依赖 App Server 原始 DTO。先在 Renderer 边界转换为稳定的 view-model，再交给组件渲染。
- `pages` 负责页面组合，不负责协议解析、进程管理或持久化。
- `services` 是受约束 preload API、协议客户端和 view-model 映射的 Renderer 边界；不得绕过 preload 使用 Node.js 或 Electron API。
- `stores` 保存可重建的界面状态和客户端投影，不得成为 Thread 持久化的唯一事实来源。
- `hooks` 封装可复用的 React 行为，不得隐藏不可见的跨进程副作用。
- 每个领域模块必须在自己的目录中提供 `types.ts`，集中定义该模块专属的 Props、view-model、状态和联合类型；跨模块公共协议类型仍应保留在其既定边界，不得复制进各模块。
- 每个含交互的领域模块必须提供自己的 `use-store.ts`，并统一导出名为 `useStore` 的 Hook，集中管理该模块的 `useState`、派生交互状态和事件处理器。展示组件只消费这个 Hook 返回的强类型接口，不得把模块交互逻辑重新散落到页面组件中。
- 被两个或更多模块复用的纯工具方法必须按职责定义在 `src/renderer/utils/` 下；只服务单个模块的方法必须留在该模块目录中，不得提前提升为全局工具。

## TypeScript 与命名

- 新增和修改的 TypeScript 必须保持强类型。React 状态必须为 `useState` 显式提供类型参数，尤其是空数组、空对象、可空值、联合类型和领域模型，例如 `useState<ThreadSummary[]>([])`、`useState<ThreadSummary | null>(null)`；不得依赖不完整推断或使用 `any` 绕过类型约束。
- React 组件、事件处理器和普通方法优先使用 ES6 箭头函数，例如 `const ThreadList = (props: ThreadListProps) => {}`；仅在提升、生成器、明确的 `this` 绑定或框架 API 等确有需要时使用 `function` 声明，并在上下文中保持一致。
- 新增源码文件和目录统一使用 kebab-case（烤串命名），例如 `thread-list.tsx`、`use-thread-state.ts`、`app-server-client.ts`。框架约定文件、工具生成且不宜改名的文件，以及单个单词的文件名除外。

## 颜色

中性文字只能使用以下语义色：

| 语义 | 浅色模式 | 深色模式 | Tailwind 类 |
|---|---|---|---|
| 主文字 / 主题色 | `#1A1C1F` | `#FFFFFF` | `text-primary` / `text-foreground` |
| 次级文字 | `primary` 70% | `primary` 70% | `text-secondary` |
| 对话过程、弱化正文 | `primary` 60% | `primary` 60% | `text-process` |
| 辅助文字 | `primary` 50% | `primary` 50% | `text-tertiary` / `text-muted-foreground` |
| 导航项目 / 普通任务 | `primary` 85% | `primary` 85% | `text-navigation` |
| 导航分组标题 | `primary` 35% | `primary` 50% | `text-navigation-heading` |
| 导航背景 | `#F9F9F9` | `#202020` | `bg-navigation-background` |
| 页面背景 | `#FFFFFF` | `#181818` | `bg-background` |

使用规则：

- 标题、正文、当前选中项使用主文字。
- 说明文字、分组标题、非当前导航项使用次级文字。
- Codex 风格的左侧任务导航使用专用语义色：分组标题使用
  `text-navigation-heading`；项目名和普通任务使用 `text-navigation` 与
  `400` 字重，当前任务使用主文字、`500` 字重并以 `bg-surface` 标示；
  整个区域使用 `bg-navigation-background`。
- Agent 思考过程、任务过程、弱化正文使用过程文字。
- 时间、数量、路径、占位符、图标和低优先级元数据使用辅助文字。
- 所有百分比语义变量必须通过相对 `rgb()` 从当前 `--primary` 动态计算，
  不得固定复制某个主题的 RGB 通道。
- 禁止使用 `text-foreground/60`、`text-white/50` 或硬编码 RGBA 绕过语义变量。
- `--primary` 是主文字和主题前景色的唯一源值；`--foreground` 只是兼容现有组件的别名，必须引用 `--primary`，不得另建 `--text-primary`。
- 状态色仅用于成功、警告、错误和正在执行等明确状态。
- 成功状态统一使用 `--success` / `text-success` / `bg-success`，不得在组件中硬编码绿色。
- 禁用态可以在正确语义色的基础上使用组件级 `disabled:opacity-*`。语法高亮、终端、遮罩和状态色可按各自功能使用专用颜色。

对应 CSS token：

```css
--primary
--secondary
--process
--tertiary
--navigation
--navigation-heading
--navigation-background
--background
--success
--user-message
--user-message-foreground
```

用户消息气泡固定使用 `--user-message: #C7D7FD`。气泡文字必须使用
`--user-message-foreground`，在浅色和深色主题下都保持深色对比文字；不得
直接继承深色主题的白色 `--primary`。

## 对话呈现

- 对话正文不显示内部 Item ID、Turn ID 或正常完成标签。
- Agent 正文不显示头像和名称。
- 已完成 Turn 的过程折叠标题显示从规范 UUIDv7 生命周期 ID 推导的总耗时；
  该历史耗时不得依赖 Renderer 停留时间，切换会话后必须保持稳定。
- 中断、停止、失败和状态不确定等需要用户理解或处理的状态必须继续显示。

## 排版

- UI 字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`。
- 普通正文：`14px / 1.5 / 500`，优先使用 `text-sm font-normal leading-normal`。
- 局部对话或输入区需要更松的行高时可使用 `22px`，不要随意增加其他行高。
- Agent Markdown 正文固定为 `14px / 22px / 400`，容器使用 `font-normal`；
  标题和加粗强调内容按语义提升到 `500`。
- 标题、按钮、强调标签：`500`，使用 `font-medium`。
- `font-semibold` 固定为 `600`，只用于确实需要更强层级的标题或状态。
- Markdown `**加粗**`：`500`，使用 `font-medium`。
- 代码正文：`12px / 400`，使用项目的 `font-mono`。代码标签和紧凑元数据可更小，但不得改变代码正文基线。
- Markdown 代码块对已知围栏语言提供浅色/深色语法高亮，包括 PHP、Go、
  Java、C#、C 和 C++，并提供可键盘操作、有成功或失败反馈的复制按钮；
  未知语言必须安全回退为纯文本。
- 除左侧任务导航的 Codex 特例外，导航项和普通列表项默认 `14px / 500`；
  不要靠普遍加粗制造层级，应优先使用语义色、背景和间距。
- 禁止使用不存在或含义不明确的字号类，例如 `text-md`。14px 使用 `text-sm`。

## 新 UI 检查清单

- 是否优先使用已有 SugarCode 组件或 shadcn 官方组件，而不是重复实现基础组件？
- `components/ui` 是否仍然不包含领域逻辑、Store 和协议访问？
- App Server DTO 是否先转换为 Renderer view-model，再进入组件？
- 领域模块是否具有自己的 `types.ts`，含交互的模块是否通过自己的 `use-store.ts` 管理交互逻辑？
- 工具方法是否按实际复用范围放在模块目录或 `utils/`，而不是形成无边界的公共杂物文件？
- `useState` 等状态写入是否具有明确、完整的类型？
- 新增组件和方法是否优先使用箭头函数，源码文件和目录是否遵循 kebab-case？
- 是否只使用了上述中性文字语义，而不是硬编码灰色或任意透明度？
- 浅色和深色下是否分别保持 `#1A1C1F` / 白色的正确层级？
- 正文是否为 `14px / 1.5 / 500`？
- 左侧任务导航的分组标题是否使用辅助文字，项目与任务是否使用主文字，
  当前任务是否通过 `500` 字重和 `bg-surface` 区分，区域背景是否使用
  `bg-navigation-background`？
- 说明文字是否使用次级色，元数据和占位符是否使用辅助色？
- Agent 过程内容是否使用过程色？
- Markdown 粗体和代码是否符合各自字重、字号规范？
- 是否覆盖 Loading、Empty、Error、Disabled 和取消状态？
- 是否可使用键盘完成操作，并具有清晰的 focus-visible 状态和正确的可访问名称？
- 是否在浅色和深色主题中检查了截断、对比度和布局溢出？
