# 主进程 Runtime 模块

这里负责桌面 IPC、会话内存状态和运行进程连接；模型调用与工具执行位于 `src/runtime/`。

```text
runtime/
├── connection/       运行进程启动、事件分发、连接状态
├── conversation/
│   ├── controller.ts API 入口与服务组装，不放业务流程
│   ├── state.ts      单实例共享状态，不做 I/O
│   ├── services.ts   服务间调用接口，各服务只选取所需依赖
│   ├── events.ts     运行事件路由、Turn 生命周期、输出批处理
│   ├── attachments.ts 附件预览与归属校验
│   ├── navigation/   工作区切换、搜索、选中、重命名与删除
│   ├── turns/        启动、修订、停止、用户输入与纯状态转换
│   ├── queue/        消息变更、串行锁、队列推进与暂停
│   ├── goals/        Goal 操作、调度、重启协调与电源管理
│   └── projection/   投影构建、发布校验、监听隔离与终态恢复
├── approvals/        工具与 MCP 审批
├── configuration/    模型、MCP、命令环境配置
├── knowledge/        知识库操作
├── skills/           Skill 操作
└── workspace/        工作区和 Git 适配
```

## 依赖与变更约束

- `controller.ts` 是组合入口。业务服务不能反向引用它，也不能通过继承共享实现。
- 服务通过 `Pick<ConversationServices, ...>` 声明需要的操作；跨服务调用由入口注入。
- `state.ts` 保存跨模块共享的数据。队列锁、输出定时器、恢复中的请求分别由所属服务管理。
- `turns/reducer.ts` 只转换单个 Turn；协议事件、正文展示规则不因目录调整而变化。
- `projection/publisher.ts` 保留严格校验。非法投影不推进 revision，不让单个订阅异常中断分发。
- `projection/recovery.ts` 只恢复已结束且未被后续事件更新的 Turn，不覆盖实时流式内容。
- 会话模块单文件最多 1000 行，自动测试会检查行数和入口依赖方向。新增职责应进入对应服务。

## 验证

在 `apps/desktop` 执行 `pnpm typecheck`、`pnpm lint`、`pnpm test:node`。
会话行为回归位于 `tests/main/runtime/conversation-*.test.ts`，结构约束位于
`tests/main/runtime/conversation-architecture.test.ts`。
